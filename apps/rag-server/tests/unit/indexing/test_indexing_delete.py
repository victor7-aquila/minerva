"""문서 삭제(delete_document) 테스트 (REQ-RAG-3.4, 3.6.2)."""

import pytest

from minerva_rag.core import Settings
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
    job_ids,
    latest_of,
    make_indexer,
    make_record,
    make_store,
    plain_chunks,
    run,
    seed,
)

NAME = "IEEE 1609.2.1"


@pytest.mark.req("REQ-RAG-3.4.1")
@pytest.mark.parametrize("backend", BACKENDS)
def test_delete_removes_all_versions(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.4.1] active 레코드와 남은 inactive 레코드를 모두 지운다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await seed(
            store,
            [
                make_record(
                    "a-1",
                    doc_id="doc-1",
                    version="v2",
                    job_id="job-2",
                    active=True,
                    name=NAME,
                    edition=None,
                ),
                make_record(
                    "i-1",
                    doc_id="doc-1",
                    version="v1",
                    job_id="job-1",
                    active=False,
                    name=NAME,
                    edition=None,
                ),
            ],
        )

        await indexer.delete_document("doc-1")

        assert await job_ids(store, "doc-1", "job-1") == set()
        assert await job_ids(store, "doc-1", "job-2") == set()

    run(scenario())


async def _two_editions(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> tuple[ChunkStore, Indexer, set[str]]:
    """같은 이름의 doc-a(2022)와 doc-b(2025)를 색인한 상태를 만든다."""
    store = await make_store(backend, monkeypatch)
    indexer, _ = make_indexer(store, settings)
    embedded_a, _ = await index_version(
        indexer,
        doc_id="doc-a",
        version="v1",
        job_id="job-a",
        name=NAME,
        edition=edition(2022),
        chunks=plain_chunks("a", 2),
    )
    await index_version(
        indexer,
        doc_id="doc-b",
        version="v1",
        job_id="job-b",
        name=NAME,
        edition=edition(2025),
        chunks=plain_chunks("b", 2),
    )
    return store, indexer, ids_of(embedded_a)


@pytest.mark.req("REQ-RAG-3.4.1")
@pytest.mark.req("REQ-RAG-3.4.2")
@pytest.mark.req("REQ-RAG-3.6.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_delete_then_other_edition_latest(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.4.2] 2025판을 지우면 검색에 나오지 않고 2022판이 최신판이 된다."""

    async def scenario() -> None:
        store, indexer, _a_ids = await _two_editions(backend, settings, monkeypatch)
        assert await latest_of(store, "doc-a") == {False}

        await indexer.delete_document("doc-b")

        assert await store.active_records("doc-b") == []
        assert await latest_of(store, "doc-a") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-3.6.2")
@pytest.mark.parametrize("backend", BACKENDS)
def test_delete_keeps_other_edition_document(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.6.2] 이름이 같고 판이 다른 문서를 지워도 다른 문서의 레코드는 그대로다."""

    async def scenario() -> None:
        store, indexer, a_ids = await _two_editions(backend, settings, monkeypatch)

        await indexer.delete_document("doc-b")

        assert await active_ids(store, "doc-a") == a_ids

    run(scenario())


@pytest.mark.req("REQ-RAG-3.4.3")
def test_delete_missing_document_no_writes(settings: Settings) -> None:
    """[REQ-RAG-3.4.3] 레코드가 없는 문서의 삭제는 오류 없이 끝나고 resource에 쓰지 않는다."""
    store = FakeChunkStore()
    indexer, _ = make_indexer(as_store(store), settings)

    run(indexer.delete_document("nope"))

    assert store.writes() == []


@pytest.mark.req("REQ-RAG-3.4.3")
def test_delete_inactive_only_document_no_writes(settings: Settings) -> None:
    """[REQ-RAG-3.4.3] active 레코드가 없는 문서의 삭제는 resource에 쓰지 않고 끝난다."""

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

        await indexer.delete_document("doc-1")

        assert store.writes() == []

    run(scenario())


@pytest.mark.req("REQ-RAG-3.4.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_delete_twice_same_result(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-3.4.3] 같은 문서를 두 번 지워도 두 번째가 오류 없이 끝나고 상태가 같다."""

    async def scenario() -> None:
        store, indexer, a_ids = await _two_editions(backend, settings, monkeypatch)

        await indexer.delete_document("doc-b")
        await indexer.delete_document("doc-b")

        assert await active_ids(store, "doc-b") == set()
        assert await active_ids(store, "doc-a") == a_ids
        assert await latest_of(store, "doc-a") == {True}

    run(scenario())
