"""재정렬(REQ-RAG-4.2) 테스트."""

from collections.abc import Sequence
from pathlib import Path

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import ModelUnavailableError, Settings
from minerva_rag.search import SearchQuery

from ..resource.fakes import assert_log, assert_logs_exclude, events_named, run
from .fakes import (
    EXAMPLE_GLOSSARY,
    FakeSearchHub,
    make_searcher,
    rec,
    scripted_store,
    set_scores,
    write_glossary,
)

_FAILURES = [RuntimeError("x"), ValueError("x"), ModelUnavailableError()]


@pytest.mark.req("REQ-RAG-4.2.1")
def test_rerank_reorders(settings: Settings) -> None:
    """[REQ-RAG-4.2.1] 재정렬 점수가 합친 순위와 다르면 결과가 재정렬 점수 순이다."""
    a, b, c = rec("A"), rec("B"), rec("C")
    store = scripted_store([a, b, c], dense=["A", "B", "C"], sparse=["A", "B", "C"])
    hub = FakeSearchHub()
    set_scores(hub, [(c, 0.9), (b, 0.5), (a, 0.1)])

    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=5)))

    assert [hit.chunks[0].chunk_id for hit in hits] == ["C", "B", "A"]
    assert [hit.score for hit in hits] == pytest.approx([0.9, 0.5, 0.1])


@pytest.mark.req("REQ-RAG-4.2.1")
def test_rerank_passages_are_chunk_text(settings: Settings) -> None:
    """[REQ-RAG-4.2.1] 합친 후보의 청크 원문(자리표시 포함)으로 rerank를 부른다."""
    plain = rec("A")
    with_placeholder = rec("B", placeholder_ids=("t1",))
    store = scripted_store([plain, with_placeholder], dense=["A", "B"], sparse=["A", "B"])
    hub = FakeSearchHub()

    run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=5)))

    passages = {p for _, texts in hub.rerank_calls for p in texts}
    assert {plain.chunk.text, with_placeholder.chunk.text} <= passages
    assert "[[minerva:table:t1" in with_placeholder.chunk.text


@pytest.mark.req("REQ-RAG-4.2.1")
def test_rerank_query_is_expanded(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.2.1] 재정렬의 질의도 확장한 질의다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    hub = FakeSearchHub()
    searcher = make_searcher(scripted_store([rec("A")]), hub, settings)

    run(searcher.search(SearchQuery("cert")))

    # ★ 확장 질의 문자열의 형식은 구현 재량이라 원래 질의와 확장한 말이 들어 있는지만 본다
    assert hub.rerank_calls
    for expected in ("cert", "인증서", "certificate", "인증 문서"):
        assert expected in hub.rerank_calls[0][0]


def _failing_search(
    settings: Settings, error: BaseException, scores: tuple[float, float, float]
) -> tuple[list[str], list[float]]:
    """dense [A, B, C]와 키워드 [A, C]로 재정렬을 실패시킨 검색의 순서와 점수를 돌려준다.

    ★ 동점이 없다. 합친 순위는 A, C(두 검색), B(dense만) 순이다.
    """
    a, b, c = rec("A"), rec("B"), rec("C")
    store = scripted_store([a, b, c], dense=["A", "B", "C"], sparse=["A", "C"])
    hub = FakeSearchHub()
    hub.rerank_error = error
    set_scores(hub, [(a, scores[0]), (b, scores[1]), (c, scores[2])])
    hits = run(make_searcher(store, hub, settings).search(SearchQuery("q", top_n=5)))
    return [hit.chunks[0].chunk_id for hit in hits], [hit.score for hit in hits]


@pytest.mark.parametrize("error", _FAILURES)
@pytest.mark.req("REQ-RAG-4.2.2")
def test_rerank_failure_falls_back(settings: Settings, error: BaseException) -> None:
    """[REQ-RAG-4.2.2] rerank가 어떤 예외를 내도 검색은 합친 순위로 결과를 돌려준다."""
    ids, scores = _failing_search(settings, error, (0.1, 0.5, 0.9))

    assert ids == ["A", "C", "B"]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.req("REQ-RAG-4.2.2")
def test_rerank_failure_score_is_fused(settings: Settings) -> None:
    """[REQ-RAG-4.2.2] 재정렬이 실패하면 score는 재정렬 점수가 아니라 합친 점수다."""
    first = _failing_search(settings, RuntimeError("x"), (10.0, 20.0, 30.0))
    second = _failing_search(settings, ValueError("x"), (50.0, 40.0, 5.0))

    assert first[0] == second[0]
    assert first[1] == pytest.approx(second[1])
    assert first[0] == ["A", "C", "B"]
    assert first[1] == sorted(first[1], reverse=True)
    given = {10.0, 20.0, 30.0, 50.0, 40.0, 5.0}
    assert all(score not in given for score in first[1] + second[1])


@pytest.mark.req("REQ-RAG-4.2.2")
def test_rerank_failure_warns(settings: Settings) -> None:
    """[REQ-RAG-4.2.2] 재정렬 실패 시 search.rerank_failed 경고 로그가 남는다."""
    records = [rec("A"), rec("B")]
    store = scripted_store(records)
    hub = FakeSearchHub()
    hub.rerank_error = RuntimeError("실패")
    searcher = make_searcher(store, hub, settings)

    with capture_logs() as logs:
        run(searcher.search(SearchQuery("비밀 질의", top_n=5)))

    assert_log(logs, "search.rerank_failed", "warning", {"candidates", "error_type"})
    assert len(events_named(logs, "search.rerank_failed")) >= 1
    # ★ 질의 원문과 청크 본문은 로그에 남기지 않는다
    assert_logs_exclude(logs, ["비밀 질의", *(r.chunk.text for r in records)])


class _BadScoresHub(FakeSearchHub):
    """rerank가 정해 둔 점수 목록을 그대로(개수와 상관없이) 돌려준다."""

    def __init__(self, scores: list[float]) -> None:
        super().__init__()
        self._bad_scores = scores

    async def rerank(self, query: str, passages: Sequence[str]) -> list[float]:
        """호출을 기록하고 정해 둔 점수 목록을 돌려준다."""
        self.rerank_calls.append((query, list(passages)))
        return list(self._bad_scores)


@pytest.mark.parametrize(
    "bad_scores",
    [[0.9, 0.1], [0.9, 0.5, 0.1, 0.0], [], [0.9, float("nan"), 0.1], [0.9, float("inf"), 0.1]],
)
@pytest.mark.req("REQ-RAG-4.2.2")
def test_rerank_invalid_scores_fall_back(settings: Settings, bad_scores: list[float]) -> None:
    """[REQ-RAG-4.2.2] 점수 개수 불일치·NaN·inf면 합친 순위·점수로 대신하고 경고한다."""
    a, b, c = rec("A"), rec("B"), rec("C")
    store = scripted_store([a, b, c], dense=["A", "B", "C"], sparse=["A", "C"])
    searcher = make_searcher(store, _BadScoresHub(bad_scores), settings)

    with capture_logs() as logs:
        hits = run(searcher.search(SearchQuery("q", top_n=5)))

    assert [hit.chunks[0].chunk_id for hit in hits] == ["A", "C", "B"]
    assert [hit.score for hit in hits] == sorted((hit.score for hit in hits), reverse=True)
    assert all(hit.score not in {0.9, 0.5, 0.1} for hit in hits)
    assert_log(logs, "search.rerank_failed", "warning", {"candidates", "error_type"})
    assert len(events_named(logs, "search.rerank_failed")) == 1
