"""service 단위 테스트가 공유하는 가짜 객체와 도우미 (대체 경계)."""

import asyncio
import hashlib
import json
import sqlite3
import threading
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date
from typing import Any, cast

import httpx
import pytest
from structlog.testing import capture_logs

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import (
    Chunk,
    ChunkingResult,
    ChunkKind,
    ChunkRecord,
    Edition,
    Settings,
    SparseVector,
)
from minerva_rag.evaluation import EvaluationCase, EvaluationMetrics, EvaluationResult
from minerva_rag.indexing import EmbeddedChunks, Indexer, IndexInput
from minerva_rag.resource import ChunkStore, LlmRole, ModelHub
from minerva_rag.search import DocumentChunks, Searcher, SearchHit, SearchQuery
from minerva_rag.service import IndexRequest, IndexStateView, JobStage, JobView
from minerva_rag.service import lifecycle_service as lifecycle_module
from minerva_rag.service.jobs import (
    CurrentIndex,
    IndexOutcome,
    IndexRunner,
    JobManager,
    ProgressReporter,
    RecoverFn,
)
from minerva_rag.service.lifecycle_service import LifecycleService, Services, build_services

from ..evaluation.fakes import hit, searchable_doc
from ..resource.fakes import events_named, run

Timeline = list[tuple[Any, ...]]

# 비동기 테스트가 걸려 끝나지 않는 일이 없게 하는 상한(초)이다
TEST_LIMIT = 30.0
WAIT_LIMIT = 5.0


# ── 실행·대기 도우미 ───────────────────────────────────────────────


def go[T](coro: Coroutine[Any, Any, T], limit: float = TEST_LIMIT) -> T:
    """코루틴을 새 이벤트 루프에서 상한 시간 안에 실행한다. 걸리면 TimeoutError다."""

    async def _bounded() -> T:
        return await asyncio.wait_for(coro, limit)

    return run(_bounded())


async def settle(rounds: int = 50) -> None:
    """이벤트 루프를 여러 번 양보해 대기 중인 작업이 갈 수 있는 데까지 가게 한다."""
    for _ in range(rounds):
        await asyncio.sleep(0)


async def until(condition: Callable[[], bool], limit: float = WAIT_LIMIT) -> None:
    """조건이 참이 될 때까지 양보하며 기다린다. 상한을 넘으면 TimeoutError다."""

    async def _poll() -> None:
        while not condition():
            await asyncio.sleep(0)

    await asyncio.wait_for(_poll(), limit)


async def wait_event(event: asyncio.Event, limit: float = WAIT_LIMIT) -> None:
    """이벤트가 세워질 때까지 상한 시간 안에서 기다린다."""
    await asyncio.wait_for(event.wait(), limit)


# ── 로그 검사 ─────────────────────────────────────────────────────

# 구조화 로그의 스택 표지는 내용 필드가 아니다
_META_KEYS = {"event", "log_level", "exc_info"}


def assert_service_log(
    logs: list[Any], event: str, level: str, allowed: set[str], *, stack: bool = False
) -> list[dict[str, Any]]:
    """이벤트가 있고 레벨이 맞고 필드가 허용 안에 있는지 확인하고 찾은 항목을 돌려준다."""
    found = events_named(logs, event)
    assert found, f"{event} 로그가 없다"
    for entry in found:
        assert entry["log_level"] == level, f"{event}의 레벨이 {entry['log_level']}이다"
        assert set(entry) - _META_KEYS <= allowed, f"{event}에 허용 밖 필드가 있다"
        if stack:
            assert "exc_info" in entry, f"{event}에 스택이 없다"
    return found


def run_logged[T](coro: Coroutine[Any, Any, T]) -> tuple[T, list[dict[str, Any]]]:
    """코루틴을 실행하며 구조화 로그를 모아 결과와 함께 돌려준다."""
    with capture_logs() as logs:
        result = go(coro)
    return result, [dict(entry) for entry in logs]


# ── Backend 수신자 ────────────────────────────────────────────────


@dataclass(frozen=True)
class Received:
    """가짜 수신자가 받은 요청 하나다."""

    method: str
    url: str
    headers: dict[str, str]  # 헤더 이름은 소문자다
    body: dict[str, Any]
    attempt: int  # 같은 알림(문서, 순번)의 몇 번째 시도인지, 1부터


