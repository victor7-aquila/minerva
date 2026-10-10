"""ChunkStore(REQ-RAG-12.2, REQ-RAG-12.2.2, REQ-RAG-3.3.1) 인메모리 Qdrant 단위 테스트."""

import dataclasses
from typing import cast

import pytest
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, Modifier, SparseVectorParams, VectorParams
from structlog.testing import capture_logs

from minerva_rag.core import (
    ChunkKind,
    Settings,
    SparseVector,
    VectorDimensionMismatchError,
)
from minerva_rag.resource import ChunkFilter, ChunkStore, ScoredRecord

from .fakes import (
    COLLECTION,
    SPARSE_QUERY,
    STORE_CALLS,
    TEXT_BODY,
    TEXT_SUMMARY,
    TEXT_TITLE,
    assert_log,
    assert_logs_exclude,
    by_id,
    filter_data,
    ids,
    install_qdrant,
    make_edition,
    make_record,
    open_store,
    run,
    seed,
    sparse_for,
    vec,
)

# ── 4.1 연결·컬렉션 ───────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-12.2.2")
def test_connect_creates_collection(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2.2] 컬렉션이 없으면 dense 차원·코사인, sparse IDF 보정으로 만든다."""

    async def scenario() -> None:
        _, client = await open_store(monkeypatch, dimension=8)
        info = await client.get_collection(COLLECTION)
        vectors = info.config.params.vectors
        sparse = info.config.params.sparse_vectors
        assert isinstance(vectors, dict)
        assert vectors["dense"].size == 8
        assert vectors["dense"].distance == Distance.COSINE
        assert sparse is not None
        assert sparse["sparse"].modifier == Modifier.IDF

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2.2")
def test_connect_keeps_existing_data(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-12.2.2] 같은 차원으로 다시 connect해도 기존 데이터를 지우지 않는다."""

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, [make_record("c-1")])
        second = ChunkStore(settings)
        await second.connect(8)
        assert ids(await second.active_records("doc-1")) == {"c-1"}

    run(scenario())


