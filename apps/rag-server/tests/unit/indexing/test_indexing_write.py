"""버전 교체(write) 테스트 (REQ-RAG-3.3, 3.6.2, 3.6.6, 10.3.4)."""

import pytest

from minerva_rag.core import (
    ChunkRecord,
    Settings,
    StoreUnavailableError,
    VectorDimensionMismatchError,
)
from minerva_rag.indexing import EmbeddedChunks, Indexer

from .fakes import (
    BACKENDS,
    FakeChunkStore,
    active_ids,
    as_store,
    chunking_result,
    edition,
    ids_of,
    index_version,
    job_ids,
    latest_of,
    make_indexer,
    make_input,
    make_record,
    make_store,
    plain_chunks,
    run,
    seed,
)

NAME = "인증 가이드"


async def _setup_v1(indexer: Indexer) -> set[str]:
    """doc-1의 v1(job-1) 레코드 3개를 써 두고 chunk_id 집합을 돌려준다."""
    embedded, _ = await index_version(
        indexer,
        doc_id="doc-1",
        version="v1",
        job_id="job-1",
        name=NAME,
        edition=None,
        chunks=plain_chunks("v1", 3),
    )
    return ids_of(embedded)


async def _embed_v2(indexer: Indexer) -> EmbeddedChunks:
    """doc-1의 v2(job-2) 레코드 2개를 만든다(저장하지 않는다)."""
    inp = make_input(doc_id="doc-1", version="v2", job_id="job-2", name=NAME)
    return await indexer.embed(inp, chunking_result(plain_chunks("v2", 2)))


@pytest.mark.req("REQ-RAG-3.3.1")
def test_write_stores_inactive_then_activates(settings: Settings) -> None:
    """[REQ-RAG-3.3.1] 저장(inactive) 뒤 활성화하고 그다음 이전 레코드를 지운다."""
    snapshots: list[dict[str, ChunkRecord]] = []

    async def scenario() -> tuple[set[str], FakeChunkStore]:
        store = FakeChunkStore()
        indexer, _ = make_indexer(as_store(store), settings)
        await _setup_v1(indexer)
        embedded = await _embed_v2(indexer)
        store.calls.clear()
        store.before["activate_records"] = lambda s: snapshots.append(s.snapshot())
        await indexer.write(embedded)
        return ids_of(embedded), store

    new_ids, store = run(scenario())

    upserts = [args for name, args in store.calls if name == "upsert"]
    assert upserts
    for (records,) in upserts:
        assert isinstance(records, tuple)
        assert all(isinstance(r, ChunkRecord) and r.active is False for r in records)
    # 활성화 직전: 새 레코드가 모두 저장돼 있고 아직 active가 아니다(호출 횟수·묶음은 정하지 않는다)
    assert snapshots
    assert new_ids <= set(snapshots[0])
    assert all(snapshots[0][cid].active is False for cid in new_ids)
    # 활성화된 ID를 모두 모으면 새 레코드 전체다
    activated: set[str] = set()
    for name, args in store.writes():
        if name == "activate_records":
            assert args[0] == "doc-1"
            assert isinstance(args[1], frozenset)
            activated |= set(args[1])
    assert activated == new_ids
    # 쓰기 호출 차례: upsert가 모두 끝난 뒤 활성화, 활성화 뒤 이전 삭제, 그 뒤 마지막 재계산
    names = [name for name, _args in store.writes()]
    first_activate = names.index("activate_records")
    last_upsert = len(names) - 1 - names[::-1].index("upsert")
    assert last_upsert < first_activate
    assert first_activate < names.index("delete_records_except")
    last_latest = len(names) - 1 - names[::-1].index("set_latest_editions")
    assert names.index("delete_records_except") < last_latest


async def _failure_setup(
    settings: Settings,
) -> tuple[FakeChunkStore, Indexer, EmbeddedChunks, set[str], dict[str, ChunkRecord]]:
    """v1을 써 두고 v2를 embed한 상태를 만든다."""
    store = FakeChunkStore()
    indexer, _ = make_indexer(as_store(store), settings)
    v1_ids = await _setup_v1(indexer)
    embedded = await _embed_v2(indexer)
    return store, indexer, embedded, v1_ids, store.snapshot()


