"""검색 서비스(REQ-RAG-10.4)와 평가 서비스(REQ-RAG-10.7) 테스트."""

from typing import cast

import pytest

from minerva_rag.core import Settings, StoreUnavailableError
from minerva_rag.evaluation import Evaluator
from minerva_rag.search import Searcher, SearchQuery
from minerva_rag.service import EvaluationService, SearchService

from .fakes import (
    FakeEvaluator,
    FakeReceiver,
    FakeSearcher,
    ReadyStub,
    eval_case,
    go,
    wire,
)


def _search_service(fake: FakeSearcher) -> SearchService:
    """가짜 Searcher로 검색 서비스를 만든다."""
    return SearchService(cast(Searcher, fake), ReadyStub(True))


@pytest.mark.req("REQ-RAG-10.4.1")
def test_search_calls_once() -> None:
    """[REQ-RAG-10.4.1] 검색 한 번에 Searcher.search가 한 번 불리고 결과를 그대로 돌려준다."""
    fake = FakeSearcher()
    query = SearchQuery("질의", top_n=3)

    result = go(_search_service(fake).search(query))

    assert result == fake.hits
    searches = [entry for entry in fake.timeline if entry[0] == "search"]
    assert len(searches) == 1
    assert searches[0][1] is query


@pytest.mark.req("REQ-RAG-10.4.1")
def test_document_chunks_delegates() -> None:
    """[REQ-RAG-10.4.1] 문서 청크 조회는 Searcher의 결과를 그대로 돌려준다."""
    fake = FakeSearcher()

    result = go(_search_service(fake).document_chunks("doc-a"))

    assert result is fake.doc
    assert fake.timeline == [("document_chunks", "doc-a")]


@pytest.mark.req("REQ-RAG-10.4.2")
def test_search_empty() -> None:
    """[REQ-RAG-10.4.2] 검색 결과가 비어 있으면 오류 없이 빈 값을 돌려준다."""
    fake = FakeSearcher()
    fake.hits = ()

    assert go(_search_service(fake).search(SearchQuery("질의"))) == ()


@pytest.mark.req("REQ-RAG-10.4.1")
def test_search_errors_propagate() -> None:
    """[REQ-RAG-10.4.1] search의 도메인 예외는 같은 예외로 전파된다."""
    fake = FakeSearcher()
    error = StoreUnavailableError()
    fake.error = error

    with pytest.raises(StoreUnavailableError) as caught:
        go(_search_service(fake).search(SearchQuery("질의")))

    assert caught.value is error


@pytest.mark.req("REQ-RAG-10.7.1")
def test_evaluate_passes_result() -> None:
    """[REQ-RAG-10.7.1] 평가 결과를 그대로 돌려주고 Evaluator.evaluate를 한 번 부른다."""
    fake = FakeEvaluator()
    service = EvaluationService(cast(Evaluator, fake), ReadyStub(True))
    case = eval_case()

    result = go(service.evaluate(case))

    assert result is fake.result
    assert fake.timeline == [("evaluate", case)]


@pytest.mark.req("REQ-RAG-10.7.1")
def test_evaluate_no_jobs(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.7.1] 평가는 작업 관리자를 부르지 않고 알림도 보내지 않는다."""
    services, parts = wire(monkeypatch, settings)

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            parts.timeline.clear()
            result = await services.evaluation.evaluate(eval_case())
            assert result is parts.evaluator.result
            assert [entry[0] for entry in parts.timeline] == ["evaluate"]
        finally:
            await services.lifecycle.shutdown()

    go(scenario())
    assert receiver.requests == []
