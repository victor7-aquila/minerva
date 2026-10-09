"""검색 결과의 순위를 합치고 분할 조각을 묶는다 (REQ-RAG-4.1.2, 4.2, 4.4.2, 4.4.3, 4.5.5)."""

from collections.abc import Sequence
from dataclasses import dataclass

from minerva_rag.core import ChunkRecord
from minerva_rag.resource import ScoredRecord

RRF_K = 60  # 구현 재량 — RRF의 표준 상수(튜닝값)


@dataclass(frozen=True)
class Candidate:
    """RRF로 합친 후보다."""

    record: ChunkRecord
    fused: float  # 합친 점수
    best_rank: int  # 두 조회 중 더 좋은 순위 (동점 정렬용)


@dataclass(frozen=True)
class Ranked:
    """최종 점수가 붙은 후보다."""

    record: ChunkRecord
    score: float


@dataclass(frozen=True)
class Group:
    """결과 하나가 될 묶음이다. 분할 조각이면 같은 split_group의 검색된 조각들이다."""

    top: Ranked  # 점수가 가장 높은 검색된 조각 (대표 레코드)
    retrieved: tuple[ChunkRecord, ...]  # 검색된 조각들 (점수 순)


def _rank_map(results: Sequence[ScoredRecord]) -> dict[str, tuple[int, ChunkRecord]]:
    """chunk_id별 첫 순위(1부터)와 레코드를 모은다. active가 아닌 레코드는 버린다."""
    ranks: dict[str, tuple[int, ChunkRecord]] = {}
    for position, scored in enumerate(results, start=1):
        record = scored.record
        if record.active and record.chunk_id not in ranks:
            ranks[record.chunk_id] = (position, record)
    return ranks


def fuse(dense: Sequence[ScoredRecord], sparse: Sequence[ScoredRecord]) -> list[Candidate]:
    """두 조회 결과를 RRF로 합쳐 합친 점수 내림차순으로 돌려준다."""
    dense_ranks = _rank_map(dense)
    sparse_ranks = _rank_map(sparse)
    candidates: list[Candidate] = []
    for chunk_id in dict.fromkeys([*dense_ranks, *sparse_ranks]):
        entries = [m[chunk_id] for m in (dense_ranks, sparse_ranks) if chunk_id in m]
        fused = sum(1.0 / (RRF_K + rank) for rank, _ in entries)
        best = min(rank for rank, _ in entries)
        candidates.append(Candidate(record=entries[0][1], fused=fused, best_rank=best))
    # ★ 동점은 더 좋은 순위, 그다음 chunk_id 순으로 정해 결과를 결정적으로 만든다
    candidates.sort(key=lambda c: (-c.fused, c.best_rank, c.record.chunk_id))
    return candidates


def apply_scores(
    candidates: Sequence[Candidate],
    rerank_scores: Sequence[float] | None,
    latest_weight: float,
) -> list[Ranked]:
    """재정렬 점수(없으면 합친 점수)에 최신판 가중치를 더해 내림차순으로 돌려준다."""
    ranked: list[Ranked] = []
    for index, candidate in enumerate(candidates):
        base = candidate.fused if rerank_scores is None else rerank_scores[index]
        bonus = latest_weight if candidate.record.is_latest_edition else 0.0
        ranked.append(Ranked(record=candidate.record, score=base + bonus))
    # 안정 정렬이라 같은 점수는 합친 순위를 유지한다
    ranked.sort(key=lambda r: -r.score)
    return ranked


def _group_key(record: ChunkRecord) -> tuple[str, ...]:
    """묶음 키를 만든다. 분할 청크는 같은 문서·버전·split_group끼리 묶는다."""
    group = record.chunk.split_group
    if group is None:
        return ("chunk", record.chunk_id)
    return ("split", record.doc_id, record.version, group)


def group_fragments(ranked: Sequence[Ranked]) -> list[Group]:
    """같은 분할 청크의 조각을 결과 하나로 묶는다. 묶음 점수는 조각 점수의 최댓값이다."""
    members: dict[tuple[str, ...], list[Ranked]] = {}
    for item in ranked:
        members.setdefault(_group_key(item.record), []).append(item)
    # ★ ranked가 내림차순이라 키를 처음 본 항목이 최댓값이고, 묶음 순서도 점수 내림차순이다
    return [
        Group(top=items[0], retrieved=tuple(i.record for i in items)) for items in members.values()
    ]
