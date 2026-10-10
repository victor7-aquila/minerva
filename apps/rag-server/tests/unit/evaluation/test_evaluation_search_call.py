"""evaluation 검색 호출(REQ-RAG-6.2.1) 테스트."""

from collections.abc import Callable

import pytest

from minerva_rag.core import (
    MinervaError,
    ModelUnavailableError,
    Settings,
    StoreUnavailableError,
    VectorDimensionMismatchError,
)
from minerva_rag.search import EditionScope, SearchQuery

from ..resource.fakes import run
from .fakes import SPAN, FakeSearcher, case, hit, make_evaluator


@pytest.mark.req("REQ-RAG-6.2.1")
@pytest.mark.parametrize("edition_only", [False, True])
def test_search_called_once_with_args(settings: Settings, edition_only: bool) -> None:
    """[REQ-RAG-6.2.1] search를 정확히 한 번, 정해진 인자로 부른다."""
    fake = FakeSearcher([hit(1, SPAN)])
    evaluator = make_evaluator(fake, settings)
    run(evaluator.evaluate(case(query="질의", top_n=5, edition_only=edition_only)))
    assert fake.queries == [
        SearchQuery("질의", top_n=5, edition_scope=EditionScope.ALL, expand_neighbors=True)
    ]


@pytest.mark.req("REQ-RAG-6.2.1")
def test_search_uses_default_n(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-6.2.1] N이 없으면 기본 개수로 채운 값을 search에 넘긴다."""
    fake = FakeSearcher([hit(1, SPAN)])
    run(make_evaluator(fake, make_settings(top_n=7)).evaluate(case(top_n=None)))
    assert fake.queries[0].top_n == 7


@pytest.mark.req("REQ-RAG-6.2.1")
def test_document_chunks_before_search(settings: Settings) -> None:
    """[REQ-RAG-6.2.1] document_chunks를 search보다 먼저 부른다."""
    fake = FakeSearcher([hit(1, SPAN)])
    run(make_evaluator(fake, settings).evaluate(case()))
    assert fake.calls.index("document_chunks") < fake.calls.index("search")


@pytest.mark.req("REQ-RAG-6.2.1")
@pytest.mark.parametrize(
    "error", [StoreUnavailableError(), VectorDimensionMismatchError(), ModelUnavailableError()]
)
def test_search_errors_propagate(settings: Settings, error: MinervaError) -> None:
    """[REQ-RAG-6.2.1] search가 내는 resource 예외는 그대로 전파한다."""
    fake = FakeSearcher([hit(1, SPAN)])
    fake.search_error = error
    with pytest.raises(MinervaError) as info:
        run(make_evaluator(fake, settings).evaluate(case()))
    assert info.value is error


@pytest.mark.req("REQ-RAG-6.2.1")
def test_document_chunks_errors_propagate(settings: Settings) -> None:
    """[REQ-RAG-6.2.1] document_chunks의 예외도 그대로 전파하고 search는 부르지 않는다."""
    error = StoreUnavailableError()
    fake = FakeSearcher([hit(1, SPAN)])
    fake.chunks_error = error
    with pytest.raises(StoreUnavailableError) as info:
        run(make_evaluator(fake, settings).evaluate(case()))
    assert info.value is error
    assert "search" not in fake.calls
