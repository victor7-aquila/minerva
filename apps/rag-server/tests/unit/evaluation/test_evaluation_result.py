"""evaluation 결과 반환·오류(REQ-RAG-6.3) 테스트."""

import pytest

from minerva_rag.core import DocumentNotSearchableError, Settings
from minerva_rag.evaluation import EvaluationResult

from ..resource.fakes import run
from .fakes import SPAN, FakeSearcher, case, hit, make_evaluator, unsearchable_doc


@pytest.mark.req("REQ-RAG-6.3.1")
def test_returns_evaluation_result(settings: Settings) -> None:
    """[REQ-RAG-6.3.1] evaluate는 EvaluationResult를 돌려준다."""
    result = run(make_evaluator(FakeSearcher([hit(1, SPAN)]), settings).evaluate(case()))
    assert isinstance(result, EvaluationResult)
    assert result.n == 5


@pytest.mark.req("REQ-RAG-6.3.2")
def test_not_searchable_raises(settings: Settings) -> None:
    """[REQ-RAG-6.3.2] 검색되는 버전이 없는 문서는 오류이고 search를 부르지 않는다."""
    fake = FakeSearcher([hit(1, SPAN)], doc=unsearchable_doc())
    with pytest.raises(DocumentNotSearchableError):
        run(make_evaluator(fake, settings).evaluate(case()))
    assert "search" not in fake.calls


@pytest.mark.req("REQ-RAG-6.3.2")
def test_not_searchable_code(settings: Settings) -> None:
    """[REQ-RAG-6.3.2] 오류 코드는 DOCUMENT_NOT_SEARCHABLE이다."""
    fake = FakeSearcher([hit(1, SPAN)], doc=unsearchable_doc())
    with pytest.raises(DocumentNotSearchableError) as info:
        run(make_evaluator(fake, settings).evaluate(case()))
    assert info.value.code == "DOCUMENT_NOT_SEARCHABLE"
