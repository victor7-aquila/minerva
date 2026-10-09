"""search의 금지 의존과 오류 전파 테스트."""

import pytest

from minerva_rag.core import (
    Settings,
    StoreUnavailableError,
    VectorDimensionMismatchError,
)
from minerva_rag.search import SearchQuery

from ..resource.fakes import run
from .fakes import FakeSearchHub, make_searcher, rec, scripted_store


@pytest.mark.req("REQ-RAG-4.1.1")
def test_search_never_writes(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 앞뒤 청크·분할 조각·재정렬 실패를 거치는 검색도 저장소에 쓰지 않는다."""
    records = [
        rec("c1", order=1),
        rec("g1", order=2, split=("g", 1, 2)),
        rec("g2", order=2, split=("g", 2, 2)),
        rec("c3", order=3),
    ]
    store = scripted_store(records)
    ok_hub, failing_hub = FakeSearchHub(), FakeSearchHub()
    failing_hub.rerank_error = RuntimeError("실패")

    for hub in (ok_hub, failing_hub):
        searcher = make_searcher(store, hub, settings)
        run(searcher.search(SearchQuery("q", top_n=5, expand_neighbors=True)))
        run(searcher.search(SearchQuery("q", top_n=5)))
        run(searcher.document_chunks("doc-1"))

    assert store.writes() == []


@pytest.mark.parametrize(
    ("method", "error", "neighbors"),
    [
        ("search_dense", StoreUnavailableError(), False),
        ("search_sparse", VectorDimensionMismatchError(), False),
        ("active_records", StoreUnavailableError(), True),
    ],
)
@pytest.mark.req("REQ-RAG-4.1.1")
def test_store_errors_propagate(
    settings: Settings, method: str, error: Exception, neighbors: bool
) -> None:
    """[REQ-RAG-4.1.1] resource의 저장소 오류 둘은 그대로 난다."""
    store = scripted_store([rec("c1", order=1), rec("c2", order=2)])
    store.fail[method] = error
    searcher = make_searcher(store, FakeSearchHub(), settings)

    with pytest.raises(type(error)):
        run(searcher.search(SearchQuery("q", top_n=5, expand_neighbors=neighbors)))