async def _make_mismatched(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> tuple[ChunkStore, AsyncQdrantClient]:
    """dense 16차원 컬렉션을 만든 뒤 8차원으로 connect한 ChunkStore와 원시 클라이언트를 돌려준다."""
    client = AsyncQdrantClient(location=":memory:")
    await client.create_collection(
        COLLECTION,
        vectors_config={"dense": VectorParams(size=16, distance=Distance.COSINE)},
        sparse_vectors_config={"sparse": SparseVectorParams(modifier=Modifier.IDF)},
    )
    install_qdrant(monkeypatch, client)
    store = ChunkStore(settings)
    await store.connect(8)
    return store, client


@pytest.mark.req("REQ-RAG-12.2.2")
def test_dimension_mismatch_blocks_all_reads_and_writes(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """[REQ-RAG-12.2.2] 차원이 다르면 모든 쓰기·조회가 거부되고 ping·close는 정상이다."""

    async def scenario() -> None:
        store, client = await _make_mismatched(monkeypatch, settings)
        for call in STORE_CALLS.values():
            with pytest.raises(VectorDimensionMismatchError):
                await call(store)
        assert await store.ping() is True
        # 기존 컬렉션을 지우거나 다시 만들지 않는다 (MODULE.md 「영속화·복원」)
        info = await client.get_collection(COLLECTION)
        vectors = cast(dict[str, VectorParams], info.config.params.vectors)
        assert vectors["dense"].size == 16
        await store.close()

    with capture_logs() as logs:
        run(scenario())

    assert_log(
        logs, "resource.dimension_mismatch", "error", {"stored_dimension", "model_dimension"}
    )
    entry = next(e for e in logs if e["event"] == "resource.dimension_mismatch")
    assert entry["stored_dimension"] == 16
    assert entry["model_dimension"] == 8


@pytest.mark.req("REQ-RAG-12.2.2")
def test_same_dimension_works(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-12.2.2] 차원이 같은 기존 컬렉션에 connect하면 저장·조회가 정상이다."""

    async def scenario() -> None:
        client = AsyncQdrantClient(location=":memory:")
        await client.create_collection(
            COLLECTION,
            vectors_config={"dense": VectorParams(size=8, distance=Distance.COSINE)},
            sparse_vectors_config={"sparse": SparseVectorParams(modifier=Modifier.IDF)},
        )
        install_qdrant(monkeypatch, client)
        store = ChunkStore(settings)
        await store.connect(8)
        await seed(store, [make_record("c-1")])
        assert ids(await store.active_records("doc-1")) == {"c-1"}
        assert len(await store.search_dense(vec(0), ChunkFilter(), 5)) == 1

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_calls_before_connect(settings: Settings) -> None:
    """[REQ-RAG-12.2] connect 전 쓰기·조회는 RuntimeError, ping은 False, close는 반복해도 된다."""

    async def scenario() -> None:
        store = ChunkStore(settings)
        for call in STORE_CALLS.values():
            with pytest.raises(RuntimeError):
                await call(store)
        assert await store.ping() is False
        await store.close()
        await store.close()

    run(scenario())


# ── 4.2 왕복 보존·active 조회 ─────────────────────────────────────


@pytest.mark.req("REQ-RAG-3.3.1")
def test_record_round_trip_preserves_all_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] 저장한 레코드의 모든 필드가 active 조회에서 그대로 돌아온다."""
    records = [
        make_record("c-ed", doc_id="doc-1", edition=make_edition("2025"), is_latest_edition=True),
        make_record("c-plain", doc_id="doc-1", order=1),
        make_record("c-asset", doc_id="doc-1", kind=ChunkKind.ASSET, order=2),
        make_record(
            "c-split",
            doc_id="doc-1",
            order=3,
            split=("g1", 2, 3),
            heading_path=("설치", "Docker", "환경변수"),
        ),
        make_record(
            "c-ko", doc_id="doc-1", order=4, text='특수문자 "따옴표" \\ \n 줄바꿈 & <태그> 😀'
        ),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        loaded = by_id(await store.active_records("doc-1"))
        assert set(loaded) == set(by_id(records))
        for record in records:
            assert loaded[record.chunk_id] == record
        edition = loaded["c-ed"].edition
        assert edition is not None
        assert type(edition.edition_date).__name__ == "date"

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_any_chunk_id_format_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] chunk_id는 형식 제한 없이 그대로 보존하고, 같은 chunk_id는 같은 포인트다."""
    chunk_ids = ["c-91", "doc-1/v1/0", "청크-가"]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, [make_record(c) for c in chunk_ids])
        assert ids(await store.active_records("doc-1")) == set(chunk_ids)
        newer = make_record("c-91", text="덮어쓴 본문")
        await seed(store, [newer])
        loaded = await store.active_records("doc-1")
        assert len(loaded) == 3
        assert by_id(loaded)["c-91"] == newer

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_upsert_keeps_active_as_given(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] active=False 레코드는 active 조회에 나오지 않고 job_records에만 나온다."""

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        inactive = make_record("c-off", active=False, name="비활성 문서", doc_id="doc-off")
        await seed(store, [inactive])
        assert await store.active_records("doc-off") == []
        assert await store.search_dense(vec(0), ChunkFilter(), 10) == []
        assert await store.search_sparse(SPARSE_QUERY, ChunkFilter(), 10) == []
        assert await store.active_editions("비활성 문서") == {}
        assert await store.job_records("doc-off", "job-1") == [inactive]

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_job_records_ignores_active(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] job_records는 같은 문서·job_id의 레코드를 active 여부와 관계없이 돌려준다."""
    records = [
        make_record("a-on", active=True, job_id="job-1"),
        make_record("a-off", active=False, job_id="job-1"),
        make_record("a-other-job", active=True, job_id="job-2"),
        make_record("b-on", doc_id="doc-2", active=True, job_id="job-1"),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        assert ids(await store.job_records("doc-1", "job-1")) == {"a-on", "a-off"}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_search_returns_only_active(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] 검색은 active 레코드만 돌려준다."""
    records = [
        make_record("on-1"),
        make_record("off-1", active=False),
        make_record("on-2"),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        dense = await store.search_dense(vec(1), ChunkFilter(), 10)
        sparse = await store.search_sparse(SPARSE_QUERY, ChunkFilter(), 10)
        assert {s.record.chunk_id for s in dense} == {"on-1", "on-2"}
        assert {s.record.chunk_id for s in sparse} == {"on-1", "on-2"}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_search_sorted_and_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] 검색은 점수 내림차순으로 최대 limit개의 ScoredRecord를 돌려준다."""
    records = [make_record(f"c-{i}", order=i) for i in range(4)]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        for results in (
            await store.search_dense(vec(0), ChunkFilter(), 2),
            await store.search_sparse(SPARSE_QUERY, ChunkFilter(), 2),
        ):
            assert 0 < len(results) <= 2
            assert all(isinstance(r, ScoredRecord) for r in results)
            assert all(isinstance(r.score, float) for r in results)
            scores = [r.score for r in results]
            assert scores == sorted(scores, reverse=True)
            assert all(r.record == by_id(records)[r.record.chunk_id] for r in results)
        # 키워드 점수는 값이 큰 레코드가 앞선다 (sparse_for의 값 = i+1)
        top = (await store.search_sparse(SPARSE_QUERY, ChunkFilter(), 4))[0]
        assert top.record.chunk_id == "c-3"
        # 코사인 점수는 클수록 가깝다: 질의와 같은 방향의 벡터가 최상위다 (vec(i)는 서로 직교)
        nearest = (await store.search_dense(vec(2), ChunkFilter(), 4))[0]
        assert nearest.record.chunk_id == "c-2"

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
@pytest.mark.parametrize("limit", [0, -1])
def test_search_rejects_bad_limit(monkeypatch: pytest.MonkeyPatch, limit: int) -> None:
    """[REQ-RAG-12.2] limit이 1보다 작으면 ValueError다."""

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        with pytest.raises(ValueError):
            await store.search_dense(vec(0), ChunkFilter(), limit)
        with pytest.raises(ValueError):
            await store.search_sparse(SPARSE_QUERY, ChunkFilter(), limit)

    run(scenario())


# ── 4.3 ChunkFilter 범위 ──────────────────────────────────────────


async def _filtered_ids(store: ChunkStore, flt: ChunkFilter) -> tuple[set[str], set[str]]:
    """dense·sparse 검색 결과의 doc_id 집합을 돌려준다."""
    dense = await store.search_dense(vec(0), flt, 10)
    sparse = await store.search_sparse(SPARSE_QUERY, flt, 10)
    return {r.record.doc_id for r in dense}, {r.record.doc_id for r in sparse}


async def _filter_store(monkeypatch: pytest.MonkeyPatch) -> ChunkStore:
    store, _ = await open_store(monkeypatch)
    await seed(store, filter_data())
    return store


@pytest.mark.req("REQ-RAG-3.3.1")
def test_filter_doc_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] doc_ids를 주면 그 문서 안에서만 조회한다."""

    async def scenario() -> None:
        store = await _filter_store(monkeypatch)
        dense, sparse = await _filtered_ids(store, ChunkFilter(doc_ids=("d-2022", "d-plain")))
        assert dense == {"d-2022", "d-plain"}
        assert sparse == {"d-2022", "d-plain"}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_filter_empty_doc_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] doc_ids가 빈 튜플이면 조회 결과가 없다."""

    async def scenario() -> None:
        store = await _filter_store(monkeypatch)
        assert await _filtered_ids(store, ChunkFilter(doc_ids=())) == (set(), set())

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_filter_specific_edition(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] 이름·라벨이 모두 맞는 판의 레코드만 조회한다."""

    async def scenario() -> None:
        store = await _filter_store(monkeypatch)
        flt = ChunkFilter(edition_name="표준", edition_label="2022")
        dense, sparse = await _filtered_ids(store, flt)
        assert dense == {"d-2022"}
        assert sparse == {"d-2022"}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_filter_latest_or_unversioned(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] 최신 판이거나 판이 없는 레코드만 조회한다."""

    async def scenario() -> None:
        store = await _filter_store(monkeypatch)
        dense, sparse = await _filtered_ids(store, ChunkFilter(latest_or_unversioned=True))
        assert dense == sparse == {"d-2025", "d-plain", "d-other"}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.1")
def test_filter_combined(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-3.3.1] doc_ids와 latest_or_unversioned를 함께 주면 둘 다 만족하는 것만 조회한다."""

    async def scenario() -> None:
        store = await _filter_store(monkeypatch)
        flt = ChunkFilter(doc_ids=("d-2022", "d-2025", "d-other"), latest_or_unversioned=True)
        dense, sparse = await _filtered_ids(store, flt)
        assert dense == sparse == {"d-2025", "d-other"}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_filter_requires_name_and_label_together() -> None:
    """[REQ-RAG-12.2] edition_name과 edition_label은 함께 있어야 하며 하나만 주면 ValueError다."""
    with pytest.raises(ValueError):
        ChunkFilter(edition_name="표준")
    with pytest.raises(ValueError):
        ChunkFilter(edition_label="2022")


# ── 4.4 쓰기 메서드 ───────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-12.2")
def test_activate_records_only_given_ids_in_doc(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] activate_records는 그 문서에서 chunk_ids에 든 레코드만 active로 바꾼다."""
    records = [
        make_record("a1", active=False),
        make_record("a2", active=False),
        make_record("b1", doc_id="doc-2", active=False),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        await store.activate_records("doc-1", set())
        assert await store.active_records("doc-1") == []
        await store.activate_records("doc-1", {"a1", "b1"})
        assert ids(await store.active_records("doc-1")) == {"a1"}
        assert await store.active_records("doc-2") == []
        assert [r.active for r in await store.job_records("doc-2", "job-1")] == [False]

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_delete_records_except_keeps_given(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] delete_records_except는 chunk_ids 밖을 지우고 빈 집합이면 전부 지운다."""
    records = [
        make_record("a1"),
        make_record("a2", active=False),
        make_record("a3"),
        make_record("b1", doc_id="doc-2"),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        await store.delete_records_except("doc-1", {"a1"})
        assert ids(await store.job_records("doc-1", "job-1")) == {"a1"}
        assert ids(await store.active_records("doc-2")) == {"b1"}
        await store.delete_records_except("doc-1", set())
        assert await store.job_records("doc-1", "job-1") == []
        assert ids(await store.active_records("doc-2")) == {"b1"}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_version_swap_sequence(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] 버전 전환은 레코드 ID 기준이라 같은 버전을 다시 색인해도 섞이지 않는다."""
    old = [make_record(f"o{i}", version="v1", job_id="job-1") for i in range(2)]
    new = [make_record(f"n{i}", version="v2", job_id="job-2", active=False) for i in range(2)]
    redo = [make_record("m0", version="v2", job_id="job-3", active=False)]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, old)
        await seed(store, new, start=2)
        assert ids(await store.active_records("doc-1")) == {"o0", "o1"}
        await store.activate_records("doc-1", {"n0", "n1"})
        await store.delete_records_except("doc-1", {"n0", "n1"})
        assert ids(await store.active_records("doc-1")) == {"n0", "n1"}
        # 같은 버전 문자열을 다시 색인한다 (새 chunk_id)
        await seed(store, redo, start=4)
        await store.activate_records("doc-1", {"m0"})
        await store.delete_records_except("doc-1", {"m0"})
        assert ids(await store.active_records("doc-1")) == {"m0"}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_delete_records_by_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] delete_records는 지정한 레코드만 지우고 빈 입력은 아무것도 바꾸지 않는다."""

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, [make_record("a1"), make_record("a2"), make_record("a3")])
        await store.delete_records(set())
        assert ids(await store.active_records("doc-1")) == {"a1", "a2", "a3"}
        await store.delete_records({"a1", "a3"})
        assert ids(await store.active_records("doc-1")) == {"a2"}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_delete_document_all_versions(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] delete_document는 모든 버전을 지우고 없는 문서는 오류 없이 끝난다."""
    records = [
        make_record("a-on", version="v1"),
        make_record("a-off", version="v2", job_id="job-2", active=False),
        make_record("b1", doc_id="doc-2"),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        await store.delete_document("doc-1")
        assert await store.job_records("doc-1", "job-1") == []
        assert await store.job_records("doc-1", "job-2") == []
        assert ids(await store.active_records("doc-2")) == {"b1"}
        await store.delete_document("no-such-doc")

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_set_document_metadata_all_versions(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] set_document_metadata는 모든 버전의 name·edition만 바꾼다."""
    on = make_record("a-on", is_latest_edition=True)
    off = make_record("a-off", version="v2", job_id="job-2", active=False)
    new_edition = make_edition("2026")

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, [on, off])
        await store.set_document_metadata("doc-1", "새 이름", new_edition)
        after_on = (await store.job_records("doc-1", "job-1"))[0]
        after_off = (await store.job_records("doc-1", "job-2"))[0]
        assert after_on == dataclasses.replace(on, name="새 이름", edition=new_edition)
        assert after_off == dataclasses.replace(off, name="새 이름", edition=new_edition)
        await store.set_document_metadata("doc-1", "판 없는 이름", None)
        assert (await store.job_records("doc-1", "job-1"))[0].edition is None
        await store.set_document_metadata("no-such-doc", "x", None)

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_set_latest_editions_marks_active_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] set_latest_editions는 같은 이름의 active 레코드만 바꾼다."""
    records = [
        make_record("c-a", doc_id="d-a", name="표준"),
        make_record("c-b", doc_id="d-b", name="표준", is_latest_edition=True),
        make_record("c-off", doc_id="d-c", name="표준", active=False, is_latest_edition=True),
        make_record("c-other", doc_id="d-o", name="기타", is_latest_edition=True),
    ]

    async def latest(store: ChunkStore) -> dict[str, bool]:
        out: dict[str, bool] = {}
        for doc_id in ("d-a", "d-b", "d-c", "d-o"):
            (record,) = await store.job_records(doc_id, "job-1")
            out[doc_id] = record.is_latest_edition
        return out

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        await store.set_latest_editions("표준", frozenset({"d-a"}))
        assert await latest(store) == {"d-a": True, "d-b": False, "d-c": True, "d-o": True}
        await store.set_latest_editions("표준", frozenset())
        assert await latest(store) == {"d-a": False, "d-b": False, "d-c": True, "d-o": True}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_active_editions_per_document(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] active_editions는 active 레코드가 있는 문서마다 판 정보를 돌려준다."""
    edition = make_edition("2025")
    records = [
        make_record("c-1", doc_id="d-a", name="표준", edition=edition),
        make_record("c-2", doc_id="d-a", name="표준", edition=edition, order=1),
        make_record("c-3", doc_id="d-n", name="표준"),
        make_record("c-4", doc_id="d-off", name="표준", active=False, edition=edition),
        make_record("c-5", doc_id="d-o", name="기타", edition=edition),
    ]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        assert await store.active_editions("표준") == {"d-a": edition, "d-n": None}

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_large_document_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] 한 문서의 레코드 300개를 저장하면 active_records가 300개를 모두 돌려준다."""
    records = [make_record(f"c-{i:03d}", order=i) for i in range(300)]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, records)
        assert ids(await store.active_records("doc-1")) == ids(records)
        assert len(await store.active_records("doc-1")) == 300

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_upsert_validates_inputs(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] upsert는 길이·차원 불일치에 ValueError, 빈 입력은 무변화다."""
    two = [make_record("c-1"), make_record("c-2")]

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        with pytest.raises(ValueError):
            await store.upsert(two, [vec(0)], [sparse_for(0), sparse_for(1)])
        with pytest.raises(ValueError):
            await store.upsert(two, [vec(0), vec(1)], [sparse_for(0)])
        with pytest.raises(ValueError):
            await store.upsert(two[:1], [vec(0, dim=7)], [sparse_for(0)])
        await store.upsert([], [], [])
        assert await store.active_records("doc-1") == []

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2")
def test_upsert_log_has_no_content(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] resource.upsert(info)는 허용 필드만 갖고 청크 본문·제목·요약을 담지 않는다."""

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await seed(store, [make_record("c-1")])

    with capture_logs() as logs:
        run(scenario())

    assert_log(logs, "resource.upsert", "info", {"doc_id", "version", "chunks"})
    assert_logs_exclude(logs, [TEXT_BODY, TEXT_TITLE, TEXT_SUMMARY])


@pytest.mark.req("REQ-RAG-12.2")
def test_sparse_vector_type_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.2] 인덱스가 하나뿐인 키워드 벡터도 저장하고 같은 인덱스로 검색된다."""

    async def scenario() -> None:
        store, _ = await open_store(monkeypatch)
        await store.upsert([make_record("c-1")], [vec(0)], [SparseVector((7,), (2.0,))])
        found = await store.search_sparse(SparseVector((7,), (1.0,)), ChunkFilter(), 5)
        assert [r.record.chunk_id for r in found] == ["c-1"]

    run(scenario())
