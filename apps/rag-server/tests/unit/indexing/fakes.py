"""indexing 단위 테스트의 가짜 ModelHub·ChunkStore와 만들기·읽기 도우미 (대체 경계)."""

import asyncio
import hashlib
from collections.abc import Callable, Collection, Coroutine, Mapping, Sequence
from dataclasses import replace
from datetime import date
from typing import Any, cast

import pytest

from minerva_rag.core import (
    Chunk,
    ChunkingResult,
    ChunkKind,
    ChunkRecord,
    Edition,
    Settings,
    SparseVector,
    StoreUnavailableError,
    find_placeholders,
)
from minerva_rag.indexing import EmbeddedChunks, Indexer, IndexInput
from minerva_rag.resource import ChunkStore, ModelHub

from ..resource.fakes import open_store

DIM = 8
BACKENDS = ["fake", "qdrant_memory"]
WRITE_METHODS = frozenset(
    {
        "upsert",
        "activate_records",
        "delete_records_except",
        "delete_records",
        "delete_document",
        "set_document_metadata",
        "set_latest_editions",
    }
)


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    """코루틴을 새 이벤트 루프에서 실행한다."""
    return asyncio.run(coro)


# ── 가짜 벡터 ─────────────────────────────────────────────────────


def dense_of(text: str) -> list[float]:
    """텍스트마다 다른 8차원 비영(非零) 벡터를 만든다."""
    digest = hashlib.sha256(text.encode()).digest()
    return [(b + 1) / 256 for b in digest[:DIM]]


def sparse_of(text: str) -> SparseVector:
    """텍스트마다 다른 키워드 벡터를 만든다."""
    digest = hashlib.sha256(text.encode()).digest()
    indices = tuple(sorted(set(digest[:4])))
    return SparseVector(indices=indices, values=tuple(1.0 for _ in indices))


# ── 가짜 ModelHub ─────────────────────────────────────────────────


class FakeModelHub:
    """indexing이 쓰는 ModelHub 표면만 흉내 내고 받은 텍스트를 기록한다."""

    def __init__(self, embedding_model_name: str = "fake-embed") -> None:
        self.embedding_model_name = embedding_model_name
        self.dense_inputs: list[list[str]] = []
        self.sparse_inputs: list[list[str]] = []
        self.fail: dict[str, BaseException] = {}

    @property
    def calls(self) -> int:
        """모델 호출 수의 합이다."""
        return len(self.dense_inputs) + len(self.sparse_inputs)

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """텍스트마다 가짜 dense 벡터를 돌려준다."""
        self.dense_inputs.append(list(texts))
        if "embed_documents" in self.fail:
            raise self.fail["embed_documents"]
        return [dense_of(t) for t in texts]

    async def encode_sparse_documents(self, texts: Sequence[str]) -> list[SparseVector]:
        """텍스트마다 가짜 키워드 벡터를 돌려준다."""
        self.sparse_inputs.append(list(texts))
        if "encode_sparse_documents" in self.fail:
            raise self.fail["encode_sparse_documents"]
        return [sparse_of(t) for t in texts]

    def all_dense_texts(self) -> list[str]:
        """dense 호출에 넘긴 모든 텍스트를 이어서 돌려준다."""
        return [t for batch in self.dense_inputs for t in batch]

    def all_sparse_texts(self) -> list[str]:
        """키워드 호출에 넘긴 모든 텍스트를 이어서 돌려준다."""
        return [t for batch in self.sparse_inputs for t in batch]


# ── 가짜 ChunkStore ───────────────────────────────────────────────


