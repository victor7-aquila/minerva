"""검색 한 번과 문서 청크 조회를 처리한다 (REQ-RAG-4)."""

import asyncio
import dataclasses
import math
import time
from collections.abc import Awaitable, Callable, Sequence

from minerva_rag.core import ChunkKind, ChunkRecord, Settings, get_logger
from minerva_rag.resource import ChunkFilter, ChunkStore, ModelHub

from .glossary import Expansion, Glossary
from .models import (
    DocumentChunk,
    DocumentChunks,
    EditionScope,
    ResultChunk,
    ResultEdition,
    SearchHit,
    SearchQuery,
)
from .neighbors import anchor_span, body_sequence, pick_neighbors
from .ranking import Candidate, Group, apply_scores, fuse, group_fragments

log = get_logger(__name__)

# 구현 재량 — 조각 묶기 뒤에도 N개를 채울 여유를 두되 재정렬 지문 수를 묶어 둔다
_CANDIDATE_FACTOR = 3
_MIN_CANDIDATES = 30
_Counter = Callable[[ChunkRecord], Awaitable[int]]
_UNKNOWN_POSITION = 1 << 30  # 자리표시 위치를 못 찾은 표·이미지 청크는 맨 뒤로 보낸다


# ── 순수 헬퍼 ────────────────────────────────────────────────────


def _expanded_text(query: str, expansion: Expansion) -> str:
    """질의에 확장한 말을 공백으로 이어 붙인다. 확장이 없으면 질의 그대로다."""
    if not expansion.terms:
        return query
    return " ".join((query, *expansion.terms))


def _chunk_filter(q: SearchQuery) -> ChunkFilter:
    """판 범위와 문서 ID 범위로 조회 필터를 만든다."""
    if q.edition_scope is EditionScope.SPECIFIC and q.edition is not None:
        return ChunkFilter(
            doc_ids=q.doc_ids, edition_name=q.edition.name, edition_label=q.edition.label
        )
    if q.edition_scope is EditionScope.LATEST:
        return ChunkFilter(doc_ids=q.doc_ids, latest_or_unversioned=True)
    return ChunkFilter(doc_ids=q.doc_ids)


def _result_chunk(record: ChunkRecord) -> ResultChunk:
    """레코드의 값을 그대로 결과 청크로 옮긴다."""
    chunk = record.chunk
    return ResultChunk(
        chunk_id=record.chunk_id,
        kind=chunk.kind,
        text=chunk.text,
        placeholder_ids=chunk.placeholder_ids,
        split_index=chunk.split_index,
        split_total=chunk.split_total,
    )


def _document_chunk(record: ChunkRecord) -> DocumentChunk:
    """레코드의 값을 그대로 문서 청크 조회의 청크로 옮긴다."""
    chunk = record.chunk
    return DocumentChunk(
        chunk_id=record.chunk_id,
        order=chunk.order,
        kind=chunk.kind,
        heading_path=chunk.heading_path,
        title=chunk.title,
        summary=chunk.summary,
        text=chunk.text,
        placeholder_ids=chunk.placeholder_ids,
        split_index=chunk.split_index,
        split_total=chunk.split_total,
    )


def _fragment_key(record: ChunkRecord) -> tuple[int, str]:
    """분할 조각의 정렬 키(split_index, chunk_key)를 만든다."""
    return (record.chunk.split_index or 0, record.chunk.chunk_key)


def _result_records(group: Group, siblings: Sequence[ChunkRecord]) -> list[ChunkRecord]:
    """결과의 chunks가 될 레코드를 정한다. 분할이면 같은 버전의 조각 전부를 모은다."""
    top = group.top.record
    group_id = top.chunk.split_group
    if group_id is None:
        return [top]
    pieces = {
        r.chunk_id: r
        for r in (*siblings, *group.retrieved)
        if r.version == top.version and r.chunk.split_group == group_id
    }
    return sorted(pieces.values(), key=_fragment_key)


def _mark_other_editions(hits: list[SearchHit]) -> list[SearchHit]:
    """같은 이름에 판 표기가 둘 이상 나온 결과의 other_editions_in_results를 참으로 한다."""
    labels: dict[str, set[str]] = {}
    for hit in hits:
        if hit.edition is not None:
            labels.setdefault(hit.name, set()).add(hit.edition.label)
    return [
        dataclasses.replace(hit, other_editions_in_results=True)
        if hit.edition is not None and len(labels[hit.name]) > 1
        else hit
        for hit in hits
    ]