class FakeReceiver:
    """Backend의 알림 수신 API를 흉내 내고 받은 요청을 기록한다."""

    def __init__(self) -> None:
        # 고정 상태, 또는 (본문, 그 본문의 몇 번째 시도인지 1부터) → 상태
        self.status: int | Callable[[dict[str, Any], int], int] = 204
        # 참이면 연결 오류를 낸다
        self.raise_on: Callable[[dict[str, Any], int], bool] | None = None
        # 참인 요청은 gate가 열릴 때까지 응답하지 않는다
        self.hold: Callable[[dict[str, Any]], bool] | None = None
        self.gate = asyncio.Event()
        # 응답 전에 부르는 훅(알림 직후 조회 검증용)
        self.on_receive: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self.requests: list[Received] = []
        self._attempts: dict[tuple[str, int], int] = {}

    async def handler(self, request: httpx.Request) -> httpx.Response:
        """요청 하나를 기록하고 정해 둔 대로 응답한다."""
        body = cast(dict[str, Any], json.loads(request.content))
        key = (str(body["doc_id"]), int(body["sequence"]))
        attempt = self._attempts.get(key, 0) + 1
        self._attempts[key] = attempt
        # ★ 받는 즉시(보류하기 전에) 기록한다
        self.requests.append(
            Received(
                method=request.method,
                url=str(request.url),
                headers={k.lower(): v for k, v in request.headers.items()},
                body=body,
                attempt=attempt,
            )
        )
        if self.on_receive is not None:
            await self.on_receive(body)
        if self.raise_on is not None and self.raise_on(body, attempt):
            raise httpx.ConnectError("refused", request=request)
        if self.hold is not None and self.hold(body):
            await self.gate.wait()
        status = self.status(body, attempt) if callable(self.status) else self.status
        return httpx.Response(status)

    async def wait_for(
        self, count: int, predicate: Callable[[Received], bool] | None = None
    ) -> None:
        """조건을 만족하는 요청이 count개 이상 될 때까지 기다린다."""

        def _enough() -> bool:
            return len(self.select(predicate)) >= count

        await until(_enough)

    def select(self, predicate: Callable[[Received], bool] | None = None) -> list[Received]:
        """조건을 만족하는 요청을 받은 순서대로 돌려준다."""
        return [r for r in self.requests if predicate is None or predicate(r)]

    def bodies(
        self, *, doc_id: str | None = None, job_id: str | None = None
    ) -> list[dict[str, Any]]:
        """재전송을 포함한 모든 요청 본문을 받은 순서대로 돌려준다."""
        return [
            r.body
            for r in self.requests
            if (doc_id is None or r.body["doc_id"] == doc_id)
            and (job_id is None or r.body["job_id"] == job_id)
        ]

    def firsts(
        self, *, doc_id: str | None = None, job_id: str | None = None
    ) -> list[dict[str, Any]]:
        """알림마다 첫 시도의 본문만 받은 순서대로 돌려준다."""
        return [
            r.body
            for r in self.requests
            if r.attempt == 1
            and (doc_id is None or r.body["doc_id"] == doc_id)
            and (job_id is None or r.body["job_id"] == job_id)
        ]

    def states(self, job_id: str) -> list[str]:
        """그 작업의 알림 `job_state`를 첫 시도만 받은 순서대로 돌려준다."""
        return [b["job_state"] for b in self.firsts(job_id=job_id)]

    def sequences(self, doc_id: str) -> list[int]:
        """그 문서의 알림 순번을 첫 시도만 받은 순서대로 돌려준다."""
        return [b["sequence"] for b in self.firsts(doc_id=doc_id)]


async def notified(receiver: FakeReceiver, job_id: str, state: str) -> None:
    """그 작업의 그 상태 알림이 도착할 때까지 기다린다."""
    await receiver.wait_for(
        1, lambda r: r.body["job_id"] == job_id and r.body["job_state"] == state
    )


# 대기 도우미가 쓰는 진짜 양보 함수다. 기록 가짜로 바뀌기 전의 `asyncio.sleep`을 잡아 둔다
_REAL_SLEEP = asyncio.sleep


class SleepRecorder:
    """`asyncio.sleep`을 대신해 실제로 기다리지 않고 받은 초만 기록한다."""

    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, seconds: float, result: Any = None) -> Any:
        """0보다 큰 초는 기록하고, 어느 쪽이든 실제로는 한 번 양보만 한다."""
        if seconds > 0:
            self.delays.append(seconds)
        await _REAL_SLEEP(0)
        return result

    @property
    def backoff(self) -> list[float]:
        """재전송 대기로 볼 수 있는 1초 이상의 대기만 받은 순서대로 돌려준다."""
        return [seconds for seconds in self.delays if seconds >= 1]


# ── 러너와 진행 알림 ──────────────────────────────────────────────


class _Wait:
    """러너가 풀어 줄 때까지 멈추는 지점의 표지다."""


WAIT = _Wait()


