"""색인 작업 관리 헬퍼: 접수·실행·기록과 Backend 알림 (REQ-RAG-10.8)."""

import asyncio
import json
import sqlite3
import uuid
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from functools import partial
from typing import Any, Protocol

import httpx

from minerva_rag.core import (
    FailureLocation,
    JobFailureCode,
    JobNotFoundError,
    Settings,
    ShuttingDownError,
    get_logger,
)

log = get_logger(__name__)

_BUSY_TIMEOUT_SECONDS = 5.0
_NOTIFY_TIMEOUT_SECONDS = 10.0
_SCHEMA_VERSION = 1
_RECORD_ATTEMPTS = 3  # 결과 기록을 바로 다시 시도하는 최대 횟수
_NOTIFY_FLUSH_SECONDS = 3.0  # 종료 때 마지막 알림의 첫 전송을 기다리는 상한
_INTERNAL_ERROR_MESSAGE = (
    "색인 중 예상하지 못한 오류가 발생했습니다. 서버 로그를 확인한 뒤 다시 색인해 주세요"
)
_SERVER_RESTARTED_MESSAGE = "작업이 끝나기 전에 RAG Server가 다시 시작했습니다. 다시 색인해 주세요"


# ── 공개 타입 ─────────────────────────────────────────────────────

IndexRunner = Callable[["ProgressReporter"], Awaitable["IndexOutcome"]]
RecoverFn = Callable[
    [str, str], Awaitable[bool]
]  # (doc_id, job_id) → 그 작업의 결과가 검색에 쓰이는가


class JobState(StrEnum):
    """작업 상태다."""

    QUEUED = "queued"  # 색인 대기
    RUNNING = "running"  # 색인 중
    SUCCEEDED = "succeeded"  # 완료
    FAILED = "failed"  # 실패
    SUPERSEDED = "superseded"  # 대체됨


class JobStage(StrEnum):
    """색인 중 단계다."""

    CHUNKING = "chunking"  # 분할
    EMBEDDING = "embedding"  # 임베딩
    STORING = "storing"  # 저장


@dataclass(frozen=True)
class IndexOutcome:
    """완료한 작업의 결과다."""

    chunk_count: int
    fallback_used: bool


class JobFailure(Exception):  # noqa: N818 — 명세가 정한 이름이다 (MODULE.md)
    """러너가 처리 중 실패를 작업 큐에 알리는 예외다."""

    def __init__(self, code: str, message: str, location: FailureLocation | None = None) -> None:
        """실패 사유 코드, 한국어 설명, 알고 있는 위치를 받는다."""
        super().__init__(message)
        self.code = code
        self.message = message
        self.location = location


class ProgressReporter(Protocol):
    """색인 중 단계와 미리 정한 결과를 작업 큐에 알린다."""

    @property
    def job_id(self) -> str:
        """실행 중인 작업의 ID다."""
        ...

    def stage(self, stage: JobStage) -> None:
        """지금 시작하는 단계를 알린다. ★ 동기 메서드다."""
        ...

    async def prepared(self, outcome: IndexOutcome) -> None:
        """활성화 전에 러너가 돌려줄 결과를 미리 기록한다."""
        ...


class JobQueue(Protocol):
    """서비스 파일들이 쓰는 작업 큐의 실행 표면이다."""

    async def start(self, recover: RecoverFn) -> None:
        """남은 작업을 끝맺고 작업 처리를 시작한다."""
        ...

    async def stop(self, timeout_seconds: float) -> None:
        """새 접수를 막고 실행 중인 작업을 기다린다."""
        ...

    async def submit(self, doc_id: str, version: str, checksum: str, run: IndexRunner) -> str:
        """작업을 접수하고 작업 ID를 돌려준다."""
        ...

    async def find_open(self, doc_id: str, checksum: str) -> str | None:
        """같은 문서·체크섬의 대기·색인 중 작업 ID를 돌려준다."""
        ...

    async def fail_queued(self, doc_id: str, code: str, message: str) -> None:
        """그 문서의 대기 작업을 받은 사유로 실패시킨다."""
        ...

    async def wait_running(self, doc_id: str) -> None:
        """그 문서의 색인 중 작업이 끝날 때까지 기다린다."""
        ...


@dataclass(frozen=True)
class JobFailureInfo:
    """실패한 작업의 사유다."""

    code: str
    message: str
    location: FailureLocation | None


@dataclass(frozen=True)
class JobView:
    """작업 하나의 상태다."""

    job_id: str
    doc_id: str
    version: str
    state: JobState
    stage: JobStage | None
    failure: JobFailureInfo | None
    result: IndexOutcome | None


@dataclass(frozen=True)
class IndexStateView:
    """문서 하나의 색인 상태다."""

    doc_id: str
    searchable_version: str | None
    latest_job_id: str | None
    latest_job_state: JobState | None
    latest_job_stage: JobStage | None


@dataclass(frozen=True)
class CurrentIndex:
    """지금 검색되는 색인을 만든 작업이다."""

    job_id: str
    version: str
    checksum: str


# ── 내부 타입 ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Change:
    """커밋된 상태 변경 하나다. 로그와 알림에 쓴다."""

    job_id: str
    doc_id: str
    version: str
    state: JobState
    failure_code: str | None
    sequence: int
    index_state: IndexStateView  # 트랜잭션이 끝나는 시점의 값


@dataclass
class _Pending:
    """이 프로세스가 러너를 가진 작업이다."""

    job_id: str
    doc_id: str
    version: str
    accepted_order: int
    run: IndexRunner


_RecordFn = Callable[[sqlite3.Connection], list[_Change]]  # 결과를 기록하는 트랜잭션 함수