def _asset_positions(texts: Sequence[ChunkRecord]) -> dict[str, int]:
    """본문 청크들의 placeholder_ids를 이어 자리표시 ID의 나온 위치를 만든다."""
    positions: dict[str, int] = {}
    for record in texts:
        for pid in record.chunk.placeholder_ids:
            positions.setdefault(pid, len(positions))
    return positions


def _order_group(records: Sequence[ChunkRecord]) -> list[ChunkRecord]:
    """같은 order의 청크를 정렬한다. 본문 조각 뒤에 표·이미지를 자리표시 차례로 둔다."""
    texts = sorted(
        (r for r in records if r.chunk.kind == ChunkKind.TEXT),
        key=_fragment_key,
    )
    positions = _asset_positions(texts)
    assets = sorted(
        (r for r in records if r.chunk.kind != ChunkKind.TEXT),
        key=lambda r: (
            min(
                (positions.get(p, _UNKNOWN_POSITION) for p in r.chunk.placeholder_ids),
                default=_UNKNOWN_POSITION,
            ),
            r.chunk.chunk_key,
        ),
    )
    return [*texts, *assets]


def _document_order(records: Sequence[ChunkRecord]) -> list[ChunkRecord]:
    """문서 안 순서(order, 본문 조각, 표·이미지)로 늘어놓는다."""
    by_order: dict[int, list[ChunkRecord]] = {}
    for record in records:
        by_order.setdefault(record.chunk.order, []).append(record)
    ordered: list[ChunkRecord] = []
    for order in sorted(by_order):
        ordered.extend(_order_group(by_order[order]))
    return ordered


# ── Searcher ─────────────────────────────────────────────────────


