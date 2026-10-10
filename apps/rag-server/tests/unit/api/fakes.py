"""api 단위 테스트가 공유하는 가짜 서비스, 표본 데이터, 도우미 (대체 경계)."""

import asyncio
import json
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date
from typing import Any, cast

from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response

from minerva_rag.api import create_app
from minerva_rag.core import ChunkKind, Edition, FailureLocation
from minerva_rag.evaluation import EvaluationCase, EvaluationMetrics, EvaluationResult
from minerva_rag.search import (
    DocumentChunk,
    DocumentChunks,
    ResultChunk,
    ResultEdition,
    SearchHit,
    SearchQuery,
)
from minerva_rag.service import (
    CaptionService,
    DeleteService,
    EvaluationService,
    Health,
    IndexAccepted,
    IndexOutcome,
    IndexRequest,
    IndexService,
    IndexStateView,
    JobFailureInfo,
    JobStage,
    JobState,
    JobView,
    LifecycleService,
    MetadataService,
    SearchService,
    Services,
)

# 테스트 환경의 API 토큰이다 (conftest의 필수 키와 같은 값)
TOKEN = "api-token-for-test"
AUTH = {"X-Minerva-Token": TOKEN}

# 비동기·폴링 대기가 끝나지 않는 일이 없게 하는 상한(초)이다
WAIT_LIMIT = 5.0

Call = tuple[str, tuple[Any, ...]]


# ── 가짜 서비스 ───────────────────────────────────────────────────


class _Fake:
    """호출을 기록하고, 정해 둔 값이나 예외를 돌려주는 가짜의 바탕이다."""

    def __init__(self) -> None:
        # 호출 기록: (메서드 이름, 인자들)
        self.calls: list[Call] = []
        # 메서드 이름 → 돌려줄 값 (없으면 메서드의 기본값)
        self.returns: dict[str, Any] = {}
        # 메서드 이름 → 낼 예외
        self.raises: dict[str, BaseException] = {}

    def _enter(self, name: str, *args: Any) -> None:
        """호출을 기록하고, 낼 예외가 정해져 있으면 낸다."""
        self.calls.append((name, args))
        exc = self.raises.get(name)
        if exc is not None:
            raise exc


class FakeCaption(_Fake):
    """CaptionService의 가짜다."""

    async def summarize_table(self, table_markdown: str) -> str:
        """표 요약을 돌려준다."""
        self._enter("summarize_table", table_markdown)
        return self.returns.get("summarize_table", "표 요약 문장")

    async def caption_image(self, image: bytes) -> str:
        """이미지 캡션을 돌려준다."""
        self._enter("caption_image", image)
        return self.returns.get("caption_image", "이미지 캡션 문장")


class FakeIndex(_Fake):
    """IndexService의 가짜다."""

    async def submit(self, req: IndexRequest) -> IndexAccepted:
        """색인 접수 결과를 돌려준다."""
        self._enter("submit", req)
        default = IndexAccepted("queued", "job-7f3a", req.doc_id, req.version)
        return self.returns.get("submit", default)

    async def get_job(self, job_id: str) -> JobView:
        """작업 상태를 돌려준다."""
        self._enter("get_job", job_id)
        return self.returns.get("get_job", job_view(job_id=job_id))

    async def index_state(self, doc_id: str) -> IndexStateView:
        """문서 색인 상태를 돌려준다."""
        self._enter("index_state", doc_id)
        return self.returns.get("index_state", IndexStateView(doc_id, None, None, None, None))

    async def index_states(self, doc_ids: Sequence[str]) -> list[IndexStateView]:
        """받은 ID마다 문서 색인 상태를 돌려준다."""
        self._enter("index_states", doc_ids)
        default = [IndexStateView(doc_id, None, None, None, None) for doc_id in doc_ids]
        return self.returns.get("index_states", default)


class FakeSearch(_Fake):
    """SearchService의 가짜다."""

    async def search(self, q: SearchQuery) -> tuple[SearchHit, ...]:
        """검색 결과를 돌려준다."""
        self._enter("search", q)
        return self.returns.get("search", ())

    async def document_chunks(self, doc_id: str) -> DocumentChunks:
        """문서 청크를 돌려준다."""
        self._enter("document_chunks", doc_id)
        return self.returns.get("document_chunks", DocumentChunks(doc_id, None, None, None, ()))