@pytest.mark.req("REQ-RAG-3.3.2")
@pytest.mark.req("REQ-RAG-10.3.4")
def test_write_failure_keeps_previous_active(settings: Settings) -> None:
    """[REQ-RAG-3.3.2] upsert 실패 시 이전 레코드가 그대로이고 새 레코드를 정리한다."""

    async def scenario() -> None:
        store, indexer, embedded, v1_ids, before = await _failure_setup(settings)
        error = StoreUnavailableError()
        store.fail["upsert"] = error
        store.partial_upsert = 1
        store.calls.clear()

        with pytest.raises(StoreUnavailableError) as raised:
            await indexer.write(embedded)

        assert raised.value is error
        checked = as_store(store)
        assert await active_ids(checked, "doc-1") == v1_ids
        assert {cid: r for cid, r in store.snapshot().items() if cid in v1_ids} == {
            cid: r for cid, r in before.items() if cid in v1_ids
        }
        assert await job_ids(checked, "doc-1", "job-2") == set()
        written = {name for name, _args in store.writes()}
        assert written.isdisjoint({"delete_document", "delete_records_except"})

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.2")
@pytest.mark.req("REQ-RAG-10.3.4")
def test_write_cleanup_failure_raises_original(settings: Settings) -> None:
    """[REQ-RAG-3.3.2] 정리마저 실패해도 upsert의 원래 예외를 내고 이전 레코드는 active로 남는다."""

    async def scenario() -> None:
        store, indexer, embedded, v1_ids, _before = await _failure_setup(settings)
        error = StoreUnavailableError()
        store.fail["upsert"] = error
        store.partial_upsert = 1
        store.down_after_failure = True

        with pytest.raises(StoreUnavailableError) as raised:
            await indexer.write(embedded)

        assert raised.value is error
        assert await active_ids(as_store(store), "doc-1") == v1_ids

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.2")
def test_activate_failure_keeps_previous_active(settings: Settings) -> None:
    """[REQ-RAG-3.3.2] 활성화가 실패해도 이전 레코드가 active로 남고 새 레코드를 정리한다."""

    async def scenario() -> None:
        store, indexer, embedded, v1_ids, _before = await _failure_setup(settings)
        error = StoreUnavailableError()
        store.fail["activate_records"] = error

        with pytest.raises(StoreUnavailableError) as raised:
            await indexer.write(embedded)

        assert raised.value is error
        checked = as_store(store)
        assert await active_ids(checked, "doc-1") == v1_ids
        assert await job_ids(checked, "doc-1", "job-2") == set()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_leaves_only_new_records(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.3.3] write가 끝나면 그 문서에 새 레코드만 남고 반환값이 새 레코드 수다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await _setup_v1(indexer)
        embedded = await _embed_v2(indexer)

        assert await indexer.write(embedded) == 2

        assert await active_ids(store, "doc-1") == ids_of(embedded)
        assert await job_ids(store, "doc-1", "job-1") == set()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_removes_leftover_inactive(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.3.3] 이전 정리 실패로 남은 active가 아닌 레코드도 버전 교체가 지운다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await _setup_v1(indexer)
        leftover = make_record(
            "left-1",
            doc_id="doc-1",
            version="v0",
            job_id="job-0",
            active=False,
            name=NAME,
            edition=None,
        )
        await seed(store, [leftover])
        embedded = await _embed_v2(indexer)

        await indexer.write(embedded)

        assert await job_ids(store, "doc-1", "job-0") == set()
        assert await active_ids(store, "doc-1") == ids_of(embedded)

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_empty_version_clears_document(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.3.3] 빈 records로 write하면 그 문서에 레코드가 남지 않고 0을 돌려준다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await _setup_v1(indexer)
        inp = make_input(doc_id="doc-1", version="v2", job_id="job-2", name=NAME)
        embedded = await indexer.embed(inp, chunking_result([]))

        assert await indexer.write(embedded) == 0

        assert await active_ids(store, "doc-1") == set()
        assert await job_ids(store, "doc-1", "job-1") == set()
        assert await job_ids(store, "doc-1", "job-2") == set()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.3")
