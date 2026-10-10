"""이름·판 정보와 최신판 표시 테스트 (REQ-RAG-3.6)."""

import asyncio
from datetime import date

import pytest

from minerva_rag.core import Edition, Settings
from minerva_rag.indexing import Indexer
from minerva_rag.resource import ChunkStore

from .fakes import (
    BACKENDS,
    FakeChunkStore,
    active_ids,
    as_store,
    edition,
    ids_of,
    index_version,
    latest_of,
    make_indexer,
    make_record,
    make_store,
    plain_chunks,
    run,
    seed,
)

NAME = "IEEE 1609.2.1"


async def _index(
    indexer: Indexer, doc_id: str, name: str, edition_value: Edition | None
) -> set[str]:
    """문서 하나를 v1로 색인하고 chunk_id 집합을 돌려준다."""
    embedded, _ = await index_version(
        indexer,
        doc_id=doc_id,
        version="v1",
        job_id=f"job-{doc_id}",
        name=name,
        edition=edition_value,
        chunks=plain_chunks(doc_id, 2),
    )
    return ids_of(embedded)


async def _names(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> tuple[ChunkStore, Indexer]:
    """백엔드별 저장소와 Indexer를 만든다."""
    store = await make_store(backend, monkeypatch)
    indexer, _ = make_indexer(store, settings)
    return store, indexer


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_latest_is_latest_date(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.3] 2022·2025판이 있으면 2025판만 최신판이다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        await _index(indexer, "doc-a", NAME, edition(2022))
        await _index(indexer, "doc-b", NAME, edition(2025))

        assert await latest_of(store, "doc-a") == {False}
        assert await latest_of(store, "doc-b") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_latest_ties_all_true(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.3] 2025판이 둘이면 둘 다 최신판이다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        await _index(indexer, "doc-a", NAME, edition(2022))
        await _index(indexer, "doc-b", NAME, edition(2025))
        await _index(indexer, "doc-c", NAME, Edition("2025-개정", date(2025, 3, 1)))

        assert await latest_of(store, "doc-a") == {False}
        assert await latest_of(store, "doc-b") == {True}
        assert await latest_of(store, "doc-c") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_latest_moves_after_delete(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.3] 2025판을 지우면 2022판이 최신판이 된다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        await _index(indexer, "doc-a", NAME, edition(2022))
        await _index(indexer, "doc-b", NAME, edition(2025))

        await indexer.delete_document("doc-b")

        assert await latest_of(store, "doc-a") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.req("REQ-RAG-3.6.4")
@pytest.mark.parametrize("backend", BACKENDS)
def test_unversioned_never_latest(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.3] 판 정보가 없는 문서는 최신판이 아니다(판이 있는 문서가 없어도)."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        await _index(indexer, "doc-n", NAME, None)
        await _index(indexer, "doc-b", NAME, edition(2025))
        await _index(indexer, "doc-only", "다른 이름", None)

        assert await latest_of(store, "doc-n") == {False}
        assert await latest_of(store, "doc-b") == {True}
        assert await latest_of(store, "doc-only") == {False}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.4")
def test_unversioned_document_indexed(settings: Settings) -> None:
    """[REQ-RAG-3.6.4] 판 정보가 없는 입력도 색인되고 edition은 None, 최신판은 거짓이다."""

    async def scenario() -> None:
        store = FakeChunkStore()
        indexer, _ = make_indexer(as_store(store), settings)
        ids = await _index(indexer, "doc-1", NAME, None)

        records = await as_store(store).active_records("doc-1")
        assert {r.chunk_id for r in records} == ids
        assert all(r.edition is None and r.is_latest_edition is False for r in records)

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
def test_latest_recalc_serialized_per_name(settings: Settings) -> None:
    """[REQ-RAG-3.6.3] 같은 이름의 최신판 재계산은 한 번에 하나씩 하고 결과가 맞다."""

    async def scenario() -> None:
        store = FakeChunkStore()
        checked = as_store(store)
        indexer, _ = make_indexer(checked, settings)
        await _index(indexer, "doc-a", "X", edition(2022))
        await _index(indexer, "doc-b", "Y", edition(2025))
        store.calls.clear()

        await asyncio.gather(
            indexer.update_metadata("doc-a", "N", edition(2022)),
            indexer.update_metadata("doc-b", "N", edition(2025)),
        )

        names = [
            name
            for name, args in store.calls
            if name in {"active_editions", "set_latest_editions"} and args[0] == "N"
        ]
        # ★ 잠금이 없으면 두 재계산이 겹쳐 active_editions가 연달아 나온다
        assert names
        assert names[-1] == "set_latest_editions"
        assert all(
            not (a == b == "active_editions") for a, b in zip(names, names[1:], strict=False)
        )
        assert await latest_of(checked, "doc-b") == {True}
        assert await latest_of(checked, "doc-a") == {False}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.5")
@pytest.mark.parametrize("backend", BACKENDS)
def test_rename_updates_all_records_without_models(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.5] 이름을 바꾸면 모든 레코드의 name이 새 값이고 모델 호출이 없다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, hub = make_indexer(store, settings)
        await _index(indexer, "doc-1", "옛 이름", edition(2025))
        calls_before = hub.calls

        await indexer.update_metadata("doc-1", "새 이름", edition(2025))

        records = await store.active_records("doc-1")
        assert len(records) == 2
        assert all(r.name == "새 이름" for r in records)
        assert hub.calls == calls_before

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.5")
@pytest.mark.parametrize("backend", BACKENDS)
def test_rename_recalculates_old_and_new_names(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.5] 이름을 바꾸면 옛 이름과 새 이름의 최신판 표시가 각각 맞는다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        await _index(indexer, "doc-1", "옛 이름", edition(2025))
        await _index(indexer, "doc-2", "옛 이름", edition(2022))
        await _index(indexer, "doc-3", "새 이름", edition(2024))
        assert await latest_of(store, "doc-2") == {False}

        await indexer.update_metadata("doc-1", "새 이름", edition(2025))

        assert await latest_of(store, "doc-2") == {True}
        assert await latest_of(store, "doc-1") == {True}
        assert await latest_of(store, "doc-3") == {False}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.5")
@pytest.mark.parametrize("backend", BACKENDS)
def test_edition_change_recalculates(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.5] 판 정보를 바꾸면 모든 레코드의 edition이 바뀌고 최신판 표시를 다시 맞춘다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        await _index(indexer, "doc-1", NAME, edition(2025))
        await _index(indexer, "doc-2", NAME, edition(2022))

        await indexer.update_metadata("doc-1", NAME, edition(2020))

        records = await store.active_records("doc-1")
        assert all(r.edition == edition(2020) for r in records)
        assert await latest_of(store, "doc-2") == {True}
        assert await latest_of(store, "doc-1") == {False}

        await indexer.update_metadata("doc-1", NAME, None)

        records = await store.active_records("doc-1")
        assert all(r.edition is None for r in records)
        assert await latest_of(store, "doc-1") == {False}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.6")
@pytest.mark.parametrize("backend", BACKENDS)
def test_metadata_keeps_same_name_edition_document(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.6] 같은 이름·판으로 바꿔도 다른 문서의 레코드는 그대로이고 둘 다 최신판이다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)
        a_ids = await _index(indexer, "doc-a", "N", edition(2025))
        await _index(indexer, "doc-b", "M", edition(2022))

        await indexer.update_metadata("doc-b", "N", edition(2025))

        assert await active_ids(store, "doc-a") == a_ids
        assert await latest_of(store, "doc-a") == {True}
        assert await latest_of(store, "doc-b") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.7")
