"""판 처리(REQ-RAG-4.5) 테스트."""

from collections.abc import Callable
from datetime import date

import pytest

from minerva_rag.core import ChunkRecord, Settings
from minerva_rag.search import (
    EditionRef,
    EditionScope,
    ResultEdition,
    SearchHit,
    SearchQuery,
)

from ..resource.fakes import make_edition, run
from .fakes import (
    BACKENDS,
    FakeSearchHub,
    FakeSearchStore,
    backend_store,
    edition_data,
    make_searcher,
    rec,
    scripted_store,
    set_scores,
)

Make = Callable[..., Settings]
SPECIFIC_2022 = SearchQuery(
    "q", top_n=10, edition_scope=EditionScope.SPECIFIC, edition=EditionRef("표준", "2022")
)


def _by_doc(hits: tuple[SearchHit, ...]) -> dict[str, SearchHit]:
    """doc_id로 찾는 사전을 만든다."""
    return {hit.doc_id: hit for hit in hits}


async def _search(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    query: SearchQuery,
    records: list[ChunkRecord] | None = None,
) -> tuple[SearchHit, ...]:
    """backend 위에서 판 처리 데이터를 검색한다."""
    async with backend_store(backend, monkeypatch, records or edition_data()) as store:
        return await make_searcher(store, FakeSearchHub(), settings).search(query)


def _run_fake(
    store: FakeSearchStore, settings: Settings, query: SearchQuery, hub: FakeSearchHub | None = None
) -> tuple[SearchHit, ...]:
    """가짜 저장소에서 검색한다."""
    return run(make_searcher(store, hub or FakeSearchHub(), settings).search(query))


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.5.1")
def test_result_edition_and_name(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.5.1] 결과에 문서 이름이 있고, 판 정보는 있는 문서에만 있다."""
    hits = run(_search(backend, monkeypatch, settings, SearchQuery("q", top_n=10)))

    found = _by_doc(hits)
    assert set(found) == {"d-2022", "d-2025", "d-none"}
    assert found["d-2025"].edition == ResultEdition("2025", date(2025, 3, 1), True)
    assert found["d-2022"].edition == ResultEdition("2022", date(2022, 3, 1), False)
    assert found["d-none"].edition is None
    assert {hit.doc_id: hit.name for hit in hits} == {
        "d-2022": "표준",
        "d-2025": "표준",
        "d-none": "메모",
    }


@pytest.mark.req("REQ-RAG-4.5.2")
def test_other_editions_flag_true(settings: Settings) -> None:
    """[REQ-RAG-4.5.2] 2022판과 2025판 결과가 함께 나오면 둘 다 참이다."""
    found = _by_doc(_run_fake(scripted_store(edition_data()), settings, SearchQuery("q", top_n=10)))

    assert found["d-2022"].other_editions_in_results is True
    assert found["d-2025"].other_editions_in_results is True
    assert found["d-none"].other_editions_in_results is False


@pytest.mark.req("REQ-RAG-4.5.2")
def test_other_editions_flag_false_single(settings: Settings) -> None:
    """[REQ-RAG-4.5.2] 한 판만 나오거나 판 정보가 없는 결과는 거짓이다."""
    store = scripted_store(edition_data(), dense=["c-2025", "c-none"], sparse=["c-2025", "c-none"])

    found = _by_doc(_run_fake(store, settings, SearchQuery("q", top_n=10)))

    assert set(found) == {"d-2025", "d-none"}
    assert found["d-2025"].other_editions_in_results is False
    assert found["d-none"].other_editions_in_results is False


@pytest.mark.req("REQ-RAG-4.5.2")
def test_other_editions_same_label_false(settings: Settings) -> None:
    """[REQ-RAG-4.5.2] 판 표기가 같은 두 문서는 다른 판으로 표시하지 않는다."""
    records = [
        rec("a", doc_id="d-a", name="표준", edition=make_edition("2025"), latest=True),
        rec("b", doc_id="d-b", name="표준", edition=make_edition("2025"), latest=True),
    ]

    found = _by_doc(_run_fake(scripted_store(records), settings, SearchQuery("q", top_n=10)))

    assert found["d-a"].other_editions_in_results is False
    assert found["d-b"].other_editions_in_results is False


@pytest.mark.req("REQ-RAG-4.5.2")
def test_other_editions_only_final_n(settings: Settings) -> None:
    """[REQ-RAG-4.5.2] 다른 판 표시는 최종 결과 N개 안에서만 본다."""
    r22, r25, other = (
        rec("c-2022", doc_id="d-2022", name="표준", edition=make_edition("2022")),
        rec("c-2025", doc_id="d-2025", name="표준", edition=make_edition("2025"), latest=True),
        rec("c-other", doc_id="d-other", name="기타"),
    )
    hub = FakeSearchHub()
    set_scores(hub, [(r25, 0.9), (other, 0.5), (r22, 0.1)])

    found = _by_doc(
        _run_fake(scripted_store([r22, r25, other]), settings, SearchQuery("q", top_n=2), hub)
    )

    assert set(found) == {"d-2025", "d-other"}
    assert found["d-2025"].other_editions_in_results is False


@pytest.mark.req("REQ-RAG-4.5.3")
def test_specific_filter_passed(settings: Settings) -> None:
    """[REQ-RAG-4.5.3] SPECIFIC이면 두 조회의 ChunkFilter에 판 이름·표기를 준다."""
    store = scripted_store(edition_data())

    _run_fake(store, settings, SPECIFIC_2022)

    for method in ("search_dense", "search_sparse"):
        filters = store.filters(method)
        assert filters
        for flt in filters:
            assert flt.edition_name == "표준"
            assert flt.edition_label == "2022"
            assert flt.latest_or_unversioned is False


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.5.3")
def test_specific_only_that_edition(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.5.3] 지정한 판의 청크만 결과에 나온다."""
    hits = run(_search(backend, monkeypatch, settings, SPECIFIC_2022))

    assert {hit.doc_id for hit in hits} == {"d-2022"}


