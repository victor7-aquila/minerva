"""연관 청크 확장(REQ-RAG-4.4) 테스트."""

from collections.abc import Callable, Sequence

import pytest

from minerva_rag.core import ChunkKind, ChunkRecord, Settings
from minerva_rag.search import ResultChunk, SearchHit, SearchQuery

from ..resource.fakes import run
from .fakes import (
    FakeSearchHub,
    FakeSearchStore,
    backend_store,
    make_searcher,
    rec,
    scripted_store,
    set_scores,
)

Make = Callable[..., Settings]


def _ids(chunks: Sequence[ResultChunk]) -> tuple[str, ...]:
    """ResultChunk 목록의 chunk_id를 차례로 돌려준다."""
    return tuple(c.chunk_id for c in chunks)


def _body(
    n: int, *, doc_id: str = "doc-1", version: str = "v1", prefix: str = "c"
) -> list[ChunkRecord]:
    """order가 1..n인 본문 청크 n개를 만든다."""
    return [rec(f"{prefix}{i}", doc_id=doc_id, version=version, order=i) for i in range(1, n + 1)]


def _search(
    store: FakeSearchStore,
    hub: FakeSearchHub,
    settings: Settings,
    *,
    hit: list[str],
    neighbors: bool = True,
    top_n: int = 5,
) -> tuple[SearchHit, ...]:
    """hit만 두 조회에 나오게 하고 검색한다."""
    store.dense_order = hit
    store.sparse_order = hit
    searcher = make_searcher(store, hub, settings)
    return run(searcher.search(SearchQuery("q", top_n=top_n, expand_neighbors=neighbors)))


@pytest.mark.req("REQ-RAG-4.4.1")
def test_split_all_fragments_in_order(settings: Settings) -> None:
    """[REQ-RAG-4.4.1] 3개로 나뉜 청크의 2번 조각만 검색돼도 chunks가 1·2·3번 조각이다."""
    frags = [rec(f"f{i}", split=("g", i, 3), order=1) for i in (3, 1, 2)]
    store = scripted_store(frags)

    hits = _search(store, FakeSearchHub(), settings, hit=["f2"], neighbors=False)

    assert len(hits) == 1
    assert [c.split_index for c in hits[0].chunks] == [1, 2, 3]


@pytest.mark.req("REQ-RAG-4.4.1")
def test_split_fragments_same_version_only(settings: Settings) -> None:
    """[REQ-RAG-4.4.1] 두 버전이 함께 active여도 조각은 같은 버전에서만 가져온다."""
    old = [rec(f"o{i}", version="v1", split=("g", i, 3), order=1) for i in (1, 2, 3)]
    new = [rec(f"n{i}", version="v2", split=("g", i, 3), order=1) for i in (1, 2, 3)]
    store = scripted_store([*old, *new])

    hits = _search(store, FakeSearchHub(), settings, hit=["n2"], neighbors=False)

    assert len(hits) == 1
    assert {c.chunk_id for c in hits[0].chunks} == {"n1", "n2", "n3"}


@pytest.mark.req("REQ-RAG-4.4.1", "REQ-RAG-4.3.3")
def test_inactive_never_returned(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, make_settings: Make
) -> None:
    """[REQ-RAG-4.4.1] 조각·앞뒤 청크에도 inactive 레코드는 나오지 않는다(실제 저장소)."""
    records = [
        rec("old1", version="v1", active=False, split=("g", 1, 2), order=2),
        rec("old2", version="v1", active=False, split=("g", 2, 2), order=2),
        rec("oldb", version="v1", active=False, order=1),
        rec("new1", version="v2", split=("g", 1, 2), order=2),
        rec("new2", version="v2", split=("g", 2, 2), order=2),
        rec("newb", version="v2", order=1),
        rec("newa", version="v2", order=3),
    ]
    active_ids = {r.chunk_id for r in records if r.active}
    big = make_settings(neighbor_max=1000)

    async def scenario() -> tuple[SearchHit, ...]:
        async with backend_store("qdrant_memory", monkeypatch, records) as store:
            searcher = make_searcher(store, FakeSearchHub(), big)
            return await searcher.search(SearchQuery("q", top_n=10, expand_neighbors=True))

    hits = run(scenario())

    seen = {c.chunk_id for hit in hits for c in (*hit.before, *hit.chunks, *hit.after)}
    assert seen
    assert seen <= active_ids
    assert all(hit.version == "v2" for hit in hits)


