"""search 단위 테스트의 가짜 ModelHub·ChunkStore와 만들기 도우미 (대체 경계)."""

import os
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

import pytest

from minerva_rag.core import (
    Chunk,
    ChunkKind,
    ChunkRecord,
    Edition,
    Settings,
    SparseVector,
)
from minerva_rag.resource import ChunkFilter, ChunkStore, ModelHub, ScoredRecord
from minerva_rag.search import Searcher

from ..resource.fakes import SPARSE_QUERY, make_edition, open_store, seed

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

# MODULE.md 「데이터 계약」의 예시 용어집이다
EXAMPLE_GLOSSARY = """\
terms:
  - canonical: 인증서
    synonyms: [certificate, cert, 인증 문서]
  - canonical: 폐기 목록
    synonyms: [CRL, certificate revocation list]
"""


# ── 가짜 ModelHub ─────────────────────────────────────────────────


class FakeSearchHub:
    """search가 쓰는 ModelHub 표면만 흉내 내고 호출을 기록한다."""

    def __init__(self) -> None:
        self.embed_inputs: list[str] = []
        self.sparse_inputs: list[str] = []
        self.rerank_calls: list[tuple[str, list[str]]] = []
        self.count_inputs: list[str] = []
        self.generate_calls: list[tuple[object, ...]] = []
        self.rerank_scores: dict[str, float] = {}  # 지문(청크 원문) → 점수, 없으면 0.0
        self.rerank_error: BaseException | None = None
        self.token_counts: dict[str, int] = {}  # 원문 → 토큰 수
        self.default_tokens = 10

    async def embed_query(self, text: str) -> list[float]:
        """입력을 기록하고 8차원 벡터를 돌려준다."""
        self.embed_inputs.append(text)
        return [1.0] * 8

    async def encode_sparse_query(self, text: str) -> SparseVector:
        """입력을 기록하고 모든 seed 레코드와 맞는 키워드 벡터를 돌려준다."""
        self.sparse_inputs.append(text)
        return SPARSE_QUERY

    async def rerank(self, query: str, passages: Sequence[str]) -> list[float]:
        """호출을 기록하고 지문마다 정해 둔 점수를 돌려준다. 오류가 정해져 있으면 낸다."""
        self.rerank_calls.append((query, list(passages)))
        if self.rerank_error is not None:
            raise self.rerank_error
        return [self.rerank_scores.get(p, 0.0) for p in passages]

    def count_tokens(self, text: str) -> int:
        """입력을 기록하고 정해 둔 토큰 수를 돌려준다(동기)."""
        self.count_inputs.append(text)
        return self.token_counts.get(text, self.default_tokens)

    async def generate(self, *args: object, **kwargs: object) -> str:
        """search는 생성을 부르면 안 된다. 기록하고 실패시킨다."""
        self.generate_calls.append(args)
        raise AssertionError("search는 generate를 부르면 안 된다")


# ── 가짜 ChunkStore ───────────────────────────────────────────────