class ScriptedRunner:
    """정해 둔 단계를 차례로 알리고 결과를 돌려주거나 예외를 내는 가짜 IndexRunner다."""

    def __init__(
        self,
        *steps: JobStage | IndexOutcome | _Wait,
        result: IndexOutcome | BaseException | None = None,
        name: str = "",
        trace: list[str] | None = None,
    ) -> None:
        self.steps = steps
        self.result = result if result is not None else IndexOutcome(1, False)
        self.name = name
        self.trace = trace
        self.calls = 0
        self.reporter: ProgressReporter | None = None
        self.started = asyncio.Event()
        self.waiting = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, reporter: ProgressReporter) -> IndexOutcome:
        """단계를 차례로 실행한다. WAIT에서는 release가 세워질 때까지 멈춘다."""
        self.calls += 1
        self.reporter = reporter
        if self.trace is not None:
            self.trace.append(self.name)
        self.started.set()
        for step in self.steps:
            if isinstance(step, JobStage):
                reporter.stage(step)
            elif isinstance(step, IndexOutcome):
                await reporter.prepared(step)
            else:
                self.waiting.set()
                await self.release.wait()
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class FakeReporter:
    """ProgressReporter 가짜다. 단계와 prepared를 timeline에 기록한다."""

    def __init__(self, job_id: str = "job-x", timeline: Timeline | None = None) -> None:
        self._job_id = job_id
        self.timeline: Timeline = timeline if timeline is not None else []
        self.prepared_outcomes: list[IndexOutcome] = []

    @property
    def job_id(self) -> str:
        """실행 중인 작업의 ID다."""
        return self._job_id

    def stage(self, stage: JobStage) -> None:
        """단계 알림을 기록한다."""
        self.timeline.append(("stage", stage))

    async def prepared(self, outcome: IndexOutcome) -> None:
        """미리 정한 결과를 기록한다."""
        self.timeline.append(("prepared", outcome))
        self.prepared_outcomes.append(outcome)


# ── 작업 관리 도우미 ──────────────────────────────────────────────


async def no_recover(doc_id: str, job_id: str) -> bool:
    """복구할 것이 없다고 답한다(결과가 검색에 쓰이지 않음)."""
    return False


class RecoverSpy:
    """RecoverFn 가짜다. 부른 인자를 기록하고 정해 둔 값을 돌려주거나 예외를 낸다."""

    def __init__(self, result: bool | BaseException) -> None:
        self.result = result
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, doc_id: str, job_id: str) -> bool:
        """호출을 기록한다."""
        self.calls.append((doc_id, job_id))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


async def new_manager(settings: Settings, recover: RecoverFn = no_recover) -> JobManager:
    """작업 관리자를 만들어 start까지 한다."""
    manager = JobManager(settings)
    await manager.start(recover)
    return manager


@asynccontextmanager
async def running_manager(
    settings: Settings, recover: RecoverFn = no_recover
) -> AsyncIterator[JobManager]:
    """start한 작업 관리자를 주고 끝나면 stop(0)으로 백그라운드 작업을 정리한다."""
    manager = await new_manager(settings, recover)
    try:
        yield manager
    finally:
        await manager.stop(0)


async def wait_state(manager: JobManager, job_id: str, state: Any) -> None:
    """작업이 그 상태가 될 때까지 폴링한다."""

    async def _poll() -> None:
        while (await manager.get_job(job_id)).state is not state:
            await asyncio.sleep(0)

    await asyncio.wait_for(_poll(), WAIT_LIMIT)


async def submit(
    manager: JobManager,
    doc_id: str,
    runner: IndexRunner,
    *,
    version: str = "v1",
    checksum: str | None = None,
) -> str:
    """작업을 접수하고 ID를 돌려준다. 체크섬 기본값은 문서·버전에서 정한다."""
    return await manager.submit(doc_id, version, checksum or f"sum-{doc_id}-{version}", runner)


class SpyJobManager(JobManager):
    """진짜 JobManager를 부르며 호출을 timeline에 기록하는 스파이다."""

    def __init__(self, settings: Settings, timeline: Timeline | None = None) -> None:
        super().__init__(settings)
        self.timeline: Timeline = timeline if timeline is not None else []
        self.entered_wait = asyncio.Event()

    async def start(self, recover: RecoverFn) -> None:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.start",))
        await super().start(recover)

    async def stop(self, timeout_seconds: float) -> None:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.stop", timeout_seconds))
        await super().stop(timeout_seconds)

    async def submit(self, doc_id: str, version: str, checksum: str, run: IndexRunner) -> str:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.submit", doc_id, version, checksum))
        return await super().submit(doc_id, version, checksum, run)

    async def find_open(self, doc_id: str, checksum: str) -> str | None:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.find_open", doc_id, checksum))
        return await super().find_open(doc_id, checksum)

    async def fail_queued(self, doc_id: str, code: str, message: str) -> None:
        """기록하고 부모를 부른다."""
        self.timeline.append(("fail_queued", doc_id, code, message))
        await super().fail_queued(doc_id, code, message)

    async def wait_running(self, doc_id: str) -> None:
        """기록하고 들어갔다는 이벤트를 세운 뒤 부모를 부른다."""
        self.timeline.append(("wait_running", doc_id))
        self.entered_wait.set()
        await super().wait_running(doc_id)

    async def get_job(self, job_id: str) -> JobView:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.get_job", job_id))
        return await super().get_job(job_id)

    async def index_state(self, doc_id: str) -> IndexStateView:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.index_state", doc_id))
        return await super().index_state(doc_id)

    async def index_states(self, doc_ids: Sequence[str]) -> list[IndexStateView]:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.index_states", tuple(doc_ids)))
        return await super().index_states(doc_ids)

    async def current_index(self, doc_id: str) -> CurrentIndex | None:
        """기록하고 부모를 부른다."""
        self.timeline.append(("jobs.current_index", doc_id))
        return await super().current_index(doc_id)

    async def forget_document(self, doc_id: str) -> None:
        """기록하고 부모를 부른다."""
        self.timeline.append(("forget_document", doc_id))
        await super().forget_document(doc_id)