class FakeDelete(_Fake):
    """DeleteService의 가짜다."""

    async def delete(self, doc_id: str) -> None:
        """문서 삭제를 기록한다."""
        self._enter("delete", doc_id)


class FakeMetadata(_Fake):
    """MetadataService의 가짜다."""

    async def update(self, doc_id: str, name: str, edition: Edition | None) -> None:
        """이름·판 정보 변경을 기록한다."""
        self._enter("update", doc_id, name, edition)


class FakeEvaluation(_Fake):
    """EvaluationService의 가짜다."""

    async def evaluate(self, case: EvaluationCase) -> EvaluationResult:
        """평가 결과를 돌려준다."""
        self._enter("evaluate", case)
        return self.returns.get("evaluate", evaluation_result())


class FakeLifecycle(_Fake):
    """LifecycleService의 가짜다. 기동 방식을 정할 수 있다."""

    def __init__(
        self,
        *,
        ready: bool = True,
        startup: str = "ok",
        startup_error: BaseException | None = None,
    ) -> None:
        """기동 방식은 "ok"(바로 끝남), "block"(release까지 대기), "fail"(예외)이다."""
        super().__init__()
        self.ready = ready
        self.mode = startup
        self.startup_error = startup_error or RuntimeError("기동 실패")
        # ★ 막힌 기동을 풀 때 쓴다. 다른 스레드(이벤트 루프)와 공유하므로 threading.Event다
        self.release = threading.Event()
        self.startup_started = False
        self.startup_finished = False  # 기동이 성공으로 끝났다
        self.startup_ended = False  # 성공·실패·취소를 가리지 않고 끝났다
        self.shutdown_calls = 0
        self.shutdown_finished = False  # shutdown이 양보한 뒤 끝까지 실행됐다
        self.health_seen: list[bool] = []  # health가 불린 시점의 startup_finished

    async def startup(self) -> None:
        """정한 방식대로 기동한다. block은 상한 5초를 넘으면 TimeoutError다."""
        self.calls.append(("startup", ()))
        self.startup_started = True
        try:
            if self.mode == "block":
                deadline = time.monotonic() + WAIT_LIMIT
                while not self.release.is_set():
                    if time.monotonic() > deadline:
                        raise TimeoutError("가짜 기동 대기가 상한을 넘었다")
                    await asyncio.sleep(0.01)
            elif self.mode == "fail":
                raise self.startup_error
            self.startup_finished = True
        finally:
            self.startup_ended = True

    async def shutdown(self) -> None:
        """종료 호출을 세고, 이벤트 루프에 양보한 뒤에야 끝 표시를 세운다.

        ★ 양보 없이 끝나면 기다렸는지(await) 던져 두었는지(create_task)를 구분할 수 없다.
        """
        self.calls.append(("shutdown", ()))
        self.shutdown_calls += 1
        await asyncio.sleep(0.05)
        self.shutdown_finished = True

    async def health(self) -> Health:
        """연결 상태를 돌려주고, 이때의 기동 완료 여부를 기록한다."""
        self._enter("health")
        self.health_seen.append(self.startup_finished)
        return self.returns.get("health", Health(True, True))


class FakeServices:
    """가짜 일곱 개와, 그것을 `Services`로 끼운 묶음이다."""

    def __init__(self, lifecycle: FakeLifecycle | None = None) -> None:
        """가짜 서비스를 만들어 Services에 cast로 끼운다."""
        self.lifecycle = lifecycle or FakeLifecycle()
        self.caption = FakeCaption()
        self.index = FakeIndex()
        self.search = FakeSearch()
        self.delete = FakeDelete()
        self.metadata = FakeMetadata()
        self.evaluation = FakeEvaluation()
        self.services = Services(
            lifecycle=cast(LifecycleService, self.lifecycle),
            caption=cast(CaptionService, self.caption),
            index=cast(IndexService, self.index),
            search=cast(SearchService, self.search),
            delete=cast(DeleteService, self.delete),
            metadata=cast(MetadataService, self.metadata),
            evaluation=cast(EvaluationService, self.evaluation),
        )

    def _business(self) -> list[_Fake]:
        """lifecycle을 뺀 가짜 여섯 개다."""
        return [self.caption, self.index, self.search, self.delete, self.metadata, self.evaluation]

    def total_calls(self, *, include_lifecycle: bool = False) -> int:
        """모든 가짜의 호출 수 합이다. lifecycle은 고를 때만 센다."""
        total = sum(len(fake.calls) for fake in self._business())
        return total + (len(self.lifecycle.calls) if include_lifecycle else 0)

    def fake(self, attr: str) -> _Fake:
        """이름으로 가짜 하나를 돌려준다."""
        return cast(_Fake, getattr(self, attr))

    def only_call(self, attr: str, method: str) -> tuple[Any, ...]:
        """그 가짜의 그 메서드만 정확히 한 번 불렸는지 확인하고 받은 인자를 돌려준다."""
        assert self.total_calls(include_lifecycle=True) == 1, "정확히 한 번만 불려야 한다"
        calls = self.fake(attr).calls
        assert len(calls) == 1, f"{attr}가 한 번 불려야 한다"
        assert calls[0][0] == method, f"{attr}.{method}가 불려야 하는데 {calls[0][0]}이 불렸다"
        return calls[0][1]