class Searcher:
    """검색 한 번과 문서 청크 조회를 처리한다."""

    def __init__(self, model_hub: ModelHub, chunk_store: ChunkStore, settings: Settings) -> None:
        """의존 객체와 설정을 받고 용어집 헬퍼를 만든다. I/O는 하지 않는다."""
        self._hub = model_hub
        self._store = chunk_store
        self._settings = settings
        self._glossary = Glossary(settings)

    def load_glossary(self) -> None:
        """RAG_GLOSSARY_PATH의 용어집을 처음 읽는다. 형식이 틀리면 GlossaryError를 그대로 낸다."""
        self._glossary.load()

    async def search(self, q: SearchQuery) -> tuple[SearchHit, ...]:
        """질의 확장부터 판 처리까지 검색 한 번을 처리한다."""
        started = time.perf_counter()
        expansion = self._glossary.expand(q.query)  # 1. 질의 확장
        text = _expanded_text(q.query, expansion)
        top_n = q.top_n if q.top_n is not None else self._settings.search_default_top_n
        limit = max(top_n * _CANDIDATE_FACTOR, _MIN_CANDIDATES)
        candidates = await self._hybrid(text, _chunk_filter(q), limit)  # 2. 하이브리드 검색
        rerank_scores = await self._rerank(text, candidates)  # 3. 재정렬
        ranked = apply_scores(candidates, rerank_scores, self._settings.latest_edition_weight)
        groups = group_fragments(ranked)[:top_n]  # 4. 분할 조각 합치기, 상위 N
        hits = await self._build_hits(groups, q.expand_neighbors)  # 5. 앞뒤 청크
        results = tuple(_mark_other_editions(hits))  # 6. 판 정보
        log.info(
            "search.done",
            query_chars=len(q.query),
            expanded_terms=len(expansion.terms),
            candidates=len(candidates),
            results=len(results),
            reranked=rerank_scores is not None,
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )
        return results

    async def _hybrid(self, text: str, flt: ChunkFilter, limit: int) -> list[Candidate]:
        """dense·키워드 조회를 함께 하고 RRF로 합친다."""
        dense_vector = await self._hub.embed_query(text)
        sparse_vector = await self._hub.encode_sparse_query(text)
        # ★ TaskGroup은 예외를 ExceptionGroup으로 감싸 "그대로 낸다"를 어기므로 gather를 쓴다
        dense, sparse = await asyncio.gather(
            self._store.search_dense(dense_vector, flt, limit),
            self._store.search_sparse(sparse_vector, flt, limit),
        )
        return fuse(dense, sparse)

    async def _rerank(self, text: str, candidates: Sequence[Candidate]) -> list[float] | None:
        """후보를 재정렬한 점수를 돌려준다. 어떤 예외든 None으로 합친 순위를 대신 쓴다."""
        if not candidates:
            return None
        try:
            scores = await self._hub.rerank(text, [c.record.chunk.text for c in candidates])
            if len(scores) != len(candidates) or not all(math.isfinite(s) for s in scores):
                raise ValueError("재정렬 점수가 후보와 맞지 않습니다")
        except Exception as exc:  # ★ 취소(CancelledError)는 Exception이 아니라 잡히지 않는다
            log.warning(
                "search.rerank_failed", candidates=len(candidates), error_type=type(exc).__name__
            )
            return None
        return list(scores)

    async def _load_documents(
        self, groups: Sequence[Group], expand_neighbors: bool
    ) -> dict[str, list[ChunkRecord]]:
        """조각 묶음이 있거나 앞뒤 청크가 필요한 결과의 문서마다 active 레코드를 한 번씩 읽는다."""
        doc_ids = dict.fromkeys(
            g.top.record.doc_id
            for g in groups
            if expand_neighbors or g.top.record.chunk.split_group is not None
        )
        docs: dict[str, list[ChunkRecord]] = {}
        for doc_id in doc_ids:
            docs[doc_id] = [r for r in await self._store.active_records(doc_id) if r.active]
        return docs

    async def _build_hits(self, groups: Sequence[Group], expand_neighbors: bool) -> list[SearchHit]:
        """묶음마다 결과를 만든다. 청크 토큰 수는 검색 한 번 안에서 한 번만 센다."""
        docs = await self._load_documents(groups, expand_neighbors)
        token_cache: dict[str, int] = {}

        async def count(record: ChunkRecord) -> int:
            """청크 원문의 토큰 수를 센다. 계산은 이벤트 루프 밖에서 한다."""
            if record.chunk_id not in token_cache:
                token_cache[record.chunk_id] = await asyncio.to_thread(
                    self._hub.count_tokens, record.chunk.text
                )
            return token_cache[record.chunk_id]

        hits: list[SearchHit] = []
        for rank, group in enumerate(groups, start=1):
            doc_records = docs.get(group.top.record.doc_id, [])
            hits.append(await self._build_hit(rank, group, doc_records, expand_neighbors, count))
        return hits

    async def _build_hit(
        self,
        rank: int,
        group: Group,
        doc_records: Sequence[ChunkRecord],
        expand_neighbors: bool,
        count: _Counter,
    ) -> SearchHit:
        """묶음 하나를 검색 결과로 만든다."""
        top = group.top.record
        chunk_records = _result_records(group, doc_records)
        before: list[ChunkRecord] = []
        after: list[ChunkRecord] = []
        if expand_neighbors:
            body = body_sequence(doc_records, top.version)
            span = anchor_span(body, chunk_records)
            if span is not None:
                before, after = await pick_neighbors(
                    body, span, self._settings.neighbor_max_tokens, count
                )
        edition = (
            ResultEdition(top.edition.label, top.edition.edition_date, top.is_latest_edition)
            if top.edition is not None
            else None
        )
        return SearchHit(
            rank=rank,
            score=group.top.score,
            doc_id=top.doc_id,
            version=top.version,
            heading_path=chunk_records[0].chunk.heading_path,
            name=top.name,
            edition=edition,
            other_editions_in_results=False,
            chunks=tuple(_result_chunk(r) for r in chunk_records),
            before=tuple(_result_chunk(r) for r in before),
            after=tuple(_result_chunk(r) for r in after),
        )

    async def document_chunks(self, doc_id: str) -> DocumentChunks:
        """문서 하나의 지금 검색되는 청크를 문서 안 순서대로 돌려준다."""
        records = [r for r in await self._store.active_records(doc_id) if r.active]
        if not records:
            return DocumentChunks(doc_id=doc_id, version=None, name=None, edition=None, chunks=())
        versions = {r.version for r in records}
        version = sorted(versions)[-1]  # ★ 버전 문자열 정렬의 마지막 (사용자 결정)
        if len(versions) > 1:
            # ★ 활성화 뒤 정리 실패 등으로 두 버전이 함께 active다 (IF-RAG-1 active)
            log.warning("search.multiple_active_versions", doc_id=doc_id, versions=len(versions))
        ordered = _document_order([r for r in records if r.version == version])
        first = ordered[0]
        return DocumentChunks(
            doc_id=doc_id,
            version=version,
            name=first.name,
            edition=first.edition,
            chunks=tuple(_document_chunk(r) for r in ordered),
        )