async def started_spy(settings: Settings, timeline: Timeline) -> SpyJobManager:
    """스파이 관리자를 만들어 start하고 시작 기록은 timeline에서 지운다."""
    spy = SpyJobManager(settings, timeline)
    await spy.start(no_recover)
    timeline.clear()
    return spy


_WRITE_WORDS = ("INSERT", "UPDATE", "DELETE", "REPLACE")


def _is_write(sql: str) -> bool:
    """쓰기 문(INSERT·UPDATE·DELETE·REPLACE)이면 참이다."""
    words = sql.split()
    return bool(words) and words[0].upper() in _WRITE_WORDS


@dataclass
class Pause:
    """쓰기 트랜잭션을 작업 스레드에서 멈춰 두는 지점이다. `entered`가 서면 멈춰 있는 것이다."""

    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)


@dataclass
class _TxState:
    """연결 하나의 현재 쓰기 트랜잭션이 실패 대상인지 담는다. 커밋·롤백에서 비운다."""

    failing: bool | None = None


class WriteFailure:
    """쓰기 문 실패 주입과 쓰기 멈춤의 스위치다.

    두 가지 방식이 있다. `arm`은 쓰기 문 단위, `arm_transactions`는 쓰기 트랜잭션 단위다
    (트랜잭션은 연결의 첫 쓰기 문에서 시작해 커밋·롤백에서 끝난다).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._passes: int | None = None
        self._tx_armed = False
        self._tx_skip = 0
        self._tx_limit: int | None = None
        self._tx_seen = 0
        self._tx_failed = 0
        self._pause: Pause | None = None
        self._pause_skip = 0
        self.failures = 0  # 실패시킨 쓰기 문 수

    def arm(self, passes: int = 1) -> None:
        """이 시점부터 `passes`개의 쓰기 문은 통과시키고 그다음부터 실패시킨다."""
        with self._lock:
            self._passes = passes

    def arm_transactions(self, skip: int = 0, limit: int | None = None) -> None:
        """이 시점부터 쓰기 트랜잭션 `skip`개는 통과시키고, 그다음 `limit`개를 실패시킨다.

        `limit`이 None이면 끄기 전까지 계속 실패시킨다. 실패하는 트랜잭션은 첫 쓰기 문에서 실패한다.
        """
        with self._lock:
            self._tx_armed = True
            self._tx_skip = skip
            self._tx_limit = limit
            self._tx_seen = 0
            self._tx_failed = 0

    def disarm(self) -> None:
        """실패 주입을 모두 끈다."""
        with self._lock:
            self._passes = None
            self._tx_armed = False

    def pause_transaction(self, skip: int = 0) -> Pause:
        """이 시점부터 `skip`개의 쓰기 트랜잭션을 지나 그다음 하나를 첫 쓰기 문에서 멈춘다.

        ★ 멈추는 곳은 작업 스레드다. 이벤트 루프는 계속 돈다. 5초 안에 풀지 않으면 저절로 푼다.
        """
        pause = Pause()
        with self._lock:
            self._pause = pause
            self._pause_skip = skip
        return pause

    def begin_transaction(self) -> bool:
        """연결이 첫 쓰기 문을 낼 때 부른다. 이 트랜잭션을 실패시킬 차례면 참이다."""
        with self._lock:
            hold: Pause | None = None
            if self._pause is not None:
                if self._pause_skip > 0:
                    self._pause_skip -= 1
                else:
                    hold, self._pause = self._pause, None
            fail = False
            if self._tx_armed:
                self._tx_seen += 1
                if self._tx_seen > self._tx_skip and (
                    self._tx_limit is None or self._tx_failed < self._tx_limit
                ):
                    self._tx_failed += 1
                    fail = True
        if hold is not None:
            hold.entered.set()
            hold.release.wait(5.0)  # 상한이 있는 대기다
        return fail

    def count_failure(self) -> None:
        """실패시킨 쓰기 문을 센다."""
        with self._lock:
            self.failures += 1

    def check(self, sql: str) -> None:
        """쓰기 문이고 문 단위로 실패시킬 차례면 SQLite 오류를 낸다."""
        if not _is_write(sql):
            return
        with self._lock:
            if self._passes is None:
                return
            if self._passes > 0:
                self._passes -= 1
                return
            self.failures += 1
        raise sqlite3.OperationalError("injected")

    def guard(self, sql: str, tx: _TxState) -> None:
        """쓰기 문을 실행하기 전에 부른다. 트랜잭션 단위 주입·멈춤을 거친 뒤 문 단위 주입을 본다."""
        if not _is_write(sql):
            return
        if tx.failing is None:
            tx.failing = self.begin_transaction()
        if tx.failing:
            self.count_failure()
            raise sqlite3.OperationalError("injected")
        self.check(sql)


class _FailingCursor:
    """진짜 커서를 감싼다. 쓰기 문이 실패 주입에 걸리는지 먼저 본다."""

    def __init__(self, inner: sqlite3.Cursor, failure: WriteFailure, tx: _TxState) -> None:
        self._inner = inner
        self._failure = failure
        self._tx = tx

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def __iter__(self) -> Any:
        return iter(self._inner)

    def execute(self, sql: str, *args: Any) -> Any:
        """쓰기 문이면 실패 주입을 거친 뒤 진짜 커서로 실행한다."""
        self._failure.guard(sql, self._tx)
        self._inner.execute(sql, *args)
        return self

    def executemany(self, sql: str, *args: Any) -> Any:
        """쓰기 문이면 실패 주입을 거친 뒤 진짜 커서로 실행한다."""
        self._failure.guard(sql, self._tx)
        self._inner.executemany(sql, *args)
        return self


class _FailingConnection:
    """진짜 연결을 감싼다. 컨텍스트 관리자·row_factory 같은 나머지는 진짜 연결에 맡긴다."""

    def __init__(self, inner: sqlite3.Connection, failure: WriteFailure) -> None:
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_failure", failure)
        object.__setattr__(self, "_tx", _TxState())

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_inner"), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_inner"), name, value)

    def _end_transaction(self) -> None:
        object.__getattribute__(self, "_tx").failing = None

    def __enter__(self) -> "_FailingConnection":
        object.__getattribute__(self, "_inner").__enter__()
        return self

    def __exit__(self, *exc: Any) -> Any:
        self._end_transaction()
        return object.__getattribute__(self, "_inner").__exit__(*exc)

    def commit(self) -> None:
        """트랜잭션 경계를 비운 뒤 진짜 연결에서 커밋한다."""
        self._end_transaction()
        object.__getattribute__(self, "_inner").commit()

    def rollback(self) -> None:
        """트랜잭션 경계를 비운 뒤 진짜 연결에서 롤백한다."""
        self._end_transaction()
        object.__getattribute__(self, "_inner").rollback()

    def execute(self, sql: str, *args: Any) -> Any:
        """쓰기 문이면 실패 주입을 거친 뒤 진짜 연결로 실행한다."""
        failure: WriteFailure = object.__getattribute__(self, "_failure")
        failure.guard(sql, object.__getattribute__(self, "_tx"))
        return object.__getattribute__(self, "_inner").execute(sql, *args)

    def executemany(self, sql: str, *args: Any) -> Any:
        """쓰기 문이면 실패 주입을 거친 뒤 진짜 연결로 실행한다."""
        failure: WriteFailure = object.__getattribute__(self, "_failure")
        failure.guard(sql, object.__getattribute__(self, "_tx"))
        return object.__getattribute__(self, "_inner").executemany(sql, *args)

    def executescript(self, script: str) -> Any:
        """스크립트 안에 쓰기 문이 있으면 실패 주입을 거친 뒤 실행한다."""
        failure: WriteFailure = object.__getattribute__(self, "_failure")
        for statement in script.split(";"):
            failure.guard(statement, object.__getattribute__(self, "_tx"))
        return object.__getattribute__(self, "_inner").executescript(script)

    def cursor(self, *args: Any, **kwargs: Any) -> _FailingCursor:
        """쓰기 문 실패 주입이 걸린 커서를 돌려준다."""
        inner = object.__getattribute__(self, "_inner")
        return _FailingCursor(
            inner.cursor(*args, **kwargs),
            object.__getattribute__(self, "_failure"),
            object.__getattribute__(self, "_tx"),
        )


def install_write_failure(monkeypatch: pytest.MonkeyPatch) -> WriteFailure:
    """`sqlite3.connect`(공개 API)를 가로채 쓰기 문 실패를 주입할 수 있게 한다.

    ★ 작업 관리자를 만들기 전에 불러야 한다 — 이미 열린 연결은 감싸지 못한다.
    """
    failure = WriteFailure()
    real_connect = sqlite3.connect

    def _connect(*args: Any, **kwargs: Any) -> Any:
        return _FailingConnection(real_connect(*args, **kwargs), failure)

    monkeypatch.setattr(sqlite3, "connect", _connect)
    return failure


# ── 기능 단위·resource 가짜 ───────────────────────────────────────


def make_chunk(index: int) -> Chunk:
    """본문 청크 하나를 만든다."""
    return Chunk(
        chunk_key=f"k{index}",
        kind=ChunkKind.TEXT,
        order=index,
        heading_path=("제목",),
        title=None,
        summary=None,
        text=f"본문{index}",
        placeholder_ids=(),
        split_group=None,
        split_index=None,
        split_total=None,
    )


class FakeChunker:
    """Chunker 가짜다. split 호출을 기록한다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.result = ChunkingResult(
            chunks=tuple(make_chunk(i) for i in range(3)), fallback_used=True
        )
        self.error: BaseException | None = None
        self.block: asyncio.Event | None = None  # 있으면 그 이벤트가 세워질 때까지 멈춘다
        self.started = asyncio.Event()

    async def split(self, markdown: str, mode: ChunkingMode) -> ChunkingResult:
        """호출을 기록하고 결과를 돌려주거나 오류를 낸다."""
        self.timeline.append(("split", markdown, mode))
        self.started.set()
        if self.block is not None:
            await self.block.wait()
        if self.error is not None:
            raise self.error
        return self.result


