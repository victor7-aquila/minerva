"""앞뒤 본문 청크를 고른다 (REQ-RAG-4.4.4, REQ-RAG-4.4.5)."""

from collections.abc import Awaitable, Callable, Iterable, Sequence

from minerva_rag.core import ChunkKind, ChunkRecord


def _sort_key(record: ChunkRecord) -> tuple[int, int, str]:
    """(order, split_index, chunk_key) 정렬 키를 만든다."""
    chunk = record.chunk
    return (chunk.order, chunk.split_index or 0, chunk.chunk_key)


def body_sequence(records: Iterable[ChunkRecord], version: str) -> list[ChunkRecord]:
    """같은 버전의 active 본문 청크를 (order, split_index) 순으로 늘어놓는다."""
    body = [
        r for r in records if r.active and r.version == version and r.chunk.kind == ChunkKind.TEXT
    ]
    body.sort(key=_sort_key)
    return body


def _holder_index(body: Sequence[ChunkRecord], asset: ChunkRecord) -> int:
    """ASSET을 담은 본문 청크의 위치를 정한다. 자료가 어긋나 못 찾으면 대체 규칙을 쓴다."""
    ids = asset.chunk.placeholder_ids
    pid = ids[0] if ids else None
    for position, record in enumerate(body):
        if pid is not None and pid in record.chunk.placeholder_ids:
            return position
    # ★ 방어: order가 ASSET 이하인 마지막 본문 청크, 그것도 없으면 맨 앞 앞(-1)
    before = [p for p, r in enumerate(body) if r.chunk.order <= asset.chunk.order]
    return before[-1] if before else -1


def anchor_span(
    body: Sequence[ChunkRecord], result_chunks: Sequence[ChunkRecord]
) -> tuple[int, int] | None:
    """결과가 본문 차례에서 차지하는 구간(lo, hi)을 돌려준다. ASSET은 담은 청크 뒤 빈 구간이다."""
    if not result_chunks:
        return None
    first = result_chunks[0]
    if first.chunk.kind == ChunkKind.ASSET:
        holder = _holder_index(body, first)
        return (holder + 1, holder)
    positions = {r.chunk_id: p for p, r in enumerate(body)}
    found = [positions[c.chunk_id] for c in result_chunks if c.chunk_id in positions]
    if not found:
        return None
    return (min(found), max(found))


async def pick_neighbors(
    body: Sequence[ChunkRecord],
    span: tuple[int, int],
    max_tokens: int,
    count: Callable[[ChunkRecord], Awaitable[int]],
) -> tuple[list[ChunkRecord], list[ChunkRecord]]:
    """가까운 것부터 앞·뒤를 번갈아 넣다가 토큰 합이 상한을 넘으면 멈춘다. 원문 순서로 돌려준다."""
    low, high = span
    before_pool = list(reversed(body[:low]))  # 가까운 것부터
    after_pool = list(body[high + 1 :])
    before: list[ChunkRecord] = []
    after: list[ChunkRecord] = []
    used = 0
    for distance in range(max(len(before_pool), len(after_pool))):
        for pool, picked in ((before_pool, before), (after_pool, after)):
            if distance >= len(pool):
                continue  # 한쪽이 소진되면 다른 쪽만 이어서 넣는다
            tokens = await count(pool[distance])
            if used + tokens > max_tokens:
                # ★ 한 번 넘으면 전체를 멈춘다 — 넣은 청크가 빈틈 없이 이어지게 한다
                return before[::-1], after
            used += tokens
            picked.append(pool[distance])
    return before[::-1], after
