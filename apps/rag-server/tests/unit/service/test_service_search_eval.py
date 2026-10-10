"""검색 서비스(REQ-RAG-10.4)와 평가 서비스(REQ-RAG-10.7) 테스트."""

from typing import cast

import pytest

from minerva_rag.core import (
    BatchIndexingError,
    InvalidRequestError,
    Settings,
    StoreUnavailableError,
)
from minerva_rag.evaluation import Evaluator
from minerva_rag.search import Searcher, SearchQuery
from minerva_rag.service import EvaluationService, SearchService

from .fakes import (
    FakeEvaluator,
    FakeJobQueue,
    FakeReceiver,
    FakeSearcher,
    ReadyStub,
    eval_case,
    go,
    wire,
)


def _search_service(fake: FakeSearcher, queue: FakeJobQueue | None = None) -> SearchService:
    """가짜 Searcher와 가짜 작업 큐로 검색 서비스를 만든다. 큐는 Searcher의 timeline에 기록한다."""
    jobs = queue if queue is not None else FakeJobQueue(fake.timeline)
    return SearchService(cast(Searcher, fake), jobs, ReadyStub(True))


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
    # 거부가 없으면 거부 확인 → 검색 순이다
    assert [entry[0] for entry in fake.timeline] == ["queue.reject", "search"]


@pytest.mark.req("REQ-RAG-10.4.1")
def test_document_chunks_delegates() -> None:
    """[REQ-RAG-10.4.1] 문서 청크 조회는 Searcher의 결과를 그대로 돌려준다."""
    fake = FakeSearcher()

    result = go(_search_service(fake).document_chunks("doc-a"))

    assert result is fake.doc
    # 문서 청크 조회는 일괄 색인 중에도 거부하지 않는다(거부 확인을 부르지 않는다)
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
    service = EvaluationService(cast(Evaluator, fake), FakeJobQueue(fake.timeline), ReadyStub(True))
    case = eval_case()

    result = go(service.evaluate(case))

    assert result is fake.result
    assert [entry for entry in fake.timeline if entry[0] == "evaluate"] == [("evaluate", case)]


@pytest.mark.req("REQ-RAG-10.4.3")
def test_search_rejects_via_queue() -> None:
    """[REQ-RAG-10.4.3] 일괄 색인 거부 오류가 그대로 나가고 Searcher.search는 불리지 않는다."""
    fake = FakeSearcher()
    queue = FakeJobQueue(fake.timeline)
    error = BatchIndexingError(2)
    queue.reject_error = error
    service = _search_service(fake, queue)

    with pytest.raises(BatchIndexingError) as caught:
        go(service.search(SearchQuery("질의")))

    assert caught.value is error
    assert "search" not in [entry[0] for entry in fake.timeline]
    # 문서 청크 조회는 거부하지 않고 결과를 돌려준다
    fake.timeline.clear()
    assert go(service.document_chunks("doc-a")) is fake.doc
    assert ("queue.reject",) not in fake.timeline


@pytest.mark.req("REQ-RAG-10.7.2")
def test_evaluate_order() -> None:
    """[REQ-RAG-10.7.2] 평가는 입력 검증 → 일괄 색인 거부 확인 → 평가 순으로 부른다."""
    fake = FakeEvaluator()
    service = EvaluationService(cast(Evaluator, fake), FakeJobQueue(fake.timeline), ReadyStub(True))

    go(service.evaluate(eval_case()))

    assert [entry[0] for entry in fake.timeline] == ["validate", "queue.reject", "evaluate"]


@pytest.mark.req("REQ-RAG-10.7.2")
def test_evaluate_validate_before_reject() -> None:
    """[REQ-RAG-10.7.2] 입력 검증이 거부 확인보다 먼저다 — 일괄 색인 중에도 잘못된 입력은
    InvalidRequestError다."""
    fake = FakeEvaluator()
    queue = FakeJobQueue(fake.timeline)
    queue.reject_error = BatchIndexingError(3)
    fake.validate_error = InvalidRequestError()
    service = EvaluationService(cast(Evaluator, fake), queue, ReadyStub(True))

    with pytest.raises(InvalidRequestError):
        go(service.evaluate(eval_case(answer_span="   ")))

    names = [entry[0] for entry in fake.timeline]
    assert "queue.reject" not in names
    assert "evaluate" not in names


@pytest.mark.req("REQ-RAG-10.7.2")
def test_evaluate_rejected() -> None:
    """[REQ-RAG-10.7.2] 일괄 색인 거부 오류가 그대로 나가고 Evaluator.evaluate는 불리지 않는다."""
    fake = FakeEvaluator()
    queue = FakeJobQueue(fake.timeline)
    error = BatchIndexingError(1)
    queue.reject_error = error
    service = EvaluationService(cast(Evaluator, fake), queue, ReadyStub(True))

    with pytest.raises(BatchIndexingError) as caught:
        go(service.evaluate(eval_case()))

    assert caught.value is error
    assert "evaluate" not in [entry[0] for entry in fake.timeline]


@pytest.mark.req("REQ-RAG-10.7.1")
def test_evaluate_no_jobs(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.7.1] 평가는 작업을 접수하지 않고 알림도 보내지 않는다. 작업 큐에는 거부
    확인만 한다."""
    services, parts = wire(monkeypatch, settings)

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            parts.timeline.clear()
            result = await services.evaluation.evaluate(eval_case())
            assert result is parts.evaluator.result
            assert [entry[0] for entry in parts.timeline] == [
                "validate",
                "jobs.reject_during_batch",
                "evaluate",
            ]
        finally:
            await services.lifecycle.shutdown()

    go(scenario())
    assert receiver.requests == []