class _Reporter:
    """ProgressReporter 구현이다. 작업 관리자의 기록 함수를 부른다."""

    def __init__(
        self,
        job: _Pending,
        on_stage: Callable[[_Pending, JobStage], None],
        on_prepared: Callable[[_Pending, IndexOutcome], Awaitable[None]],
    ) -> None:
        """작업과 기록 함수를 받는다."""
        self._job = job
        self._on_stage = on_stage
        self._on_prepared = on_prepared

    @property
    def job_id(self) -> str:
        """실행 중인 작업의 ID다."""
        return self._job.job_id

    def stage(self, stage: JobStage) -> None:
        """단계를 알린다. 알림은 보내지 않는다 (REQ-RAG-10.8.7.2)."""
        self._on_stage(self._job, stage)

    async def prepared(self, outcome: IndexOutcome) -> None:
        """미리 정한 결과를 기록한다. 기록하지 못하면 예외를 그대로 낸다."""
        await self._on_prepared(self._job, outcome)


# ── SQLite 트랜잭션 도우미 (워커 스레드에서 실행한다) ──────────────────


_ENDED_STATES = frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.SUPERSEDED})


def _ensure_document(conn: sqlite3.Connection, doc_id: str) -> None:
    """문서 레코드가 없으면 만든다. 있는 레코드는 건드리지 않는다."""
    conn.execute(
        "INSERT INTO documents (doc_id, searchable_job_id, last_sequence) VALUES (?, NULL, 0) "
        "ON CONFLICT(doc_id) DO NOTHING",
        (doc_id,),
    )


