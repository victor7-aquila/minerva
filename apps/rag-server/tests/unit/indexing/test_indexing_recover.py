"""기동 복구(Indexer.recover) 테스트 (REQ-RAG-10.8.5.3)."""

import pytest

from minerva_rag.core import ChunkRecord, Settings
from minerva_rag.resource import ChunkStore

from .fakes import (
    BACKENDS,
    active_ids,
    edition,
    job_ids,
    latest_of,
    make_indexer,
    make_record,
    make_store,
    run,
    seed,
)


def _record(chunk_id: str, job_id: str, *, active: bool, year: int, latest: bool) -> ChunkRecord:
    """doc-1의 레코드를 만든다(버전은 작업 ID에서 따온다)."""
    return make_record(
        chunk_id,
        doc_id="doc-1",
        version=f"ver-{job_id}",
        job_id=job_id,
        active=active,
        name="N",
        edition=edition(year),
        is_latest=latest,
    )


def _v1() -> list[ChunkRecord]:
    """active인 이전 버전(2024판, 최신판 표시 참) 레코드 두 개다."""
    return [_record(f"v1-{i}", "job-1", active=True, year=2024, latest=True) for i in range(2)]


def _v2(*, active: bool) -> list[ChunkRecord]:
    """새 버전(2025판) 레코드 두 개다."""
    return [_record(f"v2-{i}", "job-2", active=active, year=2025, latest=False) for i in range(2)]


async def _state(store: ChunkStore, kind: str) -> None:
    """kind에 맞는 복구 대상 상태를 저장소에 만든다."""
    if kind == "after":
        await seed(store, [*_v1(), *_v2(active=True)])
    else:
        await seed(store, [*_v1(), *_v2(active=False)])


@pytest.mark.req("REQ-RAG-10.8.5.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_recover_after_activation_true(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-10.8.5.3] 활성화 뒤 상태는 참이고 이전 레코드가 지워지며 최신판 표시를 맞춘다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await _state(store, "after")

        assert await indexer.recover("doc-1", "job-2") is True

        assert await active_ids(store, "doc-1") == {"v2-0", "v2-1"}
        assert await job_ids(store, "doc-1", "job-1") == set()
        assert await latest_of(store, "doc-1") == {True}

    run(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_recover_before_activation_false(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-10.8.5.3] 활성화 전 상태는 거짓이고 그 작업의 레코드가 지워진다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await _state(store, "before")

        assert await indexer.recover("doc-1", "job-2") is False

        assert await job_ids(store, "doc-1", "job-2") == set()
        assert await active_ids(store, "doc-1") == {"v1-0", "v1-1"}

    run(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_recover_no_records_false(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-10.8.5.3] 그 작업의 레코드가 없으면 거짓이다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)

        assert await indexer.recover("doc-1", "job-2") is False

    run(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("kind", ["after", "before"])
def test_recover_idempotent(
    kind: str, backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-10.8.5.3] 여러 번 불러도 결과와 상태가 같다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        await _state(store, kind)

        first = await indexer.recover("doc-1", "job-2")
        state_after_first = (
            await active_ids(store, "doc-1"),
            await job_ids(store, "doc-1", "job-1"),
            await job_ids(store, "doc-1", "job-2"),
            await latest_of(store, "doc-1"),
        )
        second = await indexer.recover("doc-1", "job-2")

        assert first is (kind == "after")
        assert second is first
        assert (
            await active_ids(store, "doc-1"),
            await job_ids(store, "doc-1", "job-1"),
            await job_ids(store, "doc-1", "job-2"),
            await latest_of(store, "doc-1"),
        ) == state_after_first

    run(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
@pytest.mark.parametrize("backend", BACKENDS)
def test_recover_partial_activation_true(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-10.8.5.3] 일부만 active여도 활성화 뒤로 보아 나머지를 활성화하고 참이다."""

    async def scenario() -> None:
        store = await make_store(backend, monkeypatch)
        indexer, _ = make_indexer(store, settings)
        partial = [
            _record("v2-0", "job-2", active=True, year=2025, latest=False),
            _record("v2-1", "job-2", active=False, year=2025, latest=False),
        ]
        await seed(store, [*_v1(), *partial])

        assert await indexer.recover("doc-1", "job-2") is True

        assert await active_ids(store, "doc-1") == {"v2-0", "v2-1"}
        assert await job_ids(store, "doc-1", "job-1") == set()

    run(scenario())