class FakeIndexer:
    """Indexer 가짜다. 호출을 기록한다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.embed_error: BaseException | None = None
        self.write_error: BaseException | None = None
        self.recover_result: bool | BaseException = False
        self.embedded: list[EmbeddedChunks] = []

    def checksum(self, markdown: str, assets: Mapping[str, str], chunking_mode: str) -> str:
        """마크다운과 청킹 방식이 같으면 같은 체크섬을 돌려준다."""
        digest = hashlib.sha256((markdown + chunking_mode).encode("utf-8")).hexdigest()
        return "sum-" + digest[:16]

    async def embed(self, inp: IndexInput, result: ChunkingResult) -> EmbeddedChunks:
        """호출을 기록하고 청크마다 레코드를 만든다."""
        self.timeline.append(("embed", inp))
        if self.embed_error is not None:
            raise self.embed_error
        records = tuple(
            ChunkRecord(
                chunk_id=f"{inp.job_id}-{chunk.chunk_key}",
                doc_id=inp.doc_id,
                version=inp.version,
                job_id=inp.job_id,
                active=False,
                name=inp.name,
                edition=inp.edition,
                is_latest_edition=False,
                chunk=chunk,
            )
            for chunk in result.chunks
        )
        embedded = EmbeddedChunks(
            doc_id=inp.doc_id,
            version=inp.version,
            name=inp.name,
            records=records,
            dense=tuple((0.0,) for _ in records),
            sparse=tuple(SparseVector((), ()) for _ in records),
        )
        self.embedded.append(embedded)
        return embedded

    async def write(self, embedded: EmbeddedChunks) -> int:
        """호출을 기록하고 레코드 수를 돌려주거나 오류를 낸다."""
        self.timeline.append(("write", embedded))
        if self.write_error is not None:
            raise self.write_error
        return len(embedded.records)

    async def delete_document(self, doc_id: str) -> None:
        """호출을 기록한다."""
        self.timeline.append(("delete_document", doc_id))

    async def update_metadata(self, doc_id: str, name: str, edition: Edition | None) -> None:
        """호출을 기록한다."""
        self.timeline.append(("update_metadata", doc_id, name, edition))

    async def recover(self, doc_id: str, job_id: str) -> bool:
        """호출을 기록하고 정해 둔 값을 돌려준다."""
        self.timeline.append(("recover", doc_id, job_id))
        if isinstance(self.recover_result, BaseException):
            raise self.recover_result
        return self.recover_result

    @property
    def recovered(self) -> list[tuple[str, str]]:
        """recover가 받은 (doc_id, job_id)를 부른 순서대로 돌려준다."""
        return [(e[1], e[2]) for e in self.timeline if e[0] == "recover"]


class FakeSearcher:
    """Searcher 가짜다. 호출을 기록한다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.hits: tuple[SearchHit, ...] = (hit(1, "본문"),)
        self.doc: DocumentChunks = searchable_doc()
        self.error: BaseException | None = None
        self.glossary_error: BaseException | None = None

    def load_glossary(self) -> None:
        """호출을 기록한다. 오류가 정해져 있으면 낸다."""
        self.timeline.append(("load_glossary",))
        if self.glossary_error is not None:
            raise self.glossary_error

    async def search(self, q: SearchQuery) -> tuple[SearchHit, ...]:
        """호출을 기록하고 정해 둔 결과를 돌려준다."""
        self.timeline.append(("search", q))
        if self.error is not None:
            raise self.error
        return self.hits

    async def document_chunks(self, doc_id: str) -> DocumentChunks:
        """호출을 기록하고 정해 둔 문서를 돌려준다."""
        self.timeline.append(("document_chunks", doc_id))
        if self.error is not None:
            raise self.error
        return self.doc


