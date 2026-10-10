"""ChunkStore 통합 테스트 (실제 Qdrant). Qdrant가 없으면 skip한다."""

import pytest

from minerva_rag.core import Settings, VectorDimensionMismatchError
from minerva_rag.resource import ChunkFilter, ChunkStore, ModelHub

from ...unit.resource.fakes import (
    SPARSE_QUERY,
    by_id,
    filter_data,
    ids,
    make_edition,
    make_record,
    run,
    seed,
    sparse_for,
    vec,
)
from .conftest import assert_isolated


@pytest.mark.req("REQ-RAG-12.2.2")
def test_it_dimension_mismatch_rejected(it_settings: Settings, isolated_collection: str) -> None:
    """[REQ-RAG-12.2.2] 다른 차원의 기존 컬렉션은 쓰기·조회를 거부하고, 같은 차원이면 정상이다."""

    async def scenario() -> None:
        first = ChunkStore(it_settings)
        await first.connect(8)
        await assert_isolated(it_settings, isolated_collection)
        await first.close()

        mismatched = ChunkStore(it_settings)
        await mismatched.connect(16)
        record = make_record("c-1")
        with pytest.raises(VectorDimensionMismatchError):
            await mismatched.upsert([record], [vec(0, 16)], [sparse_for(0)])
        with pytest.raises(VectorDimensionMismatchError):
            await mismatched.search_dense(vec(0, 16), ChunkFilter(), 5)
        with pytest.raises(VectorDimensionMismatchError):
            await mismatched.active_records("doc-1")
        assert await mismatched.ping() is True
        # 불일치여도 기존 컬렉션을 지우거나 다시 만들지 않는다: 같은 차원 재연결이 정상이다(아래)
        await mismatched.close()

        same = ChunkStore(it_settings)
        await same.connect(8)
        await seed(same, [record])
        assert ids(await same.active_records("doc-1")) == {"c-1"}
        assert len(await same.search_dense(vec(0), ChunkFilter(), 5)) == 1
        await same.close()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_it_round_trip_and_active_only(it_settings: Settings, isolated_collection: str) -> None:
    """[REQ-RAG-3.3.1] 실제 서버에서 레코드가 왕복하고 active만 조회된다 (job_records 제외)."""
    records = [
        make_record("c-ed", edition=make_edition("2025"), is_latest_edition=True),
        make_record(
            "c-plain", order=1, split=("g1", 2, 3), heading_path=("설치", "Docker", "환경")
        ),
        make_record("c-off", order=2, active=False),
    ]

    async def scenario() -> None:
        store = ChunkStore(it_settings)
        await store.connect(8)
        await assert_isolated(it_settings, isolated_collection)
        await seed(store, records)
        loaded = by_id(await store.active_records("doc-1"))
        assert set(loaded) == {"c-ed", "c-plain"}
        assert loaded["c-ed"] == records[0]
        assert loaded["c-plain"] == records[1]
        dense = await store.search_dense(vec(0), ChunkFilter(), 10)
        assert "c-off" not in {r.record.chunk_id for r in dense}
        assert ids(await store.job_records("doc-1", "job-1")) == {"c-ed", "c-plain", "c-off"}
        await store.close()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_it_chunk_filter_scopes(it_settings: Settings, isolated_collection: str) -> None:
    """[REQ-RAG-3.3.1] ChunkFilter 범위가 실제 서버에서도 같은 결과를 낸다."""

    async def found(store: ChunkStore, flt: ChunkFilter) -> tuple[set[str], set[str]]:
        dense = await store.search_dense(vec(0), flt, 10)
        sparse = await store.search_sparse(SPARSE_QUERY, flt, 10)
        return {r.record.doc_id for r in dense}, {r.record.doc_id for r in sparse}

    async def scenario() -> None:
        store = ChunkStore(it_settings)
        await store.connect(8)
        await assert_isolated(it_settings, isolated_collection)
        await seed(store, filter_data())
        for flt, expected in [
            (ChunkFilter(doc_ids=("d-2022", "d-plain")), {"d-2022", "d-plain"}),
            (ChunkFilter(doc_ids=()), set()),
            (ChunkFilter(edition_name="표준", edition_label="2022"), {"d-2022"}),
            (ChunkFilter(latest_or_unversioned=True), {"d-2025", "d-plain", "d-other"}),
            (
                ChunkFilter(doc_ids=("d-2022", "d-2025", "d-other"), latest_or_unversioned=True),
                {"d-2025", "d-other"},
            ),
        ]:
            # dense·sparse 두 검색 경로가 같은 범위를 낸다
            assert await found(store, flt) == (expected, expected)
        await store.close()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_it_sparse_idf_search(it_settings: Settings, isolated_collection: str) -> None:
    """[REQ-RAG-3.3.1] 키워드 벡터로 저장·검색하면 질의 토큰을 가진 레코드만 나온다."""
    records = [
        make_record("c-cert", text="인증서 갱신 절차"),
        make_record("c-docker", text="도커 설치 방법", order=1),
    ]

    async def scenario() -> None:
        hub = ModelHub(it_settings)
        sparse = await hub.encode_sparse_documents([r.chunk.text for r in records])
        query = await hub.encode_sparse_query("인증서")
        store = ChunkStore(it_settings)
        await store.connect(8)
        await assert_isolated(it_settings, isolated_collection)
        await store.upsert(records, [vec(0), vec(1)], sparse)
        results = await store.search_sparse(query, ChunkFilter(), 10)
        assert {r.record.chunk_id for r in results} == {"c-cert"}
        await store.close()

    run(scenario())