def _next_sequence(conn: sqlite3.Connection, doc_id: str) -> int:
    """그 문서의 알림 순번을 1 올리고 새 값을 돌려준다."""
    _ensure_document(conn, doc_id)
    conn.execute(
        "UPDATE documents SET last_sequence = last_sequence + 1 WHERE doc_id = ?", (doc_id,)
    )
    row = conn.execute("SELECT last_sequence FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
    return int(row[0])


def _index_state_row(conn: sqlite3.Connection, doc_id: str) -> IndexStateView:
    """저장된 값으로 문서 색인 상태를 만든다."""
    searchable = conn.execute(
        "SELECT j.version FROM documents d JOIN jobs j ON j.job_id = d.searchable_job_id "
        "WHERE d.doc_id = ?",
        (doc_id,),
    ).fetchone()
    latest = conn.execute(
        "SELECT job_id, state, stage FROM jobs WHERE doc_id = ? "
        "ORDER BY accepted_order DESC LIMIT 1",
        (doc_id,),
    ).fetchone()
    if latest is None:
        return IndexStateView(
            doc_id, searchable["version"] if searchable else None, None, None, None
        )
    state = JobState(latest["state"])
    stage = JobStage(latest["stage"]) if state is JobState.RUNNING and latest["stage"] else None
    return IndexStateView(
        doc_id=doc_id,
        searchable_version=searchable["version"] if searchable else None,
        latest_job_id=latest["job_id"],
        latest_job_state=state,
        latest_job_stage=stage,
    )


class _ChangeSet:
    """한 트랜잭션 안의 상태 변경을 모아 순번을 붙인다."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        """트랜잭션의 연결을 받는다."""
        self._conn = conn
        self._raw: list[tuple[str, str, str, JobState, str | None, int]] = []

    def add(
        self, job_id: str, doc_id: str, version: str, state: JobState, failure_code: str | None
    ) -> None:
        """변경 하나를 더하고 그 문서의 순번을 하나 쓴다."""
        sequence = _next_sequence(self._conn, doc_id)
        self._raw.append((job_id, doc_id, version, state, failure_code, sequence))

    def finish(self) -> list[_Change]:
        """★ 모든 변경을 마친 뒤 문서별 색인 상태를 읽어 변경마다 붙인다."""
        doc_ids = {raw[1] for raw in self._raw}
        states = {doc_id: _index_state_row(self._conn, doc_id) for doc_id in doc_ids}
        return [
            _Change(job_id, doc_id, version, state, code, sequence, states[doc_id])
            for job_id, doc_id, version, state, code, sequence in self._raw
        ]


def _normalize_location(location: FailureLocation | None) -> FailureLocation | None:
    """두 값이 모두 비어 있는 위치는 위치 없음으로 본다 (REQ-RAG-10.8.2.5)."""
    if location is None or (location.heading_path is None and location.placeholder_id is None):
        return None
    return location


def _location_columns(location: FailureLocation | None) -> tuple[str | None, str | None, int]:
    """실패 위치를 저장 열 값으로 바꾼다. 두 값이 모두 비면 위치가 없는 것이다."""
    location = _normalize_location(location)
    if location is None:
        return None, None, 0
    heading = (
        None
        if location.heading_path is None
        else json.dumps(list(location.heading_path), ensure_ascii=False)
    )
    return heading, location.placeholder_id, 1


def _fail_rows(
    conn: sqlite3.Connection,
    rows: Sequence[sqlite3.Row],
    code: str,
    message: str,
    location: FailureLocation | None,
) -> list[_Change]:
    """고른 작업들을 실패로 바꾸고 변경을 돌려준다."""
    heading, placeholder_id, has_location = _location_columns(location)
    changes = _ChangeSet(conn)
    for row in rows:
        conn.execute(
            "UPDATE jobs SET state = 'failed', stage = NULL, failure_code = ?, "
            "failure_message = ?, failure_heading_path = ?, failure_placeholder_id = ?, "
            "failure_has_location = ?, prepared_chunk_count = NULL, prepared_fallback_used = NULL "
            "WHERE job_id = ?",
            (code, message, heading, placeholder_id, has_location, row["job_id"]),
        )
        changes.add(row["job_id"], row["doc_id"], row["version"], JobState.FAILED, code)
    return changes.finish()


def _tx_submit(
    conn: sqlite3.Connection, job_id: str, doc_id: str, version: str, checksum: str
) -> tuple[int, list[_Change]]:
    """같은 문서의 대기 작업을 대체하고 새 작업을 대기로 기록한다."""
    queued = conn.execute(
        "SELECT job_id, doc_id, version FROM jobs WHERE doc_id = ? AND state = 'queued' "
        "ORDER BY accepted_order",
        (doc_id,),
    ).fetchall()
    changes = _ChangeSet(conn)
    for row in queued:
        conn.execute(
            "UPDATE jobs SET state = 'superseded', stage = NULL WHERE job_id = ?", (row["job_id"],)
        )
        changes.add(row["job_id"], row["doc_id"], row["version"], JobState.SUPERSEDED, None)
    order = int(conn.execute("SELECT COALESCE(MAX(accepted_order), 0) + 1 FROM jobs").fetchone()[0])
    conn.execute(
        "INSERT INTO jobs (job_id, doc_id, version, checksum, accepted_order, state) "
        "VALUES (?, ?, ?, ?, ?, 'queued')",
        (job_id, doc_id, version, checksum, order),
    )
    changes.add(job_id, doc_id, version, JobState.QUEUED, None)
    return order, changes.finish()


def _tx_start(conn: sqlite3.Connection, job_id: str) -> list[_Change]:
    """대기 작업을 색인 중으로 바꾼다. ★ 같은 트랜잭션에서 단계를 CHUNKING으로 기록한다."""
    row = conn.execute(
        "SELECT job_id, doc_id, version FROM jobs WHERE job_id = ? AND state = 'queued'",
        (job_id,),
    ).fetchone()
    if row is None:
        return []
    conn.execute(
        "UPDATE jobs SET state = 'running', stage = 'chunking' WHERE job_id = ?", (job_id,)
    )
    changes = _ChangeSet(conn)
    changes.add(job_id, row["doc_id"], row["version"], JobState.RUNNING, None)
    return changes.finish()


def _tx_succeed(conn: sqlite3.Connection, job_id: str, outcome: IndexOutcome) -> list[_Change]:
    """색인 중인 작업을 완료로 바꾸고 그 문서의 검색 작업으로 삼는다."""
    row = conn.execute(
        "SELECT job_id, doc_id, version FROM jobs WHERE job_id = ? AND state = 'running'",
        (job_id,),
    ).fetchone()
    if row is None:
        return []
    _ensure_document(conn, row["doc_id"])
    conn.execute(
        "UPDATE jobs SET state = 'succeeded', stage = NULL, chunk_count = ?, fallback_used = ?, "
        "prepared_chunk_count = NULL, prepared_fallback_used = NULL WHERE job_id = ?",
        (outcome.chunk_count, int(outcome.fallback_used), job_id),
    )
    conn.execute(
        "UPDATE documents SET searchable_job_id = ? WHERE doc_id = ?", (job_id, row["doc_id"])
    )
    changes = _ChangeSet(conn)
    changes.add(job_id, row["doc_id"], row["version"], JobState.SUCCEEDED, None)
    return changes.finish()


def _tx_fail_running(
    conn: sqlite3.Connection,
    job_id: str,
    code: str,
    message: str,
    location: FailureLocation | None,
) -> list[_Change]:
    """색인 중인 작업을 실패로 바꾼다."""
    row = conn.execute(
        "SELECT job_id, doc_id, version FROM jobs WHERE job_id = ? AND state = 'running'",
        (job_id,),
    ).fetchone()
    if row is None:
        return []
    return _fail_rows(conn, [row], code, message, location)


def _tx_fail_queued(
    conn: sqlite3.Connection, doc_id: str | None, code: str, message: str
) -> list[_Change]:
    """대기 작업을 실패로 바꾼다. doc_id가 없으면 모든 문서의 대기 작업이다."""
    if doc_id is None:
        rows = conn.execute(
            "SELECT job_id, doc_id, version FROM jobs WHERE state = 'queued' "
            "ORDER BY accepted_order"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT job_id, doc_id, version FROM jobs WHERE doc_id = ? AND state = 'queued' "
            "ORDER BY accepted_order",
            (doc_id,),
        ).fetchall()
    return _fail_rows(conn, rows, code, message, None)


def _tx_prepared(conn: sqlite3.Connection, job_id: str, outcome: IndexOutcome) -> None:
    """색인 중인 작업의 미리 정한 결과를 기록한다."""
    conn.execute(
        "UPDATE jobs SET prepared_chunk_count = ?, prepared_fallback_used = ? "
        "WHERE job_id = ? AND state = 'running'",
        (outcome.chunk_count, int(outcome.fallback_used), job_id),
    )


def _tx_stage(conn: sqlite3.Connection, job_id: str, stage: str) -> None:
    """색인 중인 작업의 단계를 기록한다."""
    conn.execute(
        "UPDATE jobs SET stage = ? WHERE job_id = ? AND state = 'running'", (stage, job_id)
    )


def _tx_forget(conn: sqlite3.Connection, doc_id: str) -> None:
    """★ 검색 작업만 비운다. 문서 레코드와 순번은 지우지 않는다 (REQ-RAG-10.8.7.4)."""
    conn.execute("UPDATE documents SET searchable_job_id = NULL WHERE doc_id = ?", (doc_id,))


def _read_job(conn: sqlite3.Connection, job_id: str) -> JobView | None:
    """저장된 값으로 작업 하나를 읽는다."""
    row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    state = JobState(row["state"])
    failure = None
    if state is JobState.FAILED:
        failure = JobFailureInfo(row["failure_code"], row["failure_message"], _read_location(row))
    result = None
    if state is JobState.SUCCEEDED:
        result = IndexOutcome(int(row["chunk_count"]), bool(row["fallback_used"]))
    return JobView(
        job_id=row["job_id"],
        doc_id=row["doc_id"],
        version=row["version"],
        state=state,
        stage=JobStage(row["stage"]) if state is JobState.RUNNING and row["stage"] else None,
        failure=failure,
        result=result,
    )


def _read_location(row: sqlite3.Row) -> FailureLocation | None:
    """저장된 실패 위치를 읽는다."""
    if not row["failure_has_location"]:
        return None
    raw = row["failure_heading_path"]
    heading = None if raw is None else tuple(json.loads(raw))
    return FailureLocation(heading, row["failure_placeholder_id"])


def _read_find_open(conn: sqlite3.Connection, doc_id: str, checksum: str) -> str | None:
    """같은 문서·체크섬의 대기·색인 중 작업 중 가장 늦게 접수된 작업 ID를 읽는다."""
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE doc_id = ? AND checksum = ? "
        "AND state IN ('queued', 'running') ORDER BY accepted_order DESC LIMIT 1",
        (doc_id, checksum),
    ).fetchone()
    return None if row is None else row["job_id"]


def _read_current(conn: sqlite3.Connection, doc_id: str) -> CurrentIndex | None:
    """그 문서에서 지금 검색되는 색인을 만든 작업을 읽는다."""
    row = conn.execute(
        "SELECT j.job_id, j.version, j.checksum FROM documents d "
        "JOIN jobs j ON j.job_id = d.searchable_job_id WHERE d.doc_id = ?",
        (doc_id,),
    ).fetchone()
    return None if row is None else CurrentIndex(row["job_id"], row["version"], row["checksum"])


def _read_running(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """색인 중으로 남은 작업을 접수 순서대로 읽는다."""
    return conn.execute(
        "SELECT job_id, doc_id, prepared_chunk_count, prepared_fallback_used FROM jobs "
        "WHERE state = 'running' ORDER BY accepted_order"
    ).fetchall()


def _notification_body(change: _Change) -> dict[str, Any]:
    """★ 루트 IF-2 표의 필드만 담은 알림 본문을 만든다."""
    view = change.index_state
    return {
        "doc_id": change.doc_id,
        "job_id": change.job_id,
        "version": change.version,
        "job_state": change.state.value,
        "index_state": {
            "searchable_version": view.searchable_version,
            "latest_job_id": view.latest_job_id,
            "latest_job_state": view.latest_job_state.value if view.latest_job_state else None,
            "latest_job_stage": view.latest_job_stage.value if view.latest_job_stage else None,
        },
        "sequence": change.sequence,
    }


# ── 작업 관리자 ───────────────────────────────────────────────────


def _log_orphan_error(step: str, job_id: str, doc_id: str, task: asyncio.Task[Any]) -> None:
    """호출자가 취소돼 받을 곳이 없는 분리 태스크의 예외를 로그로 남긴다."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error(
            "service.job_error",
            job_id=job_id,
            doc_id=doc_id,
            step=step,
            error_type=type(exc).__name__,
            exc_info=exc,
        )


