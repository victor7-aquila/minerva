"""resource 단위 테스트가 공유하는 가짜 객체와 헬퍼 (대체 경계)."""

import asyncio
import json
import threading
from collections.abc import Awaitable, Callable, Coroutine
from datetime import date
from typing import Any

import httpx
import minerva_rag.resource.chunk_store as chunk_store_module
import minerva_rag.resource.model_hub as model_hub_module
import ollama
import pytest
from qdrant_client import AsyncQdrantClient
from qdrant_client.http.exceptions import ResponseHandlingException

from minerva_rag.core import (
    Chunk,
    ChunkKind,
    ChunkRecord,
    Edition,
    Settings,
    SparseVector,
    get_settings,
)
from minerva_rag.resource import ChunkFilter, ChunkStore, ModelHub

OLLAMA_URL = "http://ollama.test:11434"
COLLECTION = "minerva_chunks"  # ★ MODULE.md 「런타임·보안」이 정한 컬렉션 이름
TEXT_BODY = "인증서는 만료 30일 전부터 갱신을 요청한다."
TEXT_TITLE = "인증서 갱신"
TEXT_SUMMARY = "인증서 갱신 절차를 요약한다"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    """코루틴을 새 이벤트 루프에서 실행한다."""
    return asyncio.run(coro)


# ── 가짜 Ollama (httpx.MockTransport) ─────────────────────────────


class FakeOllama:
    """Ollama HTTP API를 흉내 내고 받은 요청을 기록한다."""

    def __init__(self, models: set[str], mode: str = "ok", response_text: str = "응답") -> None:
        self.models = models
        self.mode = mode  # "ok" | "refuse" | "connect_timeout" | "error"
        self.response_text = response_text
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        """요청 하나에 응답한다."""
        path = request.url.path
        body: dict[str, Any] = json.loads(request.content) if request.content else {}
        self.requests.append((path, body))
        if self.mode == "refuse":
            raise httpx.ConnectError("refused")
        if self.mode == "connect_timeout":
            raise httpx.ConnectTimeout("timeout")
        if path == "/api/show":
            name = body.get("model") or body.get("name")
            if name in self.models:
                return httpx.Response(200, json={"model_info": {}})
            return httpx.Response(404, json={"error": "model not found"})
        if path == "/api/tags":
            listed = [{"model": n, "name": n} for n in self.models]
            return httpx.Response(200, json={"models": listed})
        if path == "/api/pull":
            return httpx.Response(200, json={"status": "success"})
        if path == "/api/generate":
            if self.mode == "error":
                return httpx.Response(500, json={"error": "boom"})
            return httpx.Response(
                200,
                json={"model": body.get("model"), "response": self.response_text, "done": True},
            )
        return httpx.Response(404, json={"error": "not found"})

    def client(self) -> ollama.AsyncClient:
        """이 가짜에 연결된 Ollama 클라이언트를 만든다."""
        return ollama.AsyncClient(host=OLLAMA_URL, transport=httpx.MockTransport(self.handler))

    def generate_requests(self) -> list[dict[str, Any]]:
        """생성 요청 본문만 돌려준다."""
        return [body for path, body in self.requests if path == "/api/generate"]


# ── 가짜 임베딩·재정렬 모델 ───────────────────────────────────────


class _Array(list[Any]):
    """numpy 배열처럼 tolist()를 가진 목록이다."""

    def tolist(self) -> list[Any]:
        """중첩 목록을 일반 목록으로 바꾼다."""
        return [x.tolist() if isinstance(x, _Array) else x for x in self]


class FakeTokenizer:
    """공백으로 나눈 단어 수를 센다. 특수 토큰을 붙이면 2개를 더한다."""

    def encode(self, text: str, add_special_tokens: bool = True) -> list[int]:
        """토큰 ID 목록을 돌려준다."""
        count = len(text.split()) + (2 if add_special_tokens else 0)
        return list(range(count))

    def __call__(self, text: str, **kwargs: Any) -> dict[str, list[int]]:
        """HF 토크나이저 호출 형태를 흉내 낸다."""
        add = bool(kwargs.get("add_special_tokens", True))
        return {"input_ids": self.encode(text, add_special_tokens=add)}