# ── 표본 데이터 ───────────────────────────────────────────────────


def job_view(
    *,
    job_id: str = "job-1",
    state: JobState = JobState.QUEUED,
    stage: JobStage | None = None,
    failure: JobFailureInfo | None = None,
    result: IndexOutcome | None = None,
) -> JobView:
    """작업 상태 표본을 만든다."""
    return JobView(job_id, "doc-1", "3", state, stage, failure, result)


def job_failure(location: FailureLocation | None) -> JobFailureInfo:
    """위치만 다른 실패 사유 표본을 만든다."""
    return JobFailureInfo("CHUNKING_FAILED", "절 분할에 실패했습니다", location)


def hit_with_edition() -> SearchHit:
    """판 정보가 있고 분할 조각, 앞뒤 청크가 있는 검색 결과다."""
    return SearchHit(
        rank=1,
        score=0.87,
        doc_id="doc-1",
        version="3",
        heading_path=("인증서", "갱신"),
        name="IEEE 1609.2.1",
        edition=ResultEdition("2025", date(2025, 1, 31), True),
        other_editions_in_results=True,
        chunks=(
            ResultChunk(
                "c-1", ChunkKind.TEXT, "갱신 절차 [[minerva:table:t1 | 표]]", ("t1",), 1, 2
            ),
            ResultChunk("c-2", ChunkKind.TEXT, "두 번째 조각", (), 2, 2),
        ),
        before=(ResultChunk("c-0", ChunkKind.ASSET, "표 원문", ("t1",), None, None),),
        after=(ResultChunk("c-3", ChunkKind.TEXT, "뒤 청크", (), None, None),),
    )


def hit_without_edition() -> SearchHit:
    """판 정보가 없고 표 청크 하나만 있는 검색 결과다."""
    return SearchHit(
        rank=2,
        score=0.5,
        doc_id="doc-2",
        version="1",
        heading_path=(),
        name="판 없는 문서",
        edition=None,
        other_editions_in_results=False,
        chunks=(ResultChunk("c-9", ChunkKind.ASSET, "표 요약 문장", ("t2",), None, None),),
        before=(),
        after=(),
    )


def document_chunks_full() -> DocumentChunks:
    """이름·판이 있고 본문·표 청크가 하나씩 있는 문서 청크 목록이다."""
    return DocumentChunks(
        doc_id="doc-1",
        version="3",
        name="문서 이름",
        edition=Edition("2025", date(2025, 1, 31)),
        chunks=(
            DocumentChunk(
                "c-1", 0, ChunkKind.TEXT, ("설치",), "제목", "요약", "본문", (), None, None
            ),
            DocumentChunk(
                "c-2",
                1,
                ChunkKind.ASSET,
                ("설치",),
                None,
                None,
                "[[minerva:table:t1 | 표]]",
                ("t1",),
                2,
                2,
            ),
        ),
    )


def evaluation_result() -> EvaluationResult:
    """base는 적중 없음, expanded는 2위 적중인 평가 결과다."""
    return EvaluationResult(
        n=5,
        base=EvaluationMetrics(
            hit_at_1=False,
            hit_at_3=False,
            hit_at_5=False,
            hit_at_n=False,
            rank=None,
            reciprocal_rank=0.0,
            coverage=0.25,
        ),
        expanded=EvaluationMetrics(
            hit_at_1=False,
            hit_at_3=True,
            hit_at_5=True,
            hit_at_n=True,
            rank=2,
            reciprocal_rank=0.5,
            coverage=1.0,
        ),
    )


