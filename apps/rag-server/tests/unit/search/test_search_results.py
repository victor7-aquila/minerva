"""결과 반환(REQ-RAG-4.3)과 SearchQuery 검증 테스트."""

from collections.abc import Callable

import pytest

from minerva_rag.core import ChunkKind, ChunkRecord, Settings
from minerva_rag.search import EditionScope, SearchHit, SearchQuery

from ..resource.fakes import make_edition, run
from .fakes import (
    BACKENDS,
    FakeSearchHub,
    backend_store,
    make_searcher,
    rec,
    scripted_store,
    set_scores,
)


async def _search(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    records: list[ChunkRecord],
    query: SearchQuery,
) -> tuple[SearchHit, ...]:
    """backend 위에서 검색한다."""
    async with backend_store(backend, monkeypatch, records) as store:
        return await make_searcher(store, FakeSearchHub(), settings).search(query)


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.3.1")
def test_exact_top_n(backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-4.3.1] 후보가 충분하면 결과가 정확히 N개다."""
    records = [rec(f"c{i}", doc_id=f"d{i}") for i in range(6)]

    hits = run(_search(backend, monkeypatch, settings, records, SearchQuery("q", top_n=4)))

    assert len(hits) == 4


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.3.1")
def test_fewer_candidates_than_n(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.3.1] 후보가 N보다 적으면 있는 만큼 돌려준다."""
    records = [rec("c1", doc_id="d1"), rec("c2", doc_id="d2")]

    hits = run(_search(backend, monkeypatch, settings, records, SearchQuery("q", top_n=5)))

    assert len(hits) == 2


@pytest.mark.req("REQ-RAG-4.3.1", "REQ-RAG-4.4.2")
def test_fragments_count_once(settings: Settings) -> None:
    """[REQ-RAG-4.3.1] 같은 청크의 조각이 여럿 검색돼도 결과 하나로 센다."""
    g1 = rec("g1", split=("g", 1, 2), order=1)
    g2 = rec("g2", split=("g", 2, 2), order=1)
    x, y = rec("X", order=2), rec("Y", order=3)
    script = ["g1", "g2", "X", "Y"]
    store = scripted_store([g1, g2, x, y], dense=script, sparse=script)
    hub = FakeSearchHub()
    set_scores(hub, [(g1, 0.9), (g2, 0.8), (x, 0.7), (y, 0.6)])

    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=3)))

    assert len(hits) == 3
    assert [tuple(c.chunk_id for c in hit.chunks) for hit in hits] == [
        ("g1", "g2"),
        ("X",),
        ("Y",),
    ]