class FakeEmbedder:
    """sentence-transformers 임베딩 모델의 표면을 흉내 낸다."""

    def __init__(self, dimension: int = 8) -> None:
        self.dimension = dimension
        self.threads: list[int] = []
        self.calls: list[tuple[str, list[str]]] = []
        self.tokenizer = FakeTokenizer()

    def get_embedding_dimension(self) -> int | None:
        """임베딩 차원을 돌려준다."""
        return self.dimension

    def get_sentence_embedding_dimension(self) -> int | None:
        """구버전 이름의 차원 조회다."""
        return self.dimension

    def _vector(self, text: str) -> _Array:
        return _Array(float(len(text) + i) for i in range(self.dimension))

    def encode_document(self, inputs: Any, **kwargs: Any) -> _Array:
        """문서용 입력 형식으로 인코딩한다."""
        self.threads.append(threading.get_ident())
        texts = [inputs] if isinstance(inputs, str) else list(inputs)
        self.calls.append(("document", texts))
        return _Array(self._vector(t) for t in texts)

    def encode_query(self, inputs: Any, **kwargs: Any) -> _Array:
        """질의용 입력 형식으로 인코딩한다."""
        self.threads.append(threading.get_ident())
        texts = [inputs] if isinstance(inputs, str) else list(inputs)
        self.calls.append(("query", texts))
        if isinstance(inputs, str):
            return self._vector(inputs)
        return _Array(self._vector(t) for t in texts)


class FakeReranker:
    """sentence-transformers 재정렬 모델의 표면을 흉내 낸다. 지문 길이가 점수다."""

    def __init__(self) -> None:
        self.threads: list[int] = []

    def predict(self, pairs: Any, **kwargs: Any) -> _Array:
        """(질의, 지문) 쌍마다 점수를 돌려준다."""
        self.threads.append(threading.get_ident())
        return _Array(float(len(pair[1])) for pair in pairs)


class FakeModels:
    """임베딩·재정렬 가짜 한 쌍이다."""

    def __init__(self) -> None:
        self.embedder = FakeEmbedder()
        self.reranker = FakeReranker()


def install_fake_models(monkeypatch: pytest.MonkeyPatch, models: FakeModels) -> None:
    """sentence-transformers 로더를 가짜로 바꾼다."""
    monkeypatch.setattr(model_hub_module, "_load_embedding_model", lambda s: models.embedder)
    monkeypatch.setattr(model_hub_module, "_load_reranker_model", lambda s: models.reranker)


def install_failing_loader(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    """지정한 로더(`_load_embedding_model` 또는 `_load_reranker_model`)가 실패하게 한다."""

    def _fail(settings: Settings) -> object:
        raise OSError("not found")

    monkeypatch.setattr(model_hub_module, name, _fail)


def install_fake_ollama(monkeypatch: pytest.MonkeyPatch, fake: FakeOllama) -> None:
    """Ollama 클라이언트 팩토리를 가짜로 바꾼다."""
    monkeypatch.setattr(model_hub_module, "_create_ollama_client", lambda s: fake.client())


async def prepared_hub(settings: Settings) -> ModelHub:
    """prepare까지 끝난 ModelHub를 돌려준다. 가짜 설치는 호출 전에 끝나 있어야 한다."""
    hub = ModelHub(settings)
    await hub.prepare()
    return hub


# ── 로그 검사 ─────────────────────────────────────────────────────


def events_named(logs: list[Any], event: str) -> list[dict[str, Any]]:
    """이벤트명이 같은 로그 항목만 돌려준다."""
    return [entry for entry in logs if entry.get("event") == event]


def assert_log(logs: list[Any], event: str, level: str, allowed: set[str]) -> None:
    """이벤트가 있고, 레벨이 맞고, 필드 키가 허용 필드 안에 있는지 확인한다."""
    found = events_named(logs, event)
    assert found, f"{event} 로그가 없다"
    for entry in found:
        assert entry["log_level"] == level
        assert set(entry) - {"event", "log_level"} <= allowed


def assert_logs_exclude(logs: list[Any], forbidden: list[str]) -> None:
    """어떤 로그 값에도 금지 문자열이 들어 있지 않은지 확인한다."""
    for entry in logs:
        for key, value in entry.items():
            for text in forbidden:
                assert text not in repr(value), f"{key} 값에 금지 내용이 있다"


# ── Qdrant 대체 경계 ──────────────────────────────────────────────


class FlakyQdrant:
    """인메모리 클라이언트를 감싸고, down이면 코루틴 메서드가 전송 오류를 낸다."""

    def __init__(self, inner: AsyncQdrantClient) -> None:
        self.inner = inner
        self.down = False
        self.error: Exception | None = None  # 지정하면 전송 오류 대신 이 오류를 낸다

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self.inner, name)
        if name == "close" or name.startswith("_") or not callable(attr):
            return attr
        if not self.down and self.error is None:
            return attr

        async def _fail(*args: Any, **kwargs: Any) -> Any:
            if self.error is not None:
                raise self.error
            raise ResponseHandlingException(httpx.ConnectError("refused"))

        return _fail


def install_qdrant(monkeypatch: pytest.MonkeyPatch, client: Any) -> None:
    """Qdrant 클라이언트 팩토리가 같은 인스턴스를 돌려주게 한다."""
    monkeypatch.setattr(chunk_store_module, "_create_qdrant_client", lambda s: client)