@pytest.mark.req("REQ-RAG-10.3.4")
def test_delete_except_failure_after_activation(settings: Settings) -> None:
    """[REQ-RAG-3.3.3] 활성화 뒤 이전 삭제 실패는 예외를 그대로 내고 둘 다 active로 남는다."""

    async def scenario() -> None:
        store, indexer, embedded, v1_ids, _before = await _failure_setup(settings)
        error = StoreUnavailableError()
        store.fail["delete_records_except"] = error

        with pytest.raises(StoreUnavailableError) as raised:
            await indexer.write(embedded)

        assert raised.value is error
        checked = as_store(store)
        new_ids = ids_of(embedded)
        assert await active_ids(checked, "doc-1") == v1_ids | new_ids
        assert await job_ids(checked, "doc-1", "job-1") == v1_ids
        assert await job_ids(checked, "doc-1", "job-2") == new_ids

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.req("REQ-RAG-10.3.4")
@pytest.mark.parametrize("method", ["active_editions", "set_latest_editions"])
def test_latest_failure_after_activation(method: str, settings: Settings) -> None:
    """[REQ-RAG-3.6.3] 활성화 뒤 재계산 실패는 예외를 그대로 내고 새 레코드를 되돌리지 않는다."""

    async def scenario() -> None:
        store, indexer, embedded, _v1_ids, _before = await _failure_setup(settings)
        error = StoreUnavailableError()
        store.fail[method] = error

        with pytest.raises(StoreUnavailableError) as raised:
            await indexer.write(embedded)

        assert raised.value is error
        checked = as_store(store)
        new_ids = ids_of(embedded)
        assert await job_ids(checked, "doc-1", "job-2") == new_ids
        assert new_ids <= await active_ids(checked, "doc-1")

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.2")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_keeps_other_edition_document(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.2] 이름이 같고 판이 다른 문서의 레코드는 색인해도 그대로다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        other, _ = await index_version(
            indexer,
            doc_id="doc-2",
            version="v1",
            job_id="job-x",
            name=NAME,
            edition=edition(2022),
            chunks=plain_chunks("other", 2),
        )
        await index_version(
            indexer,
            doc_id="doc-1",
            version="v1",
            job_id="job-1",
            name=NAME,
            edition=edition(2025),
            chunks=plain_chunks("v1", 3),
        )
        before = (await active_ids(store, "doc-2"), await job_ids(store, "doc-2", "job-x"))

        await index_version(
            indexer,
            doc_id="doc-1",
            version="v2",
            job_id="job-2",
            name=NAME,
            edition=edition(2025),
            chunks=plain_chunks("v2", 2),
        )

        assert before[0] == ids_of(other)
        assert (await active_ids(store, "doc-2"), await job_ids(store, "doc-2", "job-x")) == before

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.6")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_keeps_same_name_edition_document(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.6] 이름·판이 같은 다른 문서의 레코드는 색인해도 그대로이고 둘 다 최신판이다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        other, _ = await index_version(
            indexer,
            doc_id="doc-2",
            version="v1",
            job_id="job-x",
            name=NAME,
            edition=edition(2025),
            chunks=plain_chunks("other", 2),
        )
        await index_version(
            indexer,
            doc_id="doc-1",
            version="v1",
            job_id="job-1",
            name=NAME,
            edition=edition(2025),
            chunks=plain_chunks("v1", 3),
        )
        await index_version(
            indexer,
            doc_id="doc-1",
            version="v2",
            job_id="job-2",
            name=NAME,
            edition=edition(2025),
            chunks=plain_chunks("v2", 2),
        )

        assert await active_ids(store, "doc-2") == ids_of(other)
        assert await latest_of(store, "doc-1") == {True}
        assert await latest_of(store, "doc-2") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.3")