@pytest.mark.req("REQ-RAG-4.3.2")
def test_default_top_n(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-4.3.2] top_n이 None이면 결과가 최대 RAG_SEARCH_DEFAULT_TOP_N개다."""
    settings = make_settings(top_n=3)
    store = scripted_store([rec(f"c{i}", doc_id=f"d{i}") for i in range(5)])

    hits = run(make_searcher(store, FakeSearchHub(), settings).search(SearchQuery("q")))

    assert len(hits) == 3


@pytest.mark.req("REQ-RAG-4.3.3")
def test_hit_fields_invariants(settings: Settings) -> None:
    """[REQ-RAG-4.3.3] 모든 결과가 SearchHit의 필드를 불변 조건대로 갖는다."""
    records = [
        rec("a", doc_id="d1", name="표준", edition=make_edition("2022"), heading_path=("가", "나")),
        rec("b", doc_id="d2", name="표준", edition=make_edition("2025"), latest=True),
        rec("c", doc_id="d3", name="메모", heading_path=("다",), version="v7"),
        rec("t", doc_id="d4", name="표", kind=ChunkKind.ASSET, pid="t9"),
    ]
    by_id = {r.chunk_id: r for r in records}
    store = scripted_store(records)
    hub = FakeSearchHub()
    set_scores(hub, [(records[0], 0.4), (records[1], 0.9), (records[2], 0.2), (records[3], 0.6)])

    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=4)))

    assert [hit.rank for hit in hits] == [1, 2, 3, 4]
    assert [hit.score for hit in hits] == sorted((hit.score for hit in hits), reverse=True)
    for hit in hits:
        first = by_id[hit.chunks[0].chunk_id]
        assert hit.doc_id == first.doc_id
        assert hit.version == first.version
        assert hit.name == first.name
        assert hit.heading_path == first.chunk.heading_path
        for chunk in hit.chunks:
            source = by_id[chunk.chunk_id]
            assert chunk.kind == source.chunk.kind
            assert chunk.text == source.chunk.text
            assert chunk.placeholder_ids == source.chunk.placeholder_ids
            assert chunk.split_index == source.chunk.split_index
            assert chunk.split_total == source.chunk.split_total
        # expand_neighbors의 기본값은 거짓이다
        assert hit.before == ()
        assert hit.after == ()


@pytest.mark.req("REQ-RAG-4.3.3")
def test_split_hit_heading_from_first_chunk(settings: Settings) -> None:
    """[REQ-RAG-4.3.3] 나뉜 청크의 heading_path는 chunks 첫 청크의 것이다."""
    g1 = rec("g1", split=("g", 1, 3), heading_path=("가",))
    g2 = rec("g2", split=("g", 2, 3), heading_path=("나",))
    g3 = rec("g3", split=("g", 3, 3), heading_path=("다",))
    store = scripted_store([g1, g2, g3], dense=["g2"], sparse=["g2"])

    hits = run(make_searcher(store, FakeSearchHub(), settings).search(SearchQuery("q", top_n=3)))

    assert len(hits) == 1
    assert hits[0].heading_path == ("가",)


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.3.4")
def test_placeholder_text_preserved(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.3.4] 자리표시가 든 청크의 결과 본문에 자리표시가 원형 그대로 있다."""
    original = "앞 [[minerva:table:t1 | 표 설명]] 뒤"
    records = [rec("c1", text=original, placeholder_ids=("t1",))]

    hits = run(_search(backend, monkeypatch, settings, records, SearchQuery("q", top_n=3)))

    assert hits[0].chunks[0].text == original
    assert hits[0].chunks[0].placeholder_ids == ("t1",)


@pytest.mark.req("REQ-RAG-4.3.5")
def test_no_generate_and_texts_are_records(settings: Settings) -> None:
    """[REQ-RAG-4.3.5] 검색에 generate 호출이 없고 결과의 텍스트가 모두 레코드 원문이다."""
    records = [rec(f"c{i}", order=i) for i in range(1, 5)]
    store = scripted_store(records, dense=["c2"], sparse=["c2"])
    hub = FakeSearchHub()

    hits = run(
        make_searcher(store, hub, settings).search(SearchQuery("q", top_n=3, expand_neighbors=True))
    )

    assert hub.generate_calls == []
    texts = {r.chunk.text for r in records}
    seen = [c.text for hit in hits for c in (*hit.before, *hit.chunks, *hit.after)]
    assert seen
    assert set(seen) <= texts


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.3.1")
def test_empty_result_is_empty_tuple(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.3.1] 후보가 없으면 오류 없이 빈 튜플을 돌려준다."""
    hits = run(_search(backend, monkeypatch, settings, [], SearchQuery("q", top_n=3)))

    assert hits == ()


@pytest.mark.req("REQ-RAG-4.3.2")
def test_search_query_defaults() -> None:
    """[REQ-RAG-4.3.2] SearchQuery의 선택 필드 기본값이 명세와 같다."""
    q = SearchQuery("q")

    assert q.top_n is None
    assert q.doc_ids is None
    assert q.edition_scope is EditionScope.ALL
    assert q.edition is None
    assert q.expand_neighbors is False


@pytest.mark.req("REQ-RAG-4.3.1")
def test_search_query_rejects_bad_top_n() -> None:
    """[REQ-RAG-4.3.1] top_n이 1 미만이면 ValueError다."""
    with pytest.raises(ValueError):
        SearchQuery("q", top_n=0)


@pytest.mark.req("REQ-RAG-4.5.3")
def test_search_query_specific_requires_edition() -> None:
    """[REQ-RAG-4.5.3] SPECIFIC인데 edition이 없으면 ValueError다."""
    with pytest.raises(ValueError):
        SearchQuery("q", edition_scope=EditionScope.SPECIFIC)