@pytest.mark.req("REQ-RAG-4.5.3")
def test_specific_ignores_edition_outside(settings: Settings) -> None:
    """[REQ-RAG-4.5.3] SPECIFIC이 아니면 edition 값은 쓰지 않는다."""
    store = scripted_store(edition_data())
    query = SearchQuery("q", edition_scope=EditionScope.ALL, edition=EditionRef("표준", "2022"))

    _run_fake(store, settings, query)

    for method in ("search_dense", "search_sparse"):
        filters = store.filters(method)
        assert filters
        for flt in filters:
            assert flt.edition_name is None
            assert flt.edition_label is None


@pytest.mark.req("REQ-RAG-4.5.4")
def test_latest_filter_passed(settings: Settings) -> None:
    """[REQ-RAG-4.5.4] LATEST면 두 조회의 latest_or_unversioned가 참이고 판 이름·표기는 없다."""
    store = scripted_store(edition_data())

    _run_fake(store, settings, SearchQuery("q", edition_scope=EditionScope.LATEST))

    for method in ("search_dense", "search_sparse"):
        filters = store.filters(method)
        assert filters
        for flt in filters:
            assert flt.latest_or_unversioned is True
            assert flt.edition_name is None
            assert flt.edition_label is None


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.5.4")
def test_latest_only_newest(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.5.4] 2022·2025판이 있는 이름에서 2025판 청크만 나온다."""
    query = SearchQuery("q", top_n=10, edition_scope=EditionScope.LATEST)

    hits = run(_search(backend, monkeypatch, settings, query))

    found = {hit.doc_id for hit in hits}
    assert "d-2025" in found
    assert "d-2022" not in found


def _weighted_hits(settings: Settings) -> tuple[tuple[SearchHit, ...], dict[str, float]]:
    """재정렬 점수가 2022 > 판 없음 > 2025인 데이터를 검색한다."""
    records = edition_data()
    raw = {"d-2022": 0.9, "d-none": 0.5, "d-2025": 0.1}
    hub = FakeSearchHub()
    set_scores(hub, [(r, raw[r.doc_id]) for r in records])
    hits = _run_fake(scripted_store(records), settings, SearchQuery("q", top_n=10), hub)
    return hits, raw


@pytest.mark.req("REQ-RAG-4.5.5")
def test_weight_zero_same_order(make_settings: Make) -> None:
    """[REQ-RAG-4.5.5] 가중치가 0이면 순위가 재정렬 점수 순이고 score가 재정렬 점수다."""
    hits, raw = _weighted_hits(make_settings(weight=0.0))

    assert [hit.doc_id for hit in hits] == ["d-2022", "d-none", "d-2025"]
    assert [hit.score for hit in hits] == pytest.approx([raw[hit.doc_id] for hit in hits])


@pytest.mark.req("REQ-RAG-4.5.5")
def test_weight_positive_adds(make_settings: Make) -> None:
    """[REQ-RAG-4.5.5] 가중치가 양수이면 최신판 결과의 점수가 그만큼 크다."""
    hits, raw = _weighted_hits(make_settings(weight=1.0))

    found = _by_doc(hits)
    assert found["d-2025"].score == pytest.approx(raw["d-2025"] + 1.0)
    assert found["d-2022"].score == pytest.approx(raw["d-2022"])
    assert found["d-none"].score == pytest.approx(raw["d-none"])
    assert hits[0].doc_id == "d-2025"


@pytest.mark.req("REQ-RAG-4.5.5", "REQ-RAG-4.2.2")
def test_weight_on_fallback_score(make_settings: Make) -> None:
    """[REQ-RAG-4.5.5] 재정렬이 실패해도 합친 점수에 최신판 가중치를 더한다."""

    def scores(weight: float) -> dict[str, float]:
        hub = FakeSearchHub()
        hub.rerank_error = RuntimeError("실패")
        script = ["c-2025", "c-2022", "c-none"]
        store = scripted_store(edition_data(), dense=script, sparse=script)
        hits = _run_fake(store, make_settings(weight=weight), SearchQuery("q", top_n=10), hub)
        return {hit.doc_id: hit.score for hit in hits}

    base = scores(0.0)
    weighted = scores(0.5)

    assert weighted["d-2025"] - base["d-2025"] == pytest.approx(0.5)
    assert weighted["d-2022"] == pytest.approx(base["d-2022"])
    assert weighted["d-none"] == pytest.approx(base["d-none"])


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize(
    ("scope", "expect_none"),
    [(EditionScope.ALL, True), (EditionScope.LATEST, True), (EditionScope.SPECIFIC, False)],
)
@pytest.mark.req("REQ-RAG-4.5.6")
def test_unversioned_scope(
    backend: str,
    scope: EditionScope,
    expect_none: bool,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """[REQ-RAG-4.5.6] 판 정보 없는 문서는 ALL·LATEST에서는 나오고 SPECIFIC에서는 나오지 않는다."""
    edition = EditionRef("표준", "2025") if scope is EditionScope.SPECIFIC else None
    query = SearchQuery("q", top_n=10, edition_scope=scope, edition=edition)

    hits = run(_search(backend, monkeypatch, settings, query))

    assert ("d-none" in {hit.doc_id for hit in hits}) is expect_none