@pytest.mark.parametrize("backend", BACKENDS)
def test_metadata_missing_document_ok(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.7] 레코드가 없는 문서의 update_metadata는 오류 없이 끝난다."""

    async def scenario() -> None:
        store, indexer = await _names(backend, settings, monkeypatch)

        await indexer.update_metadata("nope", "새 이름", edition(2025))

        assert await store.active_records("nope") == []

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.7")
def test_metadata_missing_document_no_writes(settings: Settings) -> None:
    """[REQ-RAG-3.6.7] 레코드가 없는 문서의 update_metadata는 resource에 쓰지 않는다."""
    store = FakeChunkStore()
    indexer, _ = make_indexer(as_store(store), settings)

    run(indexer.update_metadata("nope", "새 이름", edition(2025)))

    assert store.writes() == []


@pytest.mark.req("REQ-RAG-3.6.7")
def test_metadata_inactive_only_document_no_writes(settings: Settings) -> None:
    """[REQ-RAG-3.6.7] active 레코드가 없는 문서의 update_metadata는 resource에 쓰지 않고 끝난다."""

    async def scenario() -> None:
        store = FakeChunkStore()
        indexer, _ = make_indexer(as_store(store), settings)
        await seed(
            as_store(store),
            [
                make_record(
                    "i-1",
                    doc_id="doc-1",
                    version="v1",
                    job_id="job-1",
                    active=False,
                    name=NAME,
                    edition=None,
                )
            ],
        )
        store.calls.clear()

        await indexer.update_metadata("doc-1", "새 이름", edition(2025))

        assert store.writes() == []

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.3")
def test_latest_recalc_serialized_between_delete_and_metadata(settings: Settings) -> None:
    """[REQ-RAG-3.6.3] 삭제와 이름 변경이 같은 이름을 재계산해도 한 번에 하나씩 한다."""

    async def scenario() -> None:
        store = FakeChunkStore()
        checked = as_store(store)
        indexer, _ = make_indexer(checked, settings)
        await _index(indexer, "doc-a", "X", edition(2022))
        await _index(indexer, "doc-b", "N", edition(2025))
        store.calls.clear()

        await asyncio.gather(
            indexer.update_metadata("doc-a", "N", edition(2022)),
            indexer.delete_document("doc-b"),
        )

        names = [
            name
            for name, args in store.calls
            if name in {"active_editions", "set_latest_editions"} and args[0] == "N"
        ]
        # ★ 잠금이 없으면 두 재계산이 겹쳐 active_editions가 연달아 나온다
        assert names
        assert names[-1] == "set_latest_editions"
        assert all(
            not (a == b == "active_editions") for a, b in zip(names, names[1:], strict=False)
        )
        # 2025판을 지웠으므로 이름 N에는 2022판만 남아 최신판이다
        assert await checked.active_records("doc-b") == []
        assert await latest_of(checked, "doc-a") == {True}

    run(scenario())
