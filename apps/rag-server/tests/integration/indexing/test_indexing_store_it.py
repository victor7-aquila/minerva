"""Indexer 통합 테스트 (실제 Qdrant). Qdrant가 없으면 skip한다."""

import pytest

from minerva_rag.core import Settings
from minerva_rag.indexing import Indexer
from minerva_rag.resource import ChunkStore

from ...unit.indexing.fakes import (
    DIM,
    FakeModelHub,
    as_hub,
    chunking_result,
    ids_of,
    make_input,
    plain_chunks,
    run,
)
from ..resource.conftest import assert_isolated


@pytest.mark.req("REQ-RAG-3.3.3")
def test_it_version_swap_only_new_active(it_settings: Settings, isolated_collection: str) -> None:
    """[REQ-RAG-3.3.3] 실제 Qdrant에서 버전 교체 뒤 active 레코드는 새 버전뿐이다."""

    async def scenario() -> None:
        store = ChunkStore(it_settings)
        await store.connect(DIM)
        await assert_isolated(it_settings, isolated_collection)
        indexer = Indexer(as_hub(FakeModelHub()), store, it_settings)
        try:
            first = await indexer.embed(
                make_input(doc_id="doc-1", version="v1", job_id="job-1"),
                chunking_result(plain_chunks("v1", 3)),
            )
            assert await indexer.write(first) == 3
            second = await indexer.embed(
                make_input(doc_id="doc-1", version="v2", job_id="job-2"),
                chunking_result(plain_chunks("v2", 2)),
            )

            assert await indexer.write(second) == 2

            active = await store.active_records("doc-1")
            assert {r.chunk_id for r in active} == ids_of(second)
            assert all(r.version == "v2" for r in active)
            assert await store.job_records("doc-1", "job-1") == []
        finally:
            await store.close()

    run(scenario())