class FakeChunkStore:
    """resource MODULE.md 「저장소 연결」의 의미를 흉내 낸다. 호출 기록·실패 주입을 지원한다."""

    def __init__(self) -> None:
        self.records: dict[str, ChunkRecord] = {}
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.fail: dict[str, BaseException] = {}
        self.partial_upsert: int | None = None
        self.down_after_failure = False
        self.before: dict[str, Callable[[FakeChunkStore], None]] = {}
        self._down = False

    async def _enter(self, method: str, args: tuple[object, ...]) -> None:
        """호출을 기록하고 양보한 뒤, 훅과 실패 주입을 처리한다."""
        self.calls.append((method, args))
        await asyncio.sleep(0)
        hook = self.before.get(method)
        if hook is not None:
            hook(self)
        if self._down and method in WRITE_METHODS:
            raise StoreUnavailableError()
        error = self.fail.get(method)
        if error is not None:
            if self.down_after_failure:
                self._down = True
            raise error

    def writes(self) -> list[tuple[str, tuple[object, ...]]]:
        """쓰기 메서드 호출만 돌려준다."""
        return [c for c in self.calls if c[0] in WRITE_METHODS]

    def snapshot(self) -> dict[str, ChunkRecord]:
        """저장된 레코드의 사본을 돌려준다."""
        return dict(self.records)

    async def upsert(
        self,
        records: Sequence[ChunkRecord],
        dense: Sequence[Sequence[float]],
        sparse: Sequence[SparseVector],
    ) -> None:
        """레코드를 chunk_id로 덮어쓴다."""
        if not len(records) == len(dense) == len(sparse):
            raise ValueError("길이가 다릅니다")
        self.calls.append(("upsert", (tuple(records),)))
        await asyncio.sleep(0)
        hook = self.before.get("upsert")
        if hook is not None:
            hook(self)
        if self._down:
            raise StoreUnavailableError()
        error = self.fail.get("upsert")
        if error is not None:
            keep = self.partial_upsert if self.partial_upsert is not None else 0
            for record in list(records)[:keep]:
                self.records[record.chunk_id] = record
            if self.down_after_failure:
                self._down = True
            raise error
        for record in records:
            self.records[record.chunk_id] = record

    async def activate_records(self, doc_id: str, chunk_ids: Collection[str]) -> None:
        """그 문서에서 chunk_ids에 든 레코드를 active로 바꾼다."""
        await self._enter("activate_records", (doc_id, frozenset(chunk_ids)))
        for cid in chunk_ids:
            record = self.records.get(cid)
            if record is not None and record.doc_id == doc_id:
                self.records[cid] = replace(record, active=True)

    async def delete_records_except(self, doc_id: str, chunk_ids: Collection[str]) -> None:
        """그 문서에서 chunk_ids에 없는 레코드를 지운다."""
        await self._enter("delete_records_except", (doc_id, frozenset(chunk_ids)))
        keep = set(chunk_ids)
        for cid, record in list(self.records.items()):
            if record.doc_id == doc_id and cid not in keep:
                del self.records[cid]

    async def delete_records(self, chunk_ids: Collection[str]) -> None:
        """그 ID의 레코드만 지운다."""
        await self._enter("delete_records", (frozenset(chunk_ids),))
        for cid in chunk_ids:
            self.records.pop(cid, None)

    async def delete_document(self, doc_id: str) -> None:
        """그 문서의 레코드를 모두 지운다."""
        await self._enter("delete_document", (doc_id,))
        for cid, record in list(self.records.items()):
            if record.doc_id == doc_id:
                del self.records[cid]

    async def set_document_metadata(self, doc_id: str, name: str, edition: Edition | None) -> None:
        """그 문서 모든 레코드의 이름·판을 바꾼다."""
        await self._enter("set_document_metadata", (doc_id, name, edition))
        for cid, record in list(self.records.items()):
            if record.doc_id == doc_id:
                self.records[cid] = replace(record, name=name, edition=edition)

    async def set_latest_editions(self, name: str, latest_doc_ids: frozenset[str]) -> None:
        """이름이 같은 active 레코드의 최신판 표시를 맞춘다."""
        await self._enter("set_latest_editions", (name, frozenset(latest_doc_ids)))
        for cid, record in list(self.records.items()):
            if record.active and record.name == name:
                self.records[cid] = replace(
                    record, is_latest_edition=record.doc_id in latest_doc_ids
                )

    async def active_records(self, doc_id: str) -> list[ChunkRecord]:
        """그 문서의 active 레코드를 돌려준다."""
        await self._enter("active_records", (doc_id,))
        return [r for r in self.records.values() if r.doc_id == doc_id and r.active]

    async def active_editions(self, name: str) -> dict[str, Edition | None]:
        """이름이 같은 active 레코드의 문서별 판 정보를 돌려준다."""
        await self._enter("active_editions", (name,))
        found = {r.doc_id: r.edition for r in self.records.values() if r.active and r.name == name}
        await asyncio.sleep(0)  # ★ 잠금이 없으면 다른 재계산이 끼어들 틈이다
        return found

    async def job_records(self, doc_id: str, job_id: str) -> list[ChunkRecord]:
        """그 문서에서 job_id가 같은 레코드를 active 여부와 관계없이 돌려준다."""
        await self._enter("job_records", (doc_id, job_id))
        return [r for r in self.records.values() if r.doc_id == doc_id and r.job_id == job_id]


def as_store(fake: FakeChunkStore) -> ChunkStore:
    """가짜를 ChunkStore로 넘긴다."""
    return cast(ChunkStore, fake)


def as_hub(fake: object) -> ModelHub:
    """가짜를 ModelHub로 넘긴다."""
    return cast(ModelHub, fake)


async def make_store(backend: str, monkeypatch: pytest.MonkeyPatch) -> ChunkStore:
    """backend가 "fake"면 가짜, "qdrant_memory"면 인메모리 Qdrant 위의 실제 저장소를 만든다."""
    if backend == "fake":
        return as_store(FakeChunkStore())
    store, _client = await open_store(monkeypatch, dimension=DIM)
    return store


# ── 상태 읽기 ─────────────────────────────────────────────────────


async def active_ids(store: ChunkStore, doc_id: str) -> set[str]:
    """그 문서의 active 레코드 chunk_id 집합이다."""
    return {r.chunk_id for r in await store.active_records(doc_id)}


async def job_ids(store: ChunkStore, doc_id: str, job_id: str) -> set[str]:
    """그 문서의 그 작업 레코드 chunk_id 집합이다(active 무관)."""
    return {r.chunk_id for r in await store.job_records(doc_id, job_id)}