@pytest.mark.req("REQ-RAG-4.4.2")
def test_two_fragments_one_hit(settings: Settings) -> None:
    """[REQ-RAG-4.4.2] 같은 청크의 조각 두 개가 검색되면 결과에 그 청크가 한 번만 나온다."""
    frags = [rec(f"f{i}", split=("g", i, 3), order=1) for i in (1, 2, 3)]
    store = scripted_store(frags)

    hits = _search(store, FakeSearchHub(), settings, hit=["f1", "f3"], neighbors=False)

    assert len(hits) == 1
    assert _ids(hits[0].chunks) == ("f1", "f2", "f3")


@pytest.mark.req("REQ-RAG-4.4.3")
def test_merged_score_is_max(settings: Settings) -> None:
    """[REQ-RAG-4.4.3] 합친 결과의 score가 검색된 조각 점수 중 가장 높은 값이고 순위도 그 점수다."""
    f1 = rec("f1", split=("g", 1, 2), order=1)
    f2 = rec("f2", split=("g", 2, 2), order=1)
    x = rec("X", order=2)
    store = scripted_store([f1, f2, x], dense=["f1", "f2", "X"], sparse=["f1", "f2", "X"])
    hub = FakeSearchHub()
    set_scores(hub, [(f1, 0.3), (f2, 0.9), (x, 0.5)])

    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=5)))

    assert [_ids(hit.chunks) for hit in hits] == [("f1", "f2"), ("X",)]
    assert hits[0].score == pytest.approx(0.9)


@pytest.mark.req("REQ-RAG-4.4.3", "REQ-RAG-4.5.5")
def test_merged_score_includes_latest_weight(make_settings: Make) -> None:
    """[REQ-RAG-4.4.3] 합친 결과의 score는 최신판 가중치를 포함한 가장 높은 값이다."""
    settings = make_settings(weight=0.25)
    f1 = rec("f1", split=("g", 1, 2), order=1, latest=True)
    f2 = rec("f2", split=("g", 2, 2), order=1, latest=True)
    store = scripted_store([f1, f2])
    hub = FakeSearchHub()
    set_scores(hub, [(f1, 0.3), (f2, 0.6)])

    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=5)))

    assert hits[0].score == pytest.approx(0.85)


@pytest.mark.req("REQ-RAG-4.4.4")
def test_neighbors_one_each_side(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] 3·4·5번째 본문 청크 중 4번이 검색되면 before가 3번, after가 5번이다."""
    store = scripted_store([rec("c3", order=3), rec("c4", order=4), rec("c5", order=5)])

    hits = _search(store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["c4"])

    assert _ids(hits[0].before) == ("c3",)
    assert _ids(hits[0].after) == ("c5",)


@pytest.mark.req("REQ-RAG-4.4.4")
def test_neighbors_empty_when_not_requested(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] expand_neighbors가 거짓이면 before·after가 비어 있다."""
    store = scripted_store(_body(3))

    hits = _search(
        store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["c2"], neighbors=False
    )

    assert hits[0].before == ()
    assert hits[0].after == ()


@pytest.mark.req("REQ-RAG-4.4.4")
def test_neighbors_exclude_assets(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] 표·이미지 청크는 앞뒤 청크로 넣지 않는다."""
    c1, c3 = rec("c1", order=1), rec("c3", order=3)
    c2 = rec("c2", order=2, placeholder_ids=("a2",))
    asset = rec("a2", kind=ChunkKind.ASSET, pid="a2", order=2)
    store = scripted_store([c1, c2, c3, asset])

    hits = _search(store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["c2"])

    assert _ids(hits[0].before) == ("c1",)
    assert _ids(hits[0].after) == ("c3",)


@pytest.mark.req("REQ-RAG-4.4.4")
def test_asset_hit_starts_from_container(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] ASSET 결과는 그것을 담은 본문 청크부터 앞 청크로 센다."""
    c1, c3 = rec("c1", order=1), rec("c3", order=3)
    c2 = rec("c2", order=2, placeholder_ids=("a2",))
    asset = rec("a2", kind=ChunkKind.ASSET, pid="a2", order=2)
    store = scripted_store([c1, c2, c3, asset])

    hits = _search(store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["a2"])

    assert _ids(hits[0].chunks) == ("a2",)
    assert _ids(hits[0].before) == ("c1", "c2")
    assert _ids(hits[0].after) == ("c3",)