# ── 요청 도우미 ───────────────────────────────────────────────────

# API.md 색인 요청 예시 본문이다
INDEX_BODY: dict[str, Any] = {
    "doc_id": "3f2b8c1e-5d4a-4e7b-9c6f-0a1b2c3d4e5f",
    "version": "3",
    "markdown": "# 설치\n\n[[minerva:table:t1 | 환경 변수 표]]",
    "assets": [{"placeholder_id": "t1", "text": "환경 변수별 타입과 기본값을 정리한 표"}],
    "name": "IEEE 1609.2.1",
    "edition": {"label": "2025", "edition_date": "2025-01-31"},
    "chunking": "semantic",
    "force": False,
}

# 필수 필드만 있는 색인 요청 본문이다
MINIMAL_INDEX_BODY: dict[str, Any] = {
    "doc_id": "doc-1",
    "version": "1",
    "markdown": "# 제목",
    "assets": [],
    "name": "문서",
}

EDITION_BODY = {"label": "2025", "edition_date": "2025-01-31"}
IMAGE_BYTES = bytes(range(256))


def index_body(**override: Any) -> dict[str, Any]:
    """필수 필드만 있는 색인 요청 본문에 값을 덮어쓴다."""
    return {**MINIMAL_INDEX_BODY, **override}


def without(body: dict[str, Any], key: str) -> dict[str, Any]:
    """본문에서 키 하나를 뺀 사본이다."""
    return {k: v for k, v in body.items() if k != key}


def send(
    client: TestClient,
    method: str,
    path: str,
    *,
    token: bool = True,
    headers: dict[str, str] | None = None,
    **kwargs: Any,
) -> Response:
    """요청을 보낸다. 기본으로 올바른 토큰을 담는다."""
    merged = {**(AUTH if token else {}), **(headers or {})}
    return client.request(method, path, headers=merged, **kwargs)


@dataclass(frozen=True)
class Endpoint:
    """상태 확인을 뺀 엔드포인트 하나의 정상 요청이다."""

    name: str
    method: str
    path: str
    kwargs: dict[str, Any] = field(default_factory=dict[str, Any])
    status: int = 200
    fake: str = ""  # FakeServices의 속성 이름
    call: str = ""  # 불려야 하는 가짜 메서드 이름


ENDPOINTS: tuple[Endpoint, ...] = (
    Endpoint(
        "table_caption",
        "POST",
        "/v1/captions/table",
        {"json": {"table_markdown": "| a | b |"}},
        200,
        "caption",
        "summarize_table",
    ),
    Endpoint(
        "image_caption",
        "POST",
        "/v1/captions/image",
        {"files": {"image": ("a.png", IMAGE_BYTES, "image/png")}},
        200,
        "caption",
        "caption_image",
    ),
    Endpoint(
        "index_job",
        "POST",
        "/v1/index-jobs",
        {"json": INDEX_BODY},
        202,
        "index",
        "submit",
    ),
    Endpoint("get_job", "GET", "/v1/index-jobs/job-1", {}, 200, "index", "get_job"),
    Endpoint("delete", "DELETE", "/v1/documents/doc-1", {}, 204, "delete", "delete"),
    Endpoint(
        "index_state",
        "GET",
        "/v1/documents/doc-1/index-state",
        {},
        200,
        "index",
        "index_state",
    ),
    Endpoint(
        "index_states",
        "POST",
        "/v1/documents/index-states",
        {"json": {"doc_ids": ["a", "b"]}},
        200,
        "index",
        "index_states",
    ),
    Endpoint(
        "metadata",
        "PUT",
        "/v1/documents/doc-1/metadata",
        {"json": {"name": "새 이름", "edition": None}},
        204,
        "metadata",
        "update",
    ),
    Endpoint(
        "document_chunks",
        "GET",
        "/v1/documents/doc-1/chunks",
        {},
        200,
        "search",
        "document_chunks",
    ),
    Endpoint(
        "search",
        "POST",
        "/v1/search",
        {"json": {"query": "인증서 갱신 절차"}},
        200,
        "search",
        "search",
    ),
    Endpoint(
        "evaluation",
        "POST",
        "/v1/evaluations",
        {"json": {"query": "질의", "doc_id": "doc-1", "answer_span": "정답 구간"}},
        200,
        "evaluation",
        "evaluate",
    ),
)