@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_empty_version_recalculates_latest(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.3.3] 빈 records로 write하면 같은 이름의 다른 판이 최신판이 된다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await index_version(
            indexer,
            doc_id="doc-2",
            version="v1",
            job_id="job-x",
            name=NAME,
            edition=edition(2022),
            chunks=plain_chunks("other", 2),
        )
        await index_version(
            indexer,
            doc_id="doc-1",
            version="v1",
            job_id="job-1",
            name=NAME,
            edition=edition(2025),
            chunks=plain_chunks("v1", 3),
        )
        assert await latest_of(store, "doc-2") == {False}
        inp = make_input(
            doc_id="doc-1", version="v2", job_id="job-2", name=NAME, edition=edition(2025)
        )
        embedded = await indexer.embed(inp, chunking_result([]))

        assert await indexer.write(embedded) == 0

        assert await active_ids(store, "doc-1") == set()
        assert await latest_of(store, "doc-2") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_name_change_recalculates_old_and_new_names(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.3] write로 이름이 바뀌면 이전 이름과 새 이름의 최신판 표시가 각각 맞는다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        for doc_id, name, year in [
            ("doc-1", "옛 이름", 2025),
            ("doc-2", "옛 이름", 2022),
            ("doc-3", "새 이름", 2024),
        ]:
            await index_version(
                indexer,
                doc_id=doc_id,
                version="v1",
                job_id=f"job-{doc_id}",
                name=name,
                edition=edition(year),
                chunks=plain_chunks(doc_id, 2),
            )
        assert await latest_of(store, "doc-2") == {False}

        await index_version(
            indexer,
            doc_id="doc-1",
            version="v2",
            job_id="job-2",
            name="새 이름",
            edition=edition(2025),
            chunks=plain_chunks("v2", 2),
        )

        # 이전 이름: 남은 2022판이 최신판이 된다
        assert await latest_of(store, "doc-2") == {True}
        # 새 이름: 2025판만 최신판이다
        assert await latest_of(store, "doc-1") == {True}
        assert await latest_of(store, "doc-3") == {False}
        assert {r.name for r in await store.active_records("doc-1")} == {"새 이름"}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_edition_change_recalculates(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.3] write로 판만 바뀌어도(2025에서 2020) 같은 이름의 최신판 표시를 맞춘다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        for doc_id, year in [("doc-1", 2025), ("doc-2", 2022)]:
            await index_version(
                indexer,
                doc_id=doc_id,
                version="v1",
                job_id=f"job-{doc_id}",
                name=NAME,
                edition=edition(year),
                chunks=plain_chunks(doc_id, 2),
            )

        await index_version(
            indexer,
            doc_id="doc-1",
            version="v2",
            job_id="job-2",
            name=NAME,
            edition=edition(2020),
            chunks=plain_chunks("v2", 2),
        )

        assert await latest_of(store, "doc-2") == {True}
        assert await latest_of(store, "doc-1") == {False}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_write_same_version_string_does_not_mix(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.3.3] 같은 version을 다시 색인해도 이전 레코드와 섞이지 않고 새 레코드만 남는다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        first, _ = await index_version(
            indexer,
            doc_id="doc-1",
            version="v1",
            job_id="job-1",
            name=NAME,
            edition=None,
            chunks=plain_chunks("same", 3),
        )
        second, written = await index_version(
            indexer,
            doc_id="doc-1",
            version="v1",
            job_id="job-2",
            name=NAME,
            edition=None,
            chunks=plain_chunks("same", 3),
        )

        assert written == 3
        assert ids_of(first).isdisjoint(ids_of(second))
        assert await active_ids(store, "doc-1") == ids_of(second)
        assert await job_ids(store, "doc-1", "job-1") == set()

    run(scenario())


@pytest.mark.req("REQ-RAG-3.3.2")
def test_write_propagates_dimension_mismatch(settings: Settings) -> None:
    """[REQ-RAG-3.3.2] resource의 VectorDimensionMismatchError를 바꾸지 않고 그대로 낸다."""

    async def scenario() -> None:
        store, indexer, embedded, v1_ids, _before = await _failure_setup(settings)
        error = VectorDimensionMismatchError()
        store.fail["upsert"] = error

        with pytest.raises(VectorDimensionMismatchError) as raised:
            await indexer.write(embedded)

        assert raised.value is error
        assert await active_ids(as_store(store), "doc-1") == v1_ids

    run(scenario())