async def latest_of(store: ChunkStore, doc_id: str) -> set[bool]:
    """그 문서 active 레코드의 is_latest_edition 값 집합이다."""
    return {r.is_latest_edition for r in await store.active_records(doc_id)}


async def seed(store: ChunkStore, records: Sequence[ChunkRecord]) -> None:
    """레코드를 텍스트로 만든 벡터와 함께 그대로 저장한다."""
    await store.upsert(
        list(records),
        [dense_of(r.chunk.text) for r in records],
        [sparse_of(r.chunk.text) for r in records],
    )


# ── 만들기 도우미 ─────────────────────────────────────────────────


def text_chunk(key: str, text: str, order: int = 0) -> Chunk:
    """본문 청크를 만든다."""
    return Chunk(
        chunk_key=key,
        kind=ChunkKind.TEXT,
        order=order,
        heading_path=("절",),
        title="제목",
        summary="요약",
        text=text,
        placeholder_ids=tuple(p.placeholder_id for p in find_placeholders(text)),
        split_group=None,
        split_index=None,
        split_total=None,
    )


def asset_chunk(key: str, kind: str, pid: str, desc: str, order: int = 0) -> Chunk:
    """표·이미지 청크를 만든다."""
    return Chunk(
        chunk_key=key,
        kind=ChunkKind.ASSET,
        order=order,
        heading_path=("절",),
        title=None,
        summary=None,
        text=f"[[minerva:{kind}:{pid} | {desc}]]",
        placeholder_ids=(pid,),
        split_group=None,
        split_index=None,
        split_total=None,
    )


def make_input(
    *,
    doc_id: str = "doc-1",
    version: str = "v1",
    job_id: str = "job-1",
    assets: Mapping[str, str] | None = None,
    name: str = "인증 가이드",
    edition: Edition | None = None,
    chunking_mode: str = "semantic",
    markdown: str = "",
) -> IndexInput:
    """IndexInput을 만든다."""
    return IndexInput(
        doc_id=doc_id,
        version=version,
        job_id=job_id,
        markdown=markdown,
        assets=assets if assets is not None else {},
        name=name,
        edition=edition,
        chunking_mode=chunking_mode,
    )


def edition(year: int) -> Edition:
    """연도로 만든 판 정보다."""
    return Edition(str(year), date(year, 3, 1))


def chunking_result(chunks: Sequence[Chunk]) -> ChunkingResult:
    """청크 목록으로 chunking 결과를 만든다."""
    return ChunkingResult(chunks=tuple(chunks), fallback_used=False)


def make_indexer(
    store: ChunkStore, settings: Settings, hub: FakeModelHub | None = None
) -> tuple[Indexer, FakeModelHub]:
    """가짜 모델 허브와 함께 Indexer를 만든다."""
    fake_hub = hub if hub is not None else FakeModelHub()
    return Indexer(as_hub(fake_hub), store, settings), fake_hub


async def index_version(
    indexer: Indexer,
    *,
    doc_id: str,
    version: str,
    job_id: str,
    name: str,
    edition: Edition | None,
    chunks: Sequence[Chunk],
    assets: Mapping[str, str] | None = None,
) -> tuple[EmbeddedChunks, int]:
    """embed 뒤 write까지 해서 한 버전을 색인한다."""
    inp = make_input(
        doc_id=doc_id,
        version=version,
        job_id=job_id,
        name=name,
        edition=edition,
        assets=assets,
    )
    embedded = await indexer.embed(inp, chunking_result(chunks))
    written = await indexer.write(embedded)
    return embedded, written


def plain_chunks(prefix: str, count: int) -> list[Chunk]:
    """자리표시 없는 본문 청크 count개를 만든다."""
    return [text_chunk(f"{prefix}-{i}", f"{prefix} 본문 {i}", order=i) for i in range(count)]


def ids_of(embedded: EmbeddedChunks) -> set[str]:
    """EmbeddedChunks 레코드의 chunk_id 집합이다."""
    return {r.chunk_id for r in embedded.records}


def make_record(
    chunk_id: str,
    *,
    doc_id: str,
    version: str,
    job_id: str,
    active: bool,
    name: str,
    edition: Edition | None,
    is_latest: bool = False,
    text: str = "본문",
) -> ChunkRecord:
    """직접 상태를 만들 때 쓰는 레코드다."""
    return ChunkRecord(
        chunk_id=chunk_id,
        doc_id=doc_id,
        version=version,
        job_id=job_id,
        active=active,
        name=name,
        edition=edition,
        is_latest_edition=is_latest,
        chunk=text_chunk(f"k-{chunk_id}", f"{text} {chunk_id}"),
    )


def expected_index_text(chunk: Chunk, assets: Mapping[str, str]) -> str:
    """MODULE.md 3.1.1의 색인 텍스트를 테스트 쪽에서 계산한다."""
    if chunk.kind == ChunkKind.ASSET:
        return assets[chunk.placeholder_ids[0]]
    text = chunk.text
    for placeholder in find_placeholders(chunk.text):
        text = text.replace(placeholder.raw, assets[placeholder.placeholder_id])
    return text