ENDPOINT_BY_NAME = {ep.name: ep for ep in ENDPOINTS}


def send_endpoint(
    client: TestClient, ep: Endpoint, *, token: bool = True, headers: dict[str, str] | None = None
) -> Response:
    """엔드포인트의 정상 요청을 보낸다."""
    return send(client, ep.method, ep.path, token=token, headers=headers, **ep.kwargs)


# ── 프로세스 종료 기록 ────────────────────────────────────────────


@dataclass(frozen=True)
class ExitCall:
    """가로챈 프로세스 종료 호출 하나다. via는 어느 경로로 불렸는지다."""

    via: str
    args: tuple[Any, ...]
    kwargs: dict[str, Any]

    @property
    def code(self) -> int | None:
        """종료 코드를 돌려준다. 정수 인자가 없으면 알 수 없으므로 None이다."""
        candidates = [*self.args, *self.kwargs.values()]
        return next((v for v in candidates if isinstance(v, int)), None)


# ── 대기 도우미 ───────────────────────────────────────────────────


def wait_until(condition: Callable[[], bool], limit: float = WAIT_LIMIT) -> None:
    """조건이 참이 될 때까지 짧게 쉬며 기다린다. 상한을 넘으면 AssertionError다."""
    deadline = time.monotonic() + limit
    while not condition():
        assert time.monotonic() < deadline, "조건이 상한 시간 안에 참이 되지 않았다"
        time.sleep(0.01)


@contextmanager
def lifespan_client(fakes: FakeServices, app: FastAPI | None = None) -> Iterator[TestClient]:
    """lifespan을 돌리는 테스트 클라이언트다. 나가기 전에 막힌 기동을 반드시 푼다."""
    target = app if app is not None else create_app(fakes.services)
    try:
        with TestClient(target, raise_server_exceptions=False) as client:
            try:
                yield client
            finally:
                # ★ 구현이 기동 중 종료를 어떻게 다루든 테스트가 같게 끝나도록 먼저 푼다
                fakes.lifecycle.release.set()
    finally:
        fakes.lifecycle.release.set()


# ── 로그 도우미 ───────────────────────────────────────────────────

# 구조화 로그의 스택 표지는 내용 필드가 아니다
_META_KEYS = {"event", "log_level", "exc_info"}


def events_named(logs: list[Any], event: str) -> list[dict[str, Any]]:
    """이벤트명이 같은 로그 항목만 돌려준다."""
    return [entry for entry in logs if entry.get("event") == event]


def assert_event(
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


def api_events(logs: list[Any]) -> list[dict[str, Any]]:
    """`api.`로 시작하는 이벤트만 돌려준다."""
    return [e for e in logs if str(e.get("event", "")).startswith("api.")]


# ── 원시 ASGI 도우미 ──────────────────────────────────────────────


@dataclass(frozen=True)
class RawResult:
    """원시 ASGI 호출의 결과다."""

    status: int
    body: dict[str, Any]
    receive_calls: int


def call_raw(
    app: Any,
    method: str,
    path: str,
    headers: dict[str, str],
    chunks: Sequence[bytes],
    *,
    block_after: bool = True,
    limit: float = WAIT_LIMIT,
) -> RawResult:
    """ASGI 앱을 직접 부른다. 본문을 조각으로 주다가 다 주면 영원히 기다린다.

    본문을 끝까지 읽으려는 구현은 여기서 멈추고, 상한(limit)을 넘으면 TimeoutError다.
    """
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    sent: list[dict[str, Any]] = []
    received = 0

    async def receive() -> dict[str, Any]:
        nonlocal received
        index = received
        received += 1
        if index < len(chunks):
            return {"type": "http.request", "body": chunks[index], "more_body": True}
        if block_after:
            await asyncio.Event().wait()  # ★ 영원히 기다린다
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send_message(message: dict[str, Any]) -> None:
        sent.append(message)

    async def main() -> None:
        await asyncio.wait_for(app(scope, receive, send_message), limit)

    asyncio.run(main())
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return RawResult(status, json.loads(raw) if raw else {}, received)
