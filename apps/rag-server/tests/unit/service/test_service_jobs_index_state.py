"""문서 색인 상태(REQ-RAG-10.8.6) 테스트."""

import pytest

from minerva_rag.core import Settings
from minerva_rag.service import IndexOutcome, IndexStateView, JobStage, JobState
from minerva_rag.service.jobs import CurrentIndex, JobFailure, JobManager

from .fakes import (
    WAIT,
    ScriptedRunner,
    go,
    running_manager,
    submit,
    wait_event,
    wait_state,
)


async def _v1_ok_v2_failed(manager: JobManager) -> tuple[str, str]:
    """doc-a에 v1을 완료하고 v2를 실패시킨 뒤 두 작업 ID를 돌려준다."""
    v1 = await submit(
        manager, "doc-a", ScriptedRunner(result=IndexOutcome(2, False)), version="v1", checksum="c1"
    )
    await wait_state(manager, v1, JobState.SUCCEEDED)
    failing = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
    v2 = await submit(manager, "doc-a", failing, version="v2", checksum="c2")
    await wait_state(manager, v2, JobState.FAILED)
    return v1, v2


@pytest.mark.req("REQ-RAG-10.8.6.1")
def test_failed_keeps_searchable(settings: Settings) -> None:
    """[REQ-RAG-10.8.6.1] v1 완료 뒤 v2가 실패해도 검색되는 버전은 v1이고 최신 작업은 실패다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            v1, v2 = await _v1_ok_v2_failed(manager)

            state = await manager.index_state("doc-a")
            assert state.searchable_version == "v1"
            assert state.latest_job_id == v2
            assert state.latest_job_state is JobState.FAILED
            assert state.latest_job_stage is None
            assert await manager.current_index("doc-a") == CurrentIndex(v1, "v1", "c1")

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.6.1")
def test_forget_clears_searchable(settings: Settings) -> None:
    """[REQ-RAG-10.8.6.1] forget_document 뒤에는 검색 버전이 None이고 최신 작업 값은 그대로다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            _, v2 = await _v1_ok_v2_failed(manager)
            before = await manager.index_state("doc-a")

            await manager.forget_document("doc-a")

            state = await manager.index_state("doc-a")
            assert state.searchable_version is None
            assert state.latest_job_id == v2
            assert state.latest_job_state == before.latest_job_state
            assert await manager.current_index("doc-a") is None

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.6.2")
def test_unknown_document(settings: Settings) -> None:
    """[REQ-RAG-10.8.6.2] 작업이 없던 문서는 모든 값이 None이다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            assert await manager.index_state("none") == IndexStateView(
                "none", None, None, None, None
            )

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.6.2")
def test_running_stage_reported(settings: Settings) -> None:
    """[REQ-RAG-10.8.6.2] 최신 작업이 RUNNING이면 단계를 돌려주고, 대기 작업이면 단계는 None이다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            job_id = await submit(manager, "doc-a", runner)
            await wait_event(runner.waiting)

            running = await manager.index_state("doc-a")
            assert running.latest_job_id == job_id
            assert running.latest_job_state is JobState.RUNNING
            assert running.latest_job_stage is JobStage.EMBEDDING

            queued_id = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            queued = await manager.index_state("doc-a")
            assert queued.latest_job_id == queued_id
            assert queued.latest_job_state is JobState.QUEUED
            assert queued.latest_job_stage is None

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.6.3")
def test_many_states_order(settings: Settings) -> None:
    """[REQ-RAG-10.8.6.3] index_states는 받은 순서·개수로 돌려주고 각 항목이 단건 조회와 같다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            for doc_id in ("doc-a", "doc-b"):
                job_id = await submit(manager, doc_id, ScriptedRunner())
                await wait_state(manager, job_id, JobState.SUCCEEDED)

            ids = ["doc-b", "doc-a", "none", "doc-a"]
            states = await manager.index_states(ids)

            assert [s.doc_id for s in states] == ids
            assert len(states) == 4
            for state in states:
                assert state == await manager.index_state(state.doc_id)

    go(scenario())