def default_metrics() -> EvaluationMetrics:
    """모두 맞힌 지표를 만든다."""
    return EvaluationMetrics(
        hit_at_1=True,
        hit_at_3=True,
        hit_at_5=True,
        hit_at_n=True,
        rank=1,
        reciprocal_rank=1.0,
        coverage=1.0,
    )


class FakeEvaluator:
    """Evaluator 가짜다. 호출을 기록한다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.result = EvaluationResult(n=1, base=default_metrics(), expanded=default_metrics())
        self.error: BaseException | None = None

    async def evaluate(self, case: EvaluationCase) -> EvaluationResult:
        """호출을 기록하고 정해 둔 결과를 돌려준다."""
        self.timeline.append(("evaluate", case))
        if self.error is not None:
            raise self.error
        return self.result


class FakeHub:
    """ModelHub 가짜다. 호출을 기록한다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.prepare_error: BaseException | None = None
        self.ollama = True
        self.reply = "생성된 문장"
        self.generate_error: BaseException | None = None
        self.embedding_model_name = "fake-embedding"
        self._prepared = False

    async def prepare(self) -> None:
        """호출을 기록한다. 성공하면 차원을 읽을 수 있게 된다."""
        self.timeline.append(("prepare",))
        if self.prepare_error is not None:
            raise self.prepare_error
        self._prepared = True

    @property
    def embedding_dimension(self) -> int:
        """prepare 전에는 RuntimeError다."""
        if not self._prepared:
            raise RuntimeError("prepare 전에 차원을 읽었습니다")
        return 8

    async def close(self) -> None:
        """호출을 기록한다."""
        self.timeline.append(("hub.close",))

    async def ollama_available(self) -> bool:
        """호출을 기록하고 정해 둔 값을 돌려준다."""
        self.timeline.append(("ollama_available",))
        return self.ollama

    async def generate(
        self,
        role: LlmRole,
        prompt: str,
        *,
        image: bytes | None = None,
        json_schema: Mapping[str, Any] | None = None,
    ) -> str:
        """호출을 기록하고 정해 둔 응답을 돌려주거나 오류를 낸다."""
        self.timeline.append(("generate", role, prompt, image))
        if self.generate_error is not None:
            raise self.generate_error
        return self.reply


