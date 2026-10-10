"""evaluation 평가 요청(REQ-RAG-6.1) 테스트."""

from collections.abc import Callable
from pathlib import Path

import pytest

from minerva_rag.core import InvalidRequestError, Settings
from minerva_rag.evaluation import EvaluationCase

from ..resource.fakes import run
from .fakes import DOC_ID, SPAN, FakeSearcher, case, filler, hit, make_evaluator

_BLANKS = ["", " \n\t　﻿", "   ", " "]


@pytest.mark.req("REQ-RAG-6.1.1")
def test_n_is_requested_top_n(settings: Settings) -> None:
    """[REQ-RAG-6.1.1] n은 요청한 N이다."""
    fake = FakeSearcher([filler(i) for i in range(1, 5)])
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=4)))
    assert result.n == 4


@pytest.mark.req("REQ-RAG-6.1.1")
def test_n_defaults_to_setting(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-6.1.1] N이 없으면 n은 RAG_SEARCH_DEFAULT_TOP_N이다."""
    fake = FakeSearcher([filler(1)])
    result = run(make_evaluator(fake, make_settings(top_n=7)).evaluate(case(top_n=None)))
    assert result.n == 7


@pytest.mark.req("REQ-RAG-6.1.1")
def test_case_defaults() -> None:
    """[REQ-RAG-6.1.1] edition_only와 top_n의 기본값은 False와 None이다."""
    c = EvaluationCase(query="q", doc_id=DOC_ID, answer_span=SPAN)
    assert c.edition_only is False
    assert c.top_n is None


@pytest.mark.req("REQ-RAG-6.1.1")
def test_query_and_doc_id_are_used(settings: Settings) -> None:
    """[REQ-RAG-6.1.1] 질의와 정답 문서 ID가 그대로 쓰인다."""
    fake = FakeSearcher([filler(1)])
    run(make_evaluator(fake, settings).evaluate(case(doc_id="doc-9", query="q-원문")))
    assert fake.doc_ids == ["doc-9"]
    assert fake.queries[0].query == "q-원문"


@pytest.mark.req("REQ-RAG-6.1.1")
@pytest.mark.parametrize("top_n", [0, -1])
def test_top_n_below_one_rejected(top_n: int) -> None:
    """[REQ-RAG-6.1.1] top_n이 1 미만이면 만들 때 ValueError를 낸다."""
    with pytest.raises(ValueError):
        EvaluationCase(query="q", doc_id=DOC_ID, answer_span=SPAN, top_n=top_n)


@pytest.mark.req("REQ-RAG-6.1.1")
@pytest.mark.parametrize("span", _BLANKS)
def test_blank_answer_span_rejected(settings: Settings, span: str) -> None:
    """[REQ-RAG-6.1.1] 공백만 든 정답 구간은 InvalidRequestError이고 search를 부르지 않는다."""
    fake = FakeSearcher([hit(1, SPAN)])
    with pytest.raises(InvalidRequestError) as info:
        run(make_evaluator(fake, settings).evaluate(case(answer_span=span)))
    assert info.value.code == "INVALID_REQUEST"
    assert fake.calls == []


@pytest.mark.req("REQ-RAG-6.1.2")
def test_only_search_is_called(settings: Settings) -> None:
    """[REQ-RAG-6.1.2] search 말고는 document_chunks만 부르고 search는 한 번이다."""
    fake = FakeSearcher([hit(1, SPAN)])
    run(make_evaluator(fake, settings).evaluate(case()))
    assert set(fake.calls) <= {"document_chunks", "search"}
    assert fake.calls.count("search") == 1


@pytest.mark.req("REQ-RAG-6.1.2")
def test_no_files_written(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """[REQ-RAG-6.1.2] 평가 뒤 작업 폴더에 파일이 생기지 않는다."""
    monkeypatch.chdir(tmp_path)
    run(make_evaluator(FakeSearcher([hit(1, SPAN)]), settings).evaluate(case()))
    run(make_evaluator(FakeSearcher([filler(1)]), settings).evaluate(case()))
    assert list(tmp_path.iterdir()) == []


# ── 적중으로 세는 결과의 범위 (REQ-RAG-6.1.3) ─────────────────────


@pytest.mark.req("REQ-RAG-6.1.3")
@pytest.mark.parametrize(("edition_only", "rank"), [(False, 1), (True, None)])
def test_other_edition_same_name(settings: Settings, edition_only: bool, rank: int | None) -> None:
    """[REQ-RAG-6.1.3] 같은 이름의 다른 판은 edition_only가 거짓일 때만 적중이다."""
    fake = FakeSearcher([hit(1, SPAN, doc_id="doc-2")])
    result = run(make_evaluator(fake, settings).evaluate(case(edition_only=edition_only)))
    assert result.base.rank == rank
    assert result.expanded.rank == rank


@pytest.mark.req("REQ-RAG-6.1.3")
@pytest.mark.parametrize("edition_only", [False, True])
def test_other_name_never_hit(settings: Settings, edition_only: bool) -> None:
    """[REQ-RAG-6.1.3] 이름이 다른 문서의 결과는 어느 쪽이든 적중이 아니다."""
    fake = FakeSearcher([hit(1, SPAN, doc_id="doc-3", name="다른 문서")])
    result = run(make_evaluator(fake, settings).evaluate(case(edition_only=edition_only)))
    assert result.base.rank is None
    assert result.expanded.rank is None


@pytest.mark.req("REQ-RAG-6.1.3")
@pytest.mark.parametrize("edition_only", [False, True])
def test_answer_doc_hit_both_modes(settings: Settings, edition_only: bool) -> None:
    """[REQ-RAG-6.1.3] 정답 문서의 결과는 두 모드 모두 적중이다."""
    fake = FakeSearcher([hit(1, SPAN)])
    result = run(make_evaluator(fake, settings).evaluate(case(edition_only=edition_only)))
    assert result.base.rank == 1
    assert result.expanded.rank == 1


@pytest.mark.req("REQ-RAG-6.1.3")
@pytest.mark.parametrize(("edition_only", "rank"), [(False, 2), (True, 3)])
def test_candidate_rule_picks_later_rank(settings: Settings, edition_only: bool, rank: int) -> None:
    """[REQ-RAG-6.1.3] 적중 후보 규칙에 따라 처음 적중한 순위가 달라진다."""
    hits = [
        hit(1, SPAN, doc_id="doc-3", name="다른 문서"),
        hit(2, SPAN, doc_id="doc-2"),
        hit(3, SPAN),
    ]
    result = run(
        make_evaluator(FakeSearcher(hits), settings).evaluate(case(edition_only=edition_only))
    )
    assert result.base.rank == rank
    assert result.expanded.rank == rank