async def open_store(
    monkeypatch: pytest.MonkeyPatch, *, dimension: int = 8
) -> tuple[ChunkStore, AsyncQdrantClient]:
    """인메모리 Qdrant에 연결된 ChunkStore와 원시 클라이언트를 돌려준다."""
    client = AsyncQdrantClient(location=":memory:")
    install_qdrant(monkeypatch, client)
    store = ChunkStore(get_settings())
    await store.connect(dimension)
    return store, client


# ── 레코드·벡터 생성 ──────────────────────────────────────────────


def make_record(
    chunk_id: str,
    *,
    doc_id: str = "doc-1",
    version: str = "v1",
    job_id: str = "job-1",
    active: bool = True,
    name: str = "인증 가이드",
    edition: Edition | None = None,
    is_latest_edition: bool = False,
    kind: ChunkKind = ChunkKind.TEXT,
    order: int = 0,
    text: str = TEXT_BODY,
    heading_path: tuple[str, ...] = ("설치",),
    split: tuple[str, int, int] | None = None,
) -> ChunkRecord:
    """테스트용 청크 레코드를 만든다."""
    is_text = kind == ChunkKind.TEXT
    chunk = Chunk(
        chunk_key=f"k-{chunk_id}",
        kind=kind,
        order=order,
        heading_path=heading_path,
        title=TEXT_TITLE if is_text else None,
        summary=TEXT_SUMMARY if is_text else None,
        text=text if is_text else "[[minerva:table:t1 | 표]]",
        placeholder_ids=() if is_text else ("t1",),
        split_group=split[0] if split else None,
        split_index=split[1] if split else None,
        split_total=split[2] if split else None,
    )
    return ChunkRecord(
        chunk_id=chunk_id,
        doc_id=doc_id,
        version=version,
        job_id=job_id,
        active=active,
        name=name,
        edition=edition,
        is_latest_edition=is_latest_edition,
        chunk=chunk,
    )


def make_edition(label: str) -> Edition:
    """라벨의 연도로 날짜를 만든 판 정보를 돌려준다."""
    return Edition(label, date(int(label), 3, 1))


def vec(i: int, dim: int = 8) -> list[float]:
    """i마다 방향이 다른 dense 벡터를 만든다."""
    return [1.0 if j == i % dim else 0.0 for j in range(dim)]


def sparse_for(i: int) -> SparseVector:
    """모든 레코드가 인덱스 1을 공유하고 그 값이 i+1인 키워드 벡터를 만든다."""
    return SparseVector(indices=(1, 100 + i), values=(float(i + 1), 1.0))


SPARSE_QUERY = SparseVector(indices=(1,), values=(1.0,))


async def seed(store: ChunkStore, records: list[ChunkRecord], start: int = 0) -> None:
    """레코드를 벡터와 함께 저장한다."""
    await store.upsert(
        records,
        [vec(start + i) for i in range(len(records))],
        [sparse_for(start + i) for i in range(len(records))],
    )


def by_id(records: list[ChunkRecord]) -> dict[str, ChunkRecord]:
    """chunk_id로 찾는 사전을 만든다."""
    return {r.chunk_id: r for r in records}


def ids(records: list[ChunkRecord]) -> set[str]:
    """chunk_id 집합을 돌려준다."""
    return {r.chunk_id for r in records}


def filter_data() -> list[ChunkRecord]:
    """ChunkFilter 검증용 네 문서(모두 active)를 만든다."""
    return [
        make_record("c-2022", doc_id="d-2022", name="표준", edition=make_edition("2022")),
        make_record(
            "c-2025",
            doc_id="d-2025",
            name="표준",
            edition=make_edition("2025"),
            is_latest_edition=True,
        ),
        make_record("c-plain", doc_id="d-plain", name="표준"),
        make_record("c-other", doc_id="d-other", name="기타"),
    ]


# ── 모든 쓰기·조회 메서드를 같은 입력 형태로 부르는 표 ────────────

StoreCall = Callable[[ChunkStore], Awaitable[object]]

STORE_CALLS: dict[str, StoreCall] = {
    "upsert": lambda s: s.upsert([make_record("c-1")], [vec(0)], [sparse_for(0)]),
    "activate_records": lambda s: s.activate_records("doc-1", {"c-1"}),
    "delete_records_except": lambda s: s.delete_records_except("doc-1", {"c-1"}),
    "delete_records": lambda s: s.delete_records({"c-1"}),
    "delete_document": lambda s: s.delete_document("doc-1"),
    "set_document_metadata": lambda s: s.set_document_metadata("doc-1", "새 이름", None),
    "set_latest_editions": lambda s: s.set_latest_editions("인증 가이드", frozenset({"doc-1"})),
    "search_dense": lambda s: s.search_dense(vec(0), ChunkFilter(), 5),
    "search_sparse": lambda s: s.search_sparse(SPARSE_QUERY, ChunkFilter(), 5),
    "active_records": lambda s: s.active_records("doc-1"),
    "active_editions": lambda s: s.active_editions("인증 가이드"),
    "job_records": lambda s: s.job_records("doc-1", "job-1"),
}