class FakeSearchStore:
    """resource MODULE.md 「저장소 연결」의 조회 의미를 흉내 낸다. 순위는 대본으로 정한다."""

    def __init__(self) -> None:
        self.records: dict[str, ChunkRecord] = {}
        self.dense_order: list[str] | None = None  # None이면 삽입 순서
        self.sparse_order: list[str] | None = None
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.fail: dict[str, BaseException] = {}

    def add(self, *records: ChunkRecord) -> None:
        """레코드를 넣는다."""
        for record in records:
            self.records[record.chunk_id] = record

    @staticmethod
    def _matches(flt: ChunkFilter, record: ChunkRecord) -> bool:
        """active이고 필터 조건에 맞는지 본다."""
        if not record.active:
            return False
        if flt.doc_ids is not None and record.doc_id not in flt.doc_ids:
            return False
        if flt.edition_name is not None and not (
            record.name == flt.edition_name
            and record.edition is not None
            and record.edition.label == flt.edition_label
        ):
            return False
        return not (
            flt.latest_or_unversioned and not (record.is_latest_edition or record.edition is None)
        )

    def _scripted(
        self, order: list[str] | None, flt: ChunkFilter, limit: int
    ) -> list[ScoredRecord]:
        """대본 순서로 필터를 통과한 레코드에 내림차순 점수를 붙여 limit개까지 돌려준다."""
        ids = list(self.records) if order is None else order
        found = [self.records[i] for i in ids if i in self.records]
        matched = [r for r in found if self._matches(flt, r)]
        return [ScoredRecord(r, 1.0 - 0.01 * i) for i, r in enumerate(matched)][:limit]

    def _enter(self, method: str, args: tuple[object, ...]) -> None:
        """호출을 기록하고 주입한 실패를 낸다."""
        self.calls.append((method, args))
        error = self.fail.get(method)
        if error is not None:
            raise error

    async def search_dense(
        self, vector: Sequence[float], flt: ChunkFilter, limit: int
    ) -> list[ScoredRecord]:
        """dense 조회 대본을 돌려준다."""
        self._enter("search_dense", (vector, flt, limit))
        if limit < 1:
            raise ValueError("limit은 1 이상이어야 합니다")
        return self._scripted(self.dense_order, flt, limit)

    async def search_sparse(
        self, vector: SparseVector, flt: ChunkFilter, limit: int
    ) -> list[ScoredRecord]:
        """키워드 조회 대본을 돌려준다."""
        self._enter("search_sparse", (vector, flt, limit))
        if limit < 1:
            raise ValueError("limit은 1 이상이어야 합니다")
        return self._scripted(self.sparse_order, flt, limit)

    async def active_records(self, doc_id: str) -> list[ChunkRecord]:
        """그 문서의 active 레코드를 삽입 역순으로 돌려준다(순서 보장 없음을 흉내 낸다)."""
        self._enter("active_records", (doc_id,))
        found = [r for r in self.records.values() if r.doc_id == doc_id and r.active]
        return list(reversed(found))

    async def _write(self, method: str, *args: object) -> None:
        """쓰기 호출을 기록만 한다. 아무것도 바꾸지 않는다."""
        self.calls.append((method, args))

    async def upsert(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("upsert", *args)

    async def activate_records(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("activate_records", *args)

    async def delete_records_except(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("delete_records_except", *args)

    async def delete_records(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("delete_records", *args)

    async def delete_document(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("delete_document", *args)

    async def set_document_metadata(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("set_document_metadata", *args)

    async def set_latest_editions(self, *args: object) -> None:
        """기록만 한다."""
        await self._write("set_latest_editions", *args)

    def writes(self) -> list[tuple[str, tuple[object, ...]]]:
        """쓰기 메서드 호출만 돌려준다."""
        return [c for c in self.calls if c[0] in WRITE_METHODS]

    def count(self, method: str) -> int:
        """그 메서드가 불린 횟수다."""
        return len([c for c in self.calls if c[0] == method])

    def filters(self, method: str) -> list[ChunkFilter]:
        """그 조회 메서드에 넘어온 ChunkFilter 목록이다."""
        return [cast(ChunkFilter, c[1][1]) for c in self.calls if c[0] == method]


def as_store(fake: FakeSearchStore) -> ChunkStore:
    """가짜를 ChunkStore로 넘긴다."""
    return cast(ChunkStore, fake)


@asynccontextmanager
async def backend_store(
    backend: str, monkeypatch: pytest.MonkeyPatch, records: Sequence[ChunkRecord]
) -> AsyncIterator[ChunkStore]:
    """backend가 "fake"면 가짜, "qdrant_memory"면 인메모리 Qdrant 위의 실제 저장소를 연다."""
    if backend == "fake":
        fake = FakeSearchStore()
        fake.add(*records)
        yield as_store(fake)
        return
    store, _client = await open_store(monkeypatch)
    try:
        if records:
            await seed(store, list(records))
        yield store
    finally:
        await store.close()


# ── 만들기 도우미 ─────────────────────────────────────────────────


def _placeholder(pid: str) -> str:
    """표 자리표시 한 개를 만든다."""
    return f"[[minerva:table:{pid} | 표 {pid}]]"


def rec(
    chunk_id: str,
    *,
    doc_id: str = "doc-1",
    version: str = "v1",
    active: bool = True,
    name: str = "인증 가이드",
    edition: Edition | None = None,
    latest: bool = False,
    kind: ChunkKind = ChunkKind.TEXT,
    order: int = 0,
    text: str | None = None,
    heading_path: tuple[str, ...] = ("절",),
    split: tuple[str, int, int] | None = None,
    placeholder_ids: tuple[str, ...] | None = None,
    pid: str | None = None,
) -> ChunkRecord:
    """테스트용 청크 레코드를 만든다. 원문은 기본으로 레코드마다 다르다."""
    is_text = kind == ChunkKind.TEXT
    if is_text:
        ids = placeholder_ids or ()
        body = text if text is not None else " ".join([f"본문 {chunk_id}", *map(_placeholder, ids)])
    else:
        asset_id = pid or "".join(c for c in chunk_id.lower() if c.isalnum())
        ids = (asset_id,)
        body = text if text is not None else _placeholder(asset_id)
    chunk = Chunk(
        chunk_key=f"k-{chunk_id}",
        kind=kind,
        order=order,
        heading_path=heading_path,
        title=f"제목 {chunk_id}" if is_text else None,
        summary=f"요약 {chunk_id}" if is_text else None,
        text=body,
        placeholder_ids=ids,
        split_group=split[0] if split else None,
        split_index=split[1] if split else None,
        split_total=split[2] if split else None,
    )
    return ChunkRecord(
        chunk_id=chunk_id,
        doc_id=doc_id,
        version=version,
        job_id="job-1",
        active=active,
        name=name,
        edition=edition,
        is_latest_edition=latest,
        chunk=chunk,
    )


def make_searcher(
    store: object, hub: FakeSearchHub, settings: Settings, *, load: bool = True
) -> Searcher:
    """가짜를 끼운 Searcher를 만들고, 기본으로 임시 용어집을 읽어 둔다."""
    searcher = Searcher(cast(ModelHub, hub), cast(ChunkStore, store), settings)
    if load:
        searcher.load_glossary()
    return searcher


def write_glossary(path: Path, text: str) -> None:
    """용어집 파일을 쓰고 수정 시각을 이전보다 2초 뒤로 민다.

    ★ 변경 감지 방식(구현 재량)과 무관하게 "파일이 바뀌었다"를 확실히 만든다.
    """
    previous = path.stat().st_mtime_ns if path.exists() else time.time_ns()
    path.write_bytes(text.encode("utf-8"))
    later = previous + 2_000_000_000
    os.utime(path, ns=(later, later))


def edition_data() -> list[ChunkRecord]:
    """판 처리 검증용 세 문서(2022판, 2025판 최신, 판 정보 없음)를 만든다."""
    return [
        rec("c-2022", doc_id="d-2022", name="표준", edition=make_edition("2022")),
        rec("c-2025", doc_id="d-2025", name="표준", edition=make_edition("2025"), latest=True),
        rec("c-none", doc_id="d-none", name="메모"),
    ]


def scripted_store(
    records: Sequence[ChunkRecord],
    *,
    dense: list[str] | None = None,
    sparse: list[str] | None = None,
) -> FakeSearchStore:
    """레코드와 조회 대본을 넣은 가짜 저장소를 만든다. 대본이 없으면 삽입 순서다."""
    store = FakeSearchStore()
    store.add(*records)
    store.dense_order = dense
    store.sparse_order = sparse
    return store


def set_scores(hub: FakeSearchHub, pairs: Sequence[tuple[ChunkRecord, float]]) -> None:
    """레코드 원문별 재정렬 점수를 정한다."""
    hub.rerank_scores = {record.chunk.text: score for record, score in pairs}
