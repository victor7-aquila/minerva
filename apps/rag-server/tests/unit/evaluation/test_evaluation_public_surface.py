"""evaluation 공개 표면 고정 테스트 (contract 도구가 없어 service·api가 기대는 형태를 고정한다)."""

import inspect
from typing import get_type_hints

import pytest

import minerva_rag.evaluation as evaluation
from minerva_rag.core import Settings
from minerva_rag.evaluation import EvaluationCase, EvaluationMetrics, EvaluationResult, Evaluator
from minerva_rag.search import Searcher


@pytest.mark.req("REQ-RAG-6.1.1")
def test_package_exports() -> None:
    """[REQ-RAG-6.1.1] 패키지가 공개 이름 넷을 내보낸다."""
    exported = set(evaluation.__all__)
    assert {"Evaluator", "EvaluationCase", "EvaluationResult", "EvaluationMetrics"} <= exported


@pytest.mark.req("REQ-RAG-6.1.1")
def test_case_fields() -> None:
    """[REQ-RAG-6.1.1] EvaluationCase의 필드 이름·타입·기본값이 명세와 같다."""
    hints = get_type_hints(EvaluationCase)
    assert hints == {
        "query": str,
        "doc_id": str,
        "answer_span": str,
        "edition_only": bool,
        "top_n": int | None,
    }
    c = EvaluationCase(query="q", doc_id="d", answer_span="ABC")
    assert c.edition_only is False
    assert c.top_n is None


@pytest.mark.req("REQ-RAG-6.2.5")
def test_metrics_fields() -> None:
    """[REQ-RAG-6.2.5] EvaluationMetrics의 필드 이름·타입이 명세와 같다."""
    assert get_type_hints(EvaluationMetrics) == {
        "hit_at_1": bool,
        "hit_at_3": bool,
        "hit_at_5": bool,
        "hit_at_n": bool,
        "rank": int | None,
        "reciprocal_rank": float,
        "coverage": float,
    }


@pytest.mark.req("REQ-RAG-6.3.1")
def test_result_fields() -> None:
    """[REQ-RAG-6.3.1] EvaluationResult의 필드 이름·타입이 명세와 같다."""
    assert get_type_hints(EvaluationResult) == {
        "n": int,
        "base": EvaluationMetrics,
        "expanded": EvaluationMetrics,
    }


@pytest.mark.req("REQ-RAG-6.1.1")
def test_evaluator_signature() -> None:
    """[REQ-RAG-6.1.1] Evaluator의 생성자와 evaluate 시그니처가 명세와 같다."""
    init = inspect.signature(Evaluator.__init__, eval_str=True)
    assert list(init.parameters) == ["self", "searcher", "settings"]
    assert init.parameters["searcher"].annotation is Searcher
    assert init.parameters["settings"].annotation is Settings
    evaluate = inspect.signature(Evaluator.evaluate, eval_str=True)
    assert list(evaluate.parameters) == ["self", "case"]
    assert evaluate.parameters["case"].annotation is EvaluationCase
    assert evaluate.return_annotation is EvaluationResult
    assert inspect.iscoroutinefunction(Evaluator.evaluate)