class JobManager:
    """작업을 접수·실행·기록하고 Backend에 알린다."""

    def __init__(self, settings: Settings) -> None:
        """설정을 받는다. I/O는 하지 않는다."""
        self._settings = settings
        self._path = settings.jobs_db_path
        self._concurrency = settings.job_concurrency
        self._lock = asyncio.Lock()  # 쓰기와 알림 큐 넣기를 한 순서로 묶는다
        self._start_called = False
        self._started = False
        self._stopping = False
        self._http: httpx.AsyncClient | None = None
        self._pending: dict[str, _Pending] = {}
        self._running: dict[str, asyncio.Task[None]] = {}
        self._running_docs: dict[str, str] = {}  # doc_id → 색인 중인 job_id
        self._stages: dict[str, JobStage] = {}
        self._record_tasks: set[asyncio.Task[None]] = set()
        self._background: set[asyncio.Task[Any]] = set()
        self._outbox: dict[str, deque[tuple[_Change, dict[str, Any]]]] = {}
        self._senders: dict[str, asyncio.Task[None]] = {}

    # ── 수명 ──

    async def start(self, recover: RecoverFn) -> None:
        """남은 작업을 끝맺고 작업 처리를 시작한다 (REQ-RAG-10.8.5)."""
        if self._start_called:
            raise RuntimeError("JobManager.start를 이미 불렀습니다")
        self._start_called = True
        try:
            await asyncio.to_thread(self._init_db)
        except BaseException:
            self._start_called = False  # ★ 기동 실패 뒤 다시 start할 수 있게 되돌린다
            raise
        # ★ 테스트 대체 경계: transport=를 직접 지정하지 않는다.
        #   테스트가 httpx의 기본 전송을 가로챈다
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(_NOTIFY_TIMEOUT_SECONDS))
        try:
            failed = await self._fail_leftover_queued()
            recovered = 0
            for row in await asyncio.to_thread(self._read, _read_running):
                if await self._resolve_running(row, recover):
                    recovered += 1
                else:
                    failed += 1
            if failed or recovered:
                log.warning("service.job_restart_resolved", failed=failed, recovered=recovered)
            self._started = True
            await self._dispatch()
        except BaseException:
            # ★ 기동 실패 시 연 자원을 닫고 다시 start할 수 있게 되돌린다
            self._started = False
            self._start_called = False
            await self._close_notifier()
            raise

    async def stop(self, timeout_seconds: float) -> None:
        """새 접수를 막고 색인 중인 작업을 기다린다. 끝나지 않은 작업은 취소해 둔다."""
        self._stopping = True  # ★ 첫 줄. 이후 submit은 ShuttingDownError, 새 배정은 없다
        running = set(self._running.values())
        if running:
            _, unfinished = await asyncio.wait(running, timeout=timeout_seconds)
            for task in unfinished:
                task.cancel()
            await asyncio.gather(*unfinished, return_exceptions=True)
        # 경계에서 끝난 결과 기록과 단계 저장은 마저 마친다
        await asyncio.gather(*self._record_tasks, *self._background, return_exceptions=True)
        # ★ 닫기 전에 방금 끝난 작업의 알림이 첫 전송을 시도할 짬을 준다. 상한이 있다
        senders = set(self._senders.values())
        if senders:
            await asyncio.wait(senders, timeout=_NOTIFY_FLUSH_SECONDS)
        await self._close_notifier()

    async def _close_notifier(self) -> None:
        """알림 전송 작업을 멈추고 HTTP 클라이언트를 닫는다."""
        senders = list(self._senders.values())
        for sender in senders:
            sender.cancel()
        await asyncio.gather(*senders, return_exceptions=True)
        self._outbox.clear()  # 남은 알림은 버린다. Backend의 상태 맞추기가 메운다
        http, self._http = self._http, None
        if http is not None:
            await http.aclose()

    # ── 접수·변경 ──

    async def submit(self, doc_id: str, version: str, checksum: str, run: IndexRunner) -> str:
        """작업을 대기로 기록하고 실행 대기열에 넣은 뒤 작업 ID를 곧바로 돌려준다."""
        self._require_open()
        job_id = uuid.uuid4().hex
        # ★ 기록~메모리 반영~배정을 호출자 취소와 떼어 한 단위로 끝낸다
        await self._detached(
            self._submit_unit(job_id, doc_id, version, checksum, run),
            step="submit",
            job_id=job_id,
            doc_id=doc_id,
        )
        return job_id

    async def _submit_unit(
        self, job_id: str, doc_id: str, version: str, checksum: str, run: IndexRunner
    ) -> None:
        """접수 트랜잭션, 메모리 반영, 알림 큐 넣기, 배정을 이어서 한다."""
        async with self._lock:
            self._require_open()  # 잠금을 기다리는 사이 stop이 불렸을 수 있다
            order, changes = await asyncio.to_thread(
                self._write_tx,
                partial(
                    _tx_submit, job_id=job_id, doc_id=doc_id, version=version, checksum=checksum
                ),
            )
            self._after_commit(changes)
            self._pending[job_id] = _Pending(job_id, doc_id, version, order, run)
        await self._dispatch_locked()

    async def find_open(self, doc_id: str, checksum: str) -> str | None:
        """같은 문서·체크섬의 대기·색인 중 작업 ID를 돌려준다. 없으면 None이다."""
        self._require_started()
        return await asyncio.to_thread(
            self._read, partial(_read_find_open, doc_id=doc_id, checksum=checksum)
        )

    async def fail_queued(self, doc_id: str, code: str, message: str) -> None:
        """그 문서의 대기 작업만 받은 사유로 실패시킨다. 그 러너는 부르지 않는다."""
        self._require_started()
        await self._detached(
            self._fail_queued_unit(doc_id, code, message), step="fail_queued", doc_id=doc_id
        )

    async def _fail_queued_unit(self, doc_id: str, code: str, message: str) -> None:
        """★ 호출자 취소와 떼어 실패 기록과 알림 큐 넣기를 한 단위로 한다."""
        async with self._lock:
            changes = await asyncio.to_thread(
                self._write_tx, partial(_tx_fail_queued, doc_id=doc_id, code=code, message=message)
            )
            self._after_commit(changes)

    async def wait_running(self, doc_id: str) -> None:
        """그 문서의 색인 중 작업이 끝날 때까지 기다린다. 없으면 바로 돌아온다."""
        self._require_started()
        job_id = self._running_docs.get(doc_id)
        task = None if job_id is None else self._running.get(job_id)
        if task is not None:
            # ★ wait는 기다리는 쪽이 취소돼도 작업을 취소하지 않는다
            await asyncio.wait({task})

    async def forget_document(self, doc_id: str) -> None:
        """그 문서의 검색되는 버전을 비운다. 알림 순번은 그대로 둔다."""
        self._require_started()
        await self._detached(self._forget_unit(doc_id), step="forget", doc_id=doc_id)

    async def _forget_unit(self, doc_id: str) -> None:
        """★ 호출자 취소와 떼어 검색 작업 비우기를 끝까지 한다."""
        async with self._lock:
            await asyncio.to_thread(self._write_tx, partial(_tx_forget, doc_id=doc_id))

    # ── 조회 ──

    async def get_job(self, job_id: str) -> JobView:
        """작업 ID로 작업 상태를 조회한다. 없으면 JobNotFoundError다."""
        self._require_started()
        view = await asyncio.to_thread(self._read, partial(_read_job, job_id=job_id))
        if view is None:
            raise JobNotFoundError()
        # ★ 알린 직후 조회에 맞추려고 단계는 메모리 값이 우선한다 (REQ-RAG-10.8.2.3)
        stage = self._stages.get(job_id)
        if view.state is JobState.RUNNING and stage is not None:
            return replace(view, stage=stage)
        return view

    async def index_state(self, doc_id: str) -> IndexStateView:
        """문서 하나의 색인 상태를 조회한다."""
        self._require_started()
        view = await asyncio.to_thread(self._read, partial(_index_state_row, doc_id=doc_id))
        return self._with_stage(view)

    async def index_states(self, doc_ids: Sequence[str]) -> list[IndexStateView]:
        """여러 문서의 색인 상태를 받은 순서·개수대로 조회한다."""
        self._require_started()

        def _read_many(conn: sqlite3.Connection) -> list[IndexStateView]:
            return [_index_state_row(conn, doc_id) for doc_id in doc_ids]

        views = await asyncio.to_thread(self._read, _read_many)
        return [self._with_stage(view) for view in views]

    async def current_index(self, doc_id: str) -> CurrentIndex | None:
        """그 문서에서 지금 검색되는 색인을 만든 작업을 돌려준다."""
        self._require_started()
        return await asyncio.to_thread(self._read, partial(_read_current, doc_id=doc_id))

    # ── 호출 순서 확인 ──

    def _require_started(self) -> None:
        """start가 끝나기 전의 호출은 호출 순서 위반이다."""
        if not self._started:
            raise RuntimeError("JobManager.start 전에 호출했습니다")

    def _require_open(self) -> None:
        """stop 뒤의 접수는 막고, start가 끝나기 전의 접수는 호출 순서 위반이다."""
        if self._stopping:
            raise ShuttingDownError()
        self._require_started()

    # ── SQLite ──

    def _open(self) -> sqlite3.Connection:
        """작업 목록 SQLite 파일에 연결한다. 호출한 스레드에서만 쓴다."""
        # ★ 테스트 대체 경계: `import sqlite3` 후 `sqlite3.connect(...)`로 호출 시점에 찾는다.
        #   `from sqlite3 import connect`로 바꾸면 테스트의 쓰기 실패 주입이 걸리지 않는다
        conn = sqlite3.connect(self._path, timeout=_BUSY_TIMEOUT_SECONDS, isolation_level=None)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        """폴더와 스키마를 만든다."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._open()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS jobs ("
                "job_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, version TEXT NOT NULL, "
                "checksum TEXT NOT NULL, accepted_order INTEGER NOT NULL UNIQUE, "
                "state TEXT NOT NULL, stage TEXT, failure_code TEXT, failure_message TEXT, "
                "failure_heading_path TEXT, failure_placeholder_id TEXT, "
                "failure_has_location INTEGER NOT NULL DEFAULT 0, "
                "chunk_count INTEGER, fallback_used INTEGER, "
                "prepared_chunk_count INTEGER, prepared_fallback_used INTEGER)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS jobs_doc_order ON jobs (doc_id, accepted_order)"
            )
            conn.execute("CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state)")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS documents ("
                "doc_id TEXT PRIMARY KEY, searchable_job_id TEXT, "
                "last_sequence INTEGER NOT NULL DEFAULT 0)"
            )
            conn.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
        finally:
            conn.close()

    def _write_tx[T](self, work: Callable[[sqlite3.Connection], T]) -> T:
        """쓰기 트랜잭션 하나를 실행한다. 실패하면 모두 되돌린다."""
        conn = self._open()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                result = work(conn)
                conn.commit()
            except BaseException:
                conn.rollback()  # ★ 상태와 순번을 함께 되돌린다 (REQ-RAG-10.8.7.4)
                raise
            return result
        finally:
            conn.close()

    def _read[T](self, work: Callable[[sqlite3.Connection], T]) -> T:
        """읽기 전용 스냅샷에서 값을 읽는다."""
        conn = self._open()
        try:
            conn.execute("BEGIN")
            try:
                return work(conn)
            finally:
                conn.rollback()
        finally:
            conn.close()

    # ── 시작 정리 ──

    async def _fail_leftover_queued(self) -> int:
        """남은 대기 작업을 모두 SERVER_RESTARTED로 실패시키고 그 수를 돌려준다."""
        async with self._lock:
            changes = await asyncio.to_thread(
                self._write_tx,
                partial(
                    _tx_fail_queued,
                    doc_id=None,
                    code=JobFailureCode.SERVER_RESTARTED.value,
                    message=_SERVER_RESTARTED_MESSAGE,
                ),
            )
            self._after_commit(changes)
        return len(changes)

    async def _resolve_running(self, row: sqlite3.Row, recover: RecoverFn) -> bool:
        """색인 중으로 남은 작업을 recover 결과에 따라 끝맺는다. 완료로 끝맺으면 참이다."""
        job_id, doc_id = row["job_id"], row["doc_id"]
        # ★ recover의 예외는 잡지 않는다. 작업을 바꾸지 않고 start가 그대로 낸다 (기동 실패)
        searchable = await recover(doc_id, job_id)
        prepared = row["prepared_chunk_count"]
        if searchable and prepared is not None:
            outcome = IndexOutcome(int(prepared), bool(row["prepared_fallback_used"]))
            work = partial(_tx_succeed, job_id=job_id, outcome=outcome)
        else:
            if searchable:  # prepared는 활성화 전에 기록되므로 생길 수 없는 경로의 방어
                log.error(
                    "service.job_error",
                    job_id=job_id,
                    doc_id=doc_id,
                    step="recover",
                    error_type="MissingPrepared",
                )
            work = partial(
                _tx_fail_running,
                job_id=job_id,
                code=JobFailureCode.SERVER_RESTARTED.value,
                message=_SERVER_RESTARTED_MESSAGE,
                location=None,
            )
        async with self._lock:
            changes = await asyncio.to_thread(self._write_tx, work)
            self._after_commit(changes)
        return searchable and prepared is not None

    # ── 실행 배정 ──

    def _next_runnable(self, blocked_docs: frozenset[str] = frozenset()) -> _Pending | None:
        """색인 중이거나 배정에 실패한 문서를 뺀 대기 작업 중 가장 먼저 접수된 것을 고른다."""
        candidates = [
            j
            for j in self._pending.values()
            if j.doc_id not in self._running_docs and j.doc_id not in blocked_docs
        ]
        return min(candidates, key=lambda job: job.accepted_order, default=None)

    async def _detached[T](
        self, work: Coroutine[Any, Any, T], *, step: str, job_id: str = "", doc_id: str = ""
    ) -> T:
        """★ 작업을 별도 태스크로 띄워 호출자가 취소돼도 끝까지 하게 한다. 참조는 유지한다."""
        task = asyncio.create_task(work)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # 호출자가 취소돼 예외를 받을 곳이 없다 — 안쪽 일의 실패는 여기서 로그로 남긴다
            task.add_done_callback(partial(_log_orphan_error, step, job_id, doc_id))
            raise

    async def _dispatch(self) -> None:
        """배정을 호출자 취소와 떼어 끝까지 한다."""
        await self._detached(self._dispatch_locked(), step="dispatch")

    async def _dispatch_locked(self) -> None:
        """★ 상한과 문서별 순차 조건을 만족하는 대기 작업을 접수 순서대로 시작한다."""
        async with self._lock:
            # ★ 배정에 실패한 문서는 이번 호출에서 건너뛴다(같은 문서의 뒤 작업이 앞지르지 않게)
            failed_docs: set[str] = set()
            while not self._stopping and len(self._running) < self._concurrency:
                job = self._next_runnable(frozenset(failed_docs))
                if job is None:
                    return
                if not await self._start_job(job):
                    failed_docs.add(job.doc_id)

    async def _start_job(self, job: _Pending) -> bool:
        """대기 작업을 색인 중으로 바꾸고 러너를 띄운다. 배정에 실패하면 거짓이다."""
        try:
            changes = await asyncio.to_thread(self._write_tx, partial(_tx_start, job_id=job.job_id))
        except Exception as exc:
            # 작업은 대기로 남고, 다음 배정 계기(다른 작업의 종료·새 접수)에 다시 배정한다
            log.exception(
                "service.job_error",
                job_id=job.job_id,
                doc_id=job.doc_id,
                step="dispatch",
                error_type=type(exc).__name__,
            )
            return False
        self._pending.pop(job.job_id, None)  # ★ 러너 참조는 여기서만 꺼낸다. 다시 실행하지 않는다
        if self._stopping:
            # ★ stop이 `_running`을 이미 떠 간 뒤에 커밋이 끝난 경합이다. 여기서 태스크를 만들면
            #   stop의 대기·취소 대상 밖에서 닫힌 자원 위에 실행돼 FAILED로 잘못 기록될 수 있다.
            #   그래서 실행하지 않고 RUNNING으로 남긴다 — 다음 start의 재시작 처리가 끝맺는다
            #   (REQ-RAG-10.1.3, REQ-RAG-10.8.5)
            self._after_commit(changes)
            return True
        if changes:
            self._stages[job.job_id] = JobStage.CHUNKING
            self._running_docs[job.doc_id] = job.job_id
            self._running[job.job_id] = asyncio.create_task(self._execute(job))
            self._after_commit(changes)
        return True

    async def _execute(self, job: _Pending) -> None:
        """러너를 실행하고 결과를 기록한 뒤 다음 작업을 배정한다."""
        reporter = _Reporter(job, self._on_stage, self._on_prepared)
        try:
            try:
                outcome = await job.run(reporter)
            except JobFailure as failure:
                record = partial(
                    _tx_fail_running,
                    job_id=job.job_id,
                    code=str(failure.code),
                    message=failure.message,
                    location=failure.location,
                )
            except Exception as exc:
                log.exception(
                    "service.job_error",
                    job_id=job.job_id,
                    doc_id=job.doc_id,
                    step="run",
                    error_type=type(exc).__name__,
                )
                record = partial(
                    _tx_fail_running,
                    job_id=job.job_id,
                    code=JobFailureCode.INTERNAL_ERROR.value,
                    message=_INTERNAL_ERROR_MESSAGE,
                    location=None,
                )
            else:
                record = partial(_tx_succeed, job_id=job.job_id, outcome=outcome)
            await self._shielded_record(job, record)
        finally:
            # ★ 취소(CancelledError)면 아무것도 기록하지 않아 RUNNING으로 남는다 (REQ-RAG-10.1.3)
            self._running.pop(job.job_id, None)
            self._running_docs.pop(job.doc_id, None)
            self._stages.pop(job.job_id, None)
        if not self._stopping:
            await self._dispatch_safely(job)

    async def _dispatch_safely(self, job: _Pending) -> None:
        """다음 배정의 예외가 작업 태스크 밖으로 새지 않게 한다."""
        try:
            await self._dispatch()
        except Exception as exc:
            log.exception(
                "service.job_error",
                job_id=job.job_id,
                doc_id=job.doc_id,
                step="dispatch",
                error_type=type(exc).__name__,
            )

    async def _shielded_record(self, job: _Pending, record: _RecordFn) -> None:
        """★ 취소돼도 결과 기록은 끝까지 한다."""
        task = asyncio.create_task(self._record(job, record))
        self._record_tasks.add(task)
        task.add_done_callback(self._record_tasks.discard)
        await asyncio.shield(task)

    async def _record(self, job: _Pending, record: _RecordFn) -> None:
        """결과를 기록하고 알린다. 실패하면 바로 몇 번 더 시도하고, 안 되면 로그만 남긴다."""
        error: Exception | None = None
        for _ in range(_RECORD_ATTEMPTS):
            async with self._lock:
                try:
                    changes = await asyncio.to_thread(self._write_tx, record)
                except Exception as exc:
                    error = exc
                    continue
                self._after_commit(changes)
                return
        log.error(
            "service.job_error",
            job_id=job.job_id,
            doc_id=job.doc_id,
            step="record",
            error_type=type(error).__name__,
            exc_info=error,
        )
        # ★ DB에는 RUNNING이 남는다. 슬롯은 반납하고, 남은 RUNNING은 재시작 recover가 끝맺는다

    def _on_stage(self, job: _Pending, stage: JobStage) -> None:
        """러너가 알린 단계를 메모리에 두고 SQLite에 백그라운드로 저장한다."""
        if job.job_id not in self._running:
            return
        self._stages[job.job_id] = stage
        task = asyncio.create_task(self._save_stage(job, stage))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _save_stage(self, job: _Pending, stage: JobStage) -> None:
        """단계를 저장한다. 이미 끝난 작업은 바꾸지 않는다."""
        async with self._lock:
            try:
                await asyncio.to_thread(
                    self._write_tx, partial(_tx_stage, job_id=job.job_id, stage=stage.value)
                )
            except Exception as exc:
                log.exception(
                    "service.job_error",
                    job_id=job.job_id,
                    doc_id=job.doc_id,
                    step="stage",
                    error_type=type(exc).__name__,
                )

    async def _on_prepared(self, job: _Pending, outcome: IndexOutcome) -> None:
        """★ 활성화 전에 결과를 기록한다. 실패하면 예외를 러너에 그대로 전한다."""
        async with self._lock:
            await asyncio.to_thread(
                self._write_tx, partial(_tx_prepared, job_id=job.job_id, outcome=outcome)
            )

    def _with_stage(self, view: IndexStateView) -> IndexStateView:
        """최신 작업이 색인 중이면 메모리의 단계로 덮어쓴다."""
        job_id = view.latest_job_id
        stage = None if job_id is None else self._stages.get(job_id)
        if view.latest_job_state is JobState.RUNNING and stage is not None:
            return replace(view, latest_job_stage=stage)
        return view

    # ── 커밋 뒤 처리와 알림 ──

    def _after_commit(self, changes: Sequence[_Change]) -> None:
        """★ 커밋한 뒤에만 부른다. 로그를 남기고 알림 큐에 넣는다."""
        for change in changes:
            if change.state in _ENDED_STATES:
                self._pending.pop(change.job_id, None)
            log.info(
                "service.job_state",
                job_id=change.job_id,
                doc_id=change.doc_id,
                version=change.version,
                state=change.state.value,
                failure_code=change.failure_code,
            )
            self._enqueue(change)

    def _enqueue(self, change: _Change) -> None:
        """그 문서의 알림 큐에 넣는다. 전송 작업이 없으면 띄운다."""
        if self._http is None:
            return
        queue = self._outbox.setdefault(change.doc_id, deque())
        queue.append((change, _notification_body(change)))
        if change.doc_id not in self._senders:
            self._senders[change.doc_id] = asyncio.create_task(self._drain(change.doc_id))

    async def _drain(self, doc_id: str) -> None:
        """★ 같은 문서의 알림을 순번 순으로 하나씩 보낸다. 다른 문서는 기다리지 않는다."""
        queue = self._outbox[doc_id]
        try:
            while queue:
                change, body = queue[0]
                await self._deliver_safely(change, body)
                queue.popleft()
        finally:
            # 판정과 삭제 사이에 await가 없어 새 알림과 경쟁하지 않는다
            self._senders.pop(doc_id, None)
            if not queue:
                self._outbox.pop(doc_id, None)

    async def _deliver_safely(self, change: _Change, body: dict[str, Any]) -> None:
        """HTTP 오류가 아닌 예외가 전송 작업을 죽이지 않게 한다."""
        try:
            await self._deliver(change, body)
        except Exception as exc:
            log.exception(
                "service.job_error",
                job_id=change.job_id,
                doc_id=change.doc_id,
                step="notify",
                error_type=type(exc).__name__,
            )

    async def _deliver(self, change: _Change, body: dict[str, Any]) -> None:
        """알림 하나를 보낸다. 실패하면 1초부터 두 배씩 늘려 다시 보내고, 다 실패하면 버린다."""
        http = self._http
        if http is None:
            return
        url = self._settings.backend_events_url
        headers = {"X-Minerva-Token": self._settings.backend_events_token.get_secret_value()}
        attempts = 0
        for attempt in range(1 + self._settings.notify_retries):
            if attempt:
                # ★ 테스트 대체 경계: 모듈 속성 `asyncio.sleep`으로 부른다.
                #   `from asyncio import sleep`으로 바꾸면 대기를 가로채지 못해 실제로 기다린다
                await asyncio.sleep(float(2 ** (attempt - 1)))
            attempts += 1
            if await _post(http, url, body, headers):
                return
        log.warning(
            "service.job_notify_failed",
            job_id=change.job_id,
            doc_id=change.doc_id,
            sequence=change.sequence,
            attempts=attempts,
        )


async def _post(
    http: httpx.AsyncClient, url: str, body: dict[str, Any], headers: dict[str, str]
) -> bool:
    """알림을 한 번 보내고 2xx를 받았는지 돌려준다. 401·5xx·연결 오류는 모두 실패다."""
    try:
        response = await http.post(url, json=body, headers=headers)
    except httpx.HTTPError:
        return False
    return 200 <= response.status_code < 300
