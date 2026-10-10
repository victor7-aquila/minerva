"""하이브리드 검색(REQ-RAG-4.1) 테스트."""

from pathlib import Path

import pytest

from minerva_rag.core import ChunkKind, Settings
from minerva_rag.search import SearchHit, SearchQuery

from ..resource.fakes import run
from .fakes import (
    BACKENDS,
    EXAMPLE_GLOSSARY,
    FakeSearchHub,
    backend_store,
    make_searcher,
    rec,
    scripted_store,
    write_glossary,
)


@pytest.mark.req("REQ-RAG-4.1.1")
def test_both_queries_called(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 검색 한 번에 dense·키워드 조회와 두 질의 벡터 생성이 모두 불린다."""
    store = scripted_store([rec("a"), rec("b")])
    hub = FakeSearchHub()

    run(make_searcher(store, hub, settings).search(SearchQuery("질의", top_n=5)))

    # ★ 호출 횟수는 구현 재량이라 "불렸다"까지만 본다
    assert store.count("search_dense") >= 1
    assert store.count("search_sparse") >= 1
    assert hub.embed_inputs
    assert hub.sparse_inputs


@pytest.mark.req("REQ-RAG-4.1.1")
def test_sparse_only_candidate_in_results(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 키워드 검색에만 나온 청크도 결과 후보에 든다."""
    store = scripted_store([rec("a"), rec("b")], dense=["a"], sparse=["b"])

    hits = run(make_searcher(store, FakeSearchHub(), settings).search(SearchQuery("q", top_n=5)))

    assert "b" in {c.chunk_id for hit in hits for c in hit.chunks}


@pytest.mark.req("REQ-RAG-4.1.1", "REQ-RAG-4.9.1")
def test_expanded_query_used(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.1.1] 두 질의 벡터는 원래 질의와 확장한 말을 담은 질의로 만든다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    hub = FakeSearchHub()
    searcher = make_searcher(scripted_store([rec("a")]), hub, settings)

    run(searcher.search(SearchQuery("cert 갱신")))

    # ★ 확장 질의 문자열의 정확한 형식은 구현 재량이라 단언하지 않는다
    for expected in ("cert 갱신", "인증서", "certificate", "인증 문서"):
        assert expected in hub.embed_inputs[0]
        assert expected in hub.sparse_inputs[0]


@pytest.mark.req("REQ-RAG-4.1.1", "REQ-RAG-4.9.1")
def test_no_glossary_word_query_unchanged(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.1.1] 용어집의 말이 없는 질의는 그대로 질의 벡터를 만든다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    hub = FakeSearchHub()
    searcher = make_searcher(scripted_store([rec("a")]), hub, settings)

    run(searcher.search(SearchQuery("날씨 어때")))

    assert hub.embed_inputs[0] == "날씨 어때"
    assert hub.sparse_inputs[0] == "날씨 어때"


def _fused_scenario(
    settings: Settings, *, fail: bool = True
) -> tuple[FakeSearchHub, list[SearchHit]]:
    """dense [A, B, C]와 키워드 [A, C]를 재정렬 실패 상태로 합친 결과를 만든다.

    ★ 동점이 생기지 않는다. A는 두 검색의 1위, C는 두 검색에 모두 나오고, B는 dense에만 나온다.
    """
    store = scripted_store([rec("A"), rec("B"), rec("C")], dense=["A", "B", "C"], sparse=["A", "C"])
    hub = FakeSearchHub()
    if fail:
        hub.rerank_error = RuntimeError("실패")
    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=5)))
    return hub, list(hits)


@pytest.mark.req("REQ-RAG-4.1.2")
def test_rrf_both_lists_first(settings: Settings) -> None:
    """[REQ-RAG-4.1.2] 두 검색에 모두 나온 청크가 한쪽에만 나온 청크보다 앞선다."""
    _, hits = _fused_scenario(settings)

    assert [hit.chunks[0].chunk_id for hit in hits] == ["A", "C", "B"]


@pytest.mark.req("REQ-RAG-4.1.2")
def test_rrf_no_duplicates(settings: Settings) -> None:
    """[REQ-RAG-4.1.2] 두 검색에 모두 나온 청크는 하나로 센다."""
    _, hits = _fused_scenario(settings)

    ids = [c.chunk_id for hit in hits for c in hit.chunks]
    assert sorted(ids) == ["A", "B", "C"]


@pytest.mark.req("REQ-RAG-4.1.2")
def test_rrf_score_depends_on_ranks(settings: Settings) -> None:
    """[REQ-RAG-4.1.2] 합친 점수는 순위가 앞설수록 크다(재정렬 실패 시 score가 합친 점수)."""
    # ★ 정확한 값은 구현 재량(RRF 상수)이라 단언하지 않는다
    _, hits = _fused_scenario(settings)

    score = {hit.chunks[0].chunk_id: hit.score for hit in hits}
    assert score["A"] > score["C"] > score["B"]


@pytest.mark.req("REQ-RAG-4.1.3")
def test_doc_ids_filter_passed(settings: Settings) -> None:
    """[REQ-RAG-4.1.3] doc_ids를 주면 두 조회의 ChunkFilter.doc_ids가 그 값이다."""
    store = scripted_store([rec("a", doc_id="d1")])

    run(
        make_searcher(store, FakeSearchHub(), settings).search(
            SearchQuery("q", doc_ids=("d1", "d3"))
        )
    )

    for method in ("search_dense", "search_sparse"):
        filters = store.filters(method)
        assert filters
        assert all(f.doc_ids == ("d1", "d3") for f in filters)


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.1.3")
def test_doc_ids_restricts_results(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.1.3] 결과의 doc_id가 모두 지정한 문서 안에 있다."""
    records = [rec("c1", doc_id="d1"), rec("c2", doc_id="d2"), rec("c3", doc_id="d3")]

    async def scenario() -> set[str]:
        async with backend_store(backend, monkeypatch, records) as store:
            searcher = make_searcher(store, FakeSearchHub(), settings)
            hits = await searcher.search(SearchQuery("q", top_n=10, doc_ids=("d1", "d3")))
            return {hit.doc_id for hit in hits}

    found = run(scenario())

    assert found
    assert found <= {"d1", "d3"}


@pytest.mark.req("REQ-RAG-4.1.4")
def test_asset_only_match_returned(settings: Settings) -> None:
    """[REQ-RAG-4.1.4] ASSET 레코드만 질의와 맞아도 그 청크가 결과에 나온다."""
    asset = rec("X", kind=ChunkKind.ASSET, pid="x1")
    store = scripted_store([asset, rec("T")], dense=["X"], sparse=["X"])

    hits = run(make_searcher(store, FakeSearchHub(), settings).search(SearchQuery("q", top_n=5)))

    found = [hit for hit in hits if hit.chunks[0].chunk_id == "X"]
    assert len(found) == 1
    assert found[0].chunks[0].kind == ChunkKind.ASSET