class FakeStore:
    """ChunkStore 가짜다. 호출을 기록한다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.connect_error: BaseException | None = None
        self.qdrant = True

    async def connect(self, dense_dimension: int) -> None:
        """호출을 기록한다. 오류가 정해져 있으면 낸다."""
        self.timeline.append(("connect", dense_dimension))
        if self.connect_error is not None:
            raise self.connect_error

    async def close(self) -> None:
        """호출을 기록한다."""
        self.timeline.append(("store.close",))

    async def ping(self) -> bool:
        """호출을 기록하고 정해 둔 값을 돌려준다."""
        self.timeline.append(("ping",))
        return self.qdrant


class FakeJobQueue:
    """JobQueue 가짜다. 호출을 기록하고 받은 러너를 모아 둔다."""

    def __init__(self, timeline: Timeline | None = None) -> None:
        self.timeline: Timeline = timeline if timeline is not None else []
        self.start_error: BaseException | None = None
        self.start_block: asyncio.Event | None = None
        self.open_job_id: str | None = None
        self.current: CurrentIndex | None = None
        self.runners: list[IndexRunner] = []

    async def start(self, recover: RecoverFn) -> None:
        """호출을 기록한다. 막아 두었으면 풀릴 때까지 기다린다."""
        self.timeline.append(("queue.start", recover))
        if self.start_block is not None:
            await self.start_block.wait()
        if self.start_error is not None:
            raise self.start_error

    async def stop(self, timeout_seconds: float) -> None:
        """호출을 기록한다."""
        self.timeline.append(("queue.stop", timeout_seconds))

    async def submit(self, doc_id: str, version: str, checksum: str, run: IndexRunner) -> str:
        """호출을 기록하고 러너를 모아 둔다."""
        self.timeline.append(("queue.submit", doc_id, version, checksum))
        self.runners.append(run)
        return f"job-{len(self.runners)}"

    async def find_open(self, doc_id: str, checksum: str) -> str | None:
        """호출을 기록하고 정해 둔 열린 작업을 돌려준다."""
        self.timeline.append(("queue.find_open", doc_id, checksum))
        return self.open_job_id

    async def current_index(self, doc_id: str) -> CurrentIndex | None:
        """호출을 기록하고 정해 둔 현재 색인을 돌려준다."""
        self.timeline.append(("queue.current_index", doc_id))
        return self.current

    async def fail_queued(self, doc_id: str, code: str, message: str) -> None:
        """호출을 기록한다."""
        self.timeline.append(("queue.fail_queued", doc_id, code, message))

    async def wait_running(self, doc_id: str) -> None:
        """호출을 기록한다."""
        self.timeline.append(("queue.wait_running", doc_id))


class ReadyStub:
    """준비 상태를 정해 둔 값으로 알려 준다."""

    def __init__(self, ready: bool) -> None:
        self.ready = ready


# ── 조립 도우미 ───────────────────────────────────────────────────


@dataclass
class LifecycleFakes:
    """가짜 단위로 만든 LifecycleService와 그 가짜들이다."""

    service: LifecycleService
    timeline: Timeline
    hub: FakeHub
    store: FakeStore
    searcher: FakeSearcher
    indexer: FakeIndexer
    queue: FakeJobQueue


def build_lifecycle(settings: Settings) -> LifecycleFakes:
    """가짜 단위 다섯 개를 같은 timeline에 기록하는 LifecycleService를 만든다."""
    timeline: Timeline = []
    hub = FakeHub(timeline)
    store = FakeStore(timeline)
    searcher = FakeSearcher(timeline)
    indexer = FakeIndexer(timeline)
    queue = FakeJobQueue(timeline)
    service = LifecycleService(
        cast(ModelHub, hub),
        cast(ChunkStore, store),
        cast(Searcher, searcher),
        cast(Indexer, indexer),
        queue,
        settings,
    )
    return LifecycleFakes(service, timeline, hub, store, searcher, indexer, queue)


@dataclass
class Parts:
    """wire가 만든 가짜 인스턴스들이다."""

    timeline: Timeline
    hubs: list[FakeHub] = field(default_factory=list[FakeHub])
    stores: list[FakeStore] = field(default_factory=list[FakeStore])
    chunkers: list[FakeChunker] = field(default_factory=list[FakeChunker])
    indexers: list[FakeIndexer] = field(default_factory=list[FakeIndexer])
    searchers: list[FakeSearcher] = field(default_factory=list[FakeSearcher])
    evaluators: list[FakeEvaluator] = field(default_factory=list[FakeEvaluator])
    managers: list[JobManager] = field(default_factory=list[JobManager])

    @property
    def hub(self) -> FakeHub:
        """만든 첫 ModelHub 가짜다."""
        return self.hubs[0]

    @property
    def store(self) -> FakeStore:
        """만든 첫 ChunkStore 가짜다."""
        return self.stores[0]

    @property
    def chunker(self) -> FakeChunker:
        """만든 첫 Chunker 가짜다."""
        return self.chunkers[0]

    @property
    def indexer(self) -> FakeIndexer:
        """만든 첫 Indexer 가짜다."""
        return self.indexers[0]

    @property
    def searcher(self) -> FakeSearcher:
        """만든 첫 Searcher 가짜다."""
        return self.searchers[0]

    @property
    def evaluator(self) -> FakeEvaluator:
        """만든 첫 Evaluator 가짜다."""
        return self.evaluators[0]

    @property
    def manager(self) -> JobManager:
        """만든 첫 작업 관리자다."""
        return self.managers[0]

    @property
    def spy(self) -> SpyJobManager:
        """만든 첫 작업 관리자를 스파이로 돌려준다."""
        manager = self.managers[0]
        assert isinstance(manager, SpyJobManager)
        return manager


def wire(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    *,
    jobs_cls: type[JobManager] = SpyJobManager,
) -> tuple[Services, Parts]:
    """lifecycle_service가 쓰는 단위를 가짜로 바꾸고 build_services로 조립한다."""
    parts = Parts(timeline=[])

    def make_hub(*_args: object, **_kwargs: object) -> FakeHub:
        fake = FakeHub(parts.timeline)
        parts.hubs.append(fake)
        return fake

    def make_store(*_args: object, **_kwargs: object) -> FakeStore:
        fake = FakeStore(parts.timeline)
        parts.stores.append(fake)
        return fake

    def make_chunker(*_args: object, **_kwargs: object) -> FakeChunker:
        fake = FakeChunker(parts.timeline)
        parts.chunkers.append(fake)
        return fake

    def make_indexer(*_args: object, **_kwargs: object) -> FakeIndexer:
        fake = FakeIndexer(parts.timeline)
        parts.indexers.append(fake)
        return fake

    def make_searcher(*_args: object, **_kwargs: object) -> FakeSearcher:
        fake = FakeSearcher(parts.timeline)
        parts.searchers.append(fake)
        return fake

    def make_evaluator(*_args: object, **_kwargs: object) -> FakeEvaluator:
        fake = FakeEvaluator(parts.timeline)
        parts.evaluators.append(fake)
        return fake

    def make_jobs(*args: Any, **kwargs: Any) -> JobManager:
        job_settings: Settings = args[0] if args else kwargs["settings"]
        manager = (
            SpyJobManager(job_settings, parts.timeline)
            if jobs_cls is SpyJobManager
            else jobs_cls(job_settings)
        )
        parts.managers.append(manager)
        return manager

    monkeypatch.setattr(lifecycle_module, "ModelHub", make_hub)
    monkeypatch.setattr(lifecycle_module, "ChunkStore", make_store)
    monkeypatch.setattr(lifecycle_module, "Chunker", make_chunker)
    monkeypatch.setattr(lifecycle_module, "Indexer", make_indexer)
    monkeypatch.setattr(lifecycle_module, "Searcher", make_searcher)
    monkeypatch.setattr(lifecycle_module, "Evaluator", make_evaluator)
    monkeypatch.setattr(lifecycle_module, "JobManager", make_jobs)
    return build_services(settings), parts


def index_request(
    *,
    doc_id: str = "doc-a",
    version: str = "v1",
    markdown: str = "# 제목\n\n본문",
    assets: Mapping[str, str] | None = None,
    name: str = "문서",
    edition: Edition | None = None,
    chunking: ChunkingMode = ChunkingMode.SEMANTIC,
    force: bool = False,
) -> IndexRequest:
    """색인 요청을 만든다."""
    return IndexRequest(
        doc_id=doc_id,
        version=version,
        markdown=markdown,
        name=name,
        assets=assets if assets is not None else {},
        edition=edition,
        chunking=chunking,
        force=force,
    )


def placeholder(kind: str, pid: str, desc: str) -> str:
    """색인용 MD의 자리표시 문자열을 만든다."""
    return f"[[minerva:{kind}:{pid} | {desc}]]"


def make_edition(label: str = "2026.1") -> Edition:
    """판 정보를 만든다."""
    return Edition(label=label, edition_date=date(2026, 1, 1))


def eval_case(
    *, query: str = "인증서 갱신 방법", answer_span: str = "ABCDEFGHIJKLMNOPQRST"
) -> EvaluationCase:
    """평가 입력을 만든다."""
    return EvaluationCase(query=query, doc_id="doc-a", answer_span=answer_span)