@pytest.mark.req("REQ-RAG-4.4.4")
def test_neighbors_skip_own_fragments(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] 결과의 chunks에 이미 든 조각은 앞뒤 청크에 넣지 않는다."""
    c1 = rec("c1", order=1)
    g1 = rec("g1", order=2, split=("g", 1, 2))
    g2 = rec("g2", order=2, split=("g", 2, 2))
    c3 = rec("c3", order=3)
    store = scripted_store([c1, g1, g2, c3])

    hits = _search(store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["g1"])

    assert _ids(hits[0].chunks) == ("g1", "g2")
    assert _ids(hits[0].before) == ("c1",)
    assert _ids(hits[0].after) == ("c3",)


@pytest.mark.req("REQ-RAG-4.4.4")
def test_neighbors_body_order_by_order_and_split(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] 앞뒤는 본문 청크를 (order, split_index) 순으로 늘어놓은 차례로 정한다."""
    h2 = rec("h2", order=2, split=("h", 2, 2))
    h1 = rec("h1", order=2, split=("h", 1, 2))
    c1 = rec("c1", order=1)
    store = scripted_store([h2, h1, c1])

    hits = _search(store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["c1"])

    assert _ids(hits[0].after) == ("h1", "h2")


@pytest.mark.req("REQ-RAG-4.4.4")
def test_neighbors_same_version_only(make_settings: Make) -> None:
    """[REQ-RAG-4.4.4] 두 버전이 함께 active여도 앞뒤 청크는 결과와 같은 버전에서만 찾는다."""
    old = _body(3, version="v1", prefix="o")
    new = _body(3, version="v2", prefix="n")
    store = scripted_store([*old, *new])

    hits = _search(store, FakeSearchHub(), make_settings(neighbor_max=1000), hit=["n2"])

    assert _ids(hits[0].before) == ("n1",)
    assert _ids(hits[0].after) == ("n3",)


def _limited(
    make_settings: Make,
    *,
    count: int,
    hit: str,
    limit: int,
    tokens: dict[str, int] | None = None,
    default: int = 10,
) -> tuple[SearchHit, FakeSearchHub]:
    """본문 count개 중 hit을 검색하고 토큰 수를 고정해 앞뒤 청크를 얻는다."""
    records = _body(count)
    store = scripted_store(records)
    hub = FakeSearchHub()
    hub.default_tokens = default
    by_id = {r.chunk_id: r for r in records}
    hub.token_counts = {by_id[k].chunk.text: v for k, v in (tokens or {}).items()}
    hits = _search(store, hub, make_settings(neighbor_max=limit), hit=[hit])
    return hits[0], hub


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_limit_one_each(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 상한이 앞뒤 한 청크씩만 허용하면 거리 1의 앞·뒤만 들어간다."""
    hit, _ = _limited(make_settings, count=5, hit="c3", limit=25)

    assert _ids(hit.before) == ("c2",)
    assert _ids(hit.after) == ("c4",)


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_limit_order_before_first(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 거리 1의 앞, 거리 1의 뒤, 거리 2의 앞 순으로 넣는다."""
    hit, _ = _limited(make_settings, count=5, hit="c3", limit=30)

    assert _ids(hit.before) == ("c1", "c2")
    assert _ids(hit.after) == ("c4",)


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_big_first_blocks_all(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 거리 1의 앞 청크 하나가 상한보다 크면 아무것도 넣지 않는다."""
    hit, _ = _limited(make_settings, count=3, hit="c2", limit=20, tokens={"c1": 50})

    assert hit.before == ()
    assert hit.after == ()


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_zero_limit(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 상한이 0이면 앞뒤 청크를 넣지 않는다."""
    hit, _ = _limited(make_settings, count=3, hit="c2", limit=0)

    assert hit.before == ()
    assert hit.after == ()


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_contiguous(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 상한에서 멈추면 그 뒤 청크를 넣지 않아 결과가 빈틈 없이 이어진다."""
    hit, _ = _limited(make_settings, count=7, hit="c4", limit=40, tokens={"c6": 50})

    assert _ids(hit.before) == ("c2", "c3")
    assert _ids(hit.after) == ("c5",)


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_one_side_continues(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 앞 청크가 없는 결과는 뒤 청크만 가까운 것부터 들어간다."""
    hit, _ = _limited(make_settings, count=4, hit="c1", limit=20)

    assert hit.before == ()
    assert _ids(hit.after) == ("c2", "c3")


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_one_side_continues_before(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 뒤 청크가 없는 결과는 앞 청크만 가까운 것부터 들어간다."""
    hit, _ = _limited(make_settings, count=4, hit="c4", limit=20)

    assert hit.after == ()
    assert _ids(hit.before) == ("c2", "c3")


@pytest.mark.req("REQ-RAG-4.4.5")
def test_neighbor_tokens_counted_on_text(make_settings: Make) -> None:
    """[REQ-RAG-4.4.5] 청크의 토큰 수는 그 청크 원문(chunk.text)으로 센다."""
    _, hub = _limited(make_settings, count=5, hit="c3", limit=25)

    texts = {f"본문 c{i}" for i in range(1, 6)}
    assert hub.count_inputs
    assert set(hub.count_inputs) <= texts
