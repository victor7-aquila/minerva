"""작업 접수와 작업 상태(REQ-RAG-10.8.1, REQ-RAG-10.8.2) 테스트."""

import asyncio

import pytest

from minerva_rag.core import FailureLocation, JobNotFoundError, Settings, ShuttingDownError
from minerva_rag.service import IndexOutcome, JobStage, JobState
from minerva_rag.service.jobs import JobFailure, JobManager

from .fakes import (
    WAIT,
    FakeReceiver,
    RecoverSpy,
    ScriptedRunner,
    go,
    new_manager,
    notified,
    running_manager,
    settle,
    submit,
    wait_event,
    wait_state,
)

_ALLOWED_PATHS = [
    ["queued", "running", "succeeded"],
    ["queued", "running", "failed"],
    ["queued", "superseded"],
    ["queued", "failed"],
]


@pytest.mark.req("REQ-RAG-10.8.1.1")
def test_submit_returns_immediately(settings: Settings) -> None:
    """[REQ-RAG-10.8.1.1] 끝나지 않는 러너를 넘겨도 submit이 작업 ID를 돌려준다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(WAIT)  # 풀지 않는다
            job_id = await asyncio.wait_for(submit(manager, "doc-a", runner), 5)
            assert job_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.1.1")
def test_submit_after_stop(settings: Settings) -> None:
    """[REQ-RAG-10.8.1.1] stop 뒤의 submit은 ShuttingDownError다."""

    async def scenario() -> None:
        manager = await new_manager(settings)
        await manager.stop(0)
        with pytest.raises(ShuttingDownError):
            await submit(manager, "doc-a", ScriptedRunner())

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.1.1")
def test_stop_before_start(settings: Settings) -> None:
    """[REQ-RAG-10.8.1.1] start 전에도 stop이 되고 그 뒤 submit은 ShuttingDownError다."""

    async def scenario() -> None:
        manager = JobManager(settings)
        with pytest.raises(RuntimeError):
            await manager.get_job("job-1")
        await manager.stop(0)
        with pytest.raises(ShuttingDownError):
            await submit(manager, "doc-a", ScriptedRunner())

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.1.2")
def test_starts_queued(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.1.2] 접수 직후 상태는 QUEUED이고 첫 알림도 queued다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            blocker = ScriptedRunner(WAIT)
            await submit(manager, "doc-b", blocker)
            await wait_event(blocker.waiting)  # 상한 1을 차지한다

            job_id = await submit(manager, "doc-a", ScriptedRunner())

            assert (await manager.get_job(job_id)).state is JobState.QUEUED
            await notified(receiver, job_id, "queued")
            assert receiver.states(job_id)[0] == "queued"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.1")
def test_transitions_follow_paths(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.2.1] 어떤 경로로 끝나도 알림 상태 목록이 허용된 경로의 앞부분이다."""

    async def scenario() -> dict[str, str]:
        ids: dict[str, str] = {}
        first = await new_manager(settings)
        try:
            ids["ok"] = await submit(first, "doc-a", ScriptedRunner())
            await notified(receiver, ids["ok"], "succeeded")
            failing = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            ids["fail"] = await submit(first, "doc-b", failing)
            await notified(receiver, ids["fail"], "failed")

            blocker = ScriptedRunner(WAIT)
            ids["blocker"] = await submit(first, "doc-c", blocker)
            await wait_event(blocker.waiting)
            ids["superseded"] = await submit(first, "doc-d", ScriptedRunner(), version="v1")
            ids["pending"] = await submit(first, "doc-d", ScriptedRunner(), version="v2")
            ids["deleted"] = await submit(first, "doc-e", ScriptedRunner())
            await first.fail_queued("doc-e", "DOCUMENT_DELETED", "삭제 요청")
            await notified(receiver, ids["deleted"], "failed")
            await notified(receiver, ids["pending"], "queued")
            await notified(receiver, ids["superseded"], "superseded")
            await notified(receiver, ids["blocker"], "running")
        finally:
            await first.stop(0)

        # 다시 시작: 대기 작업과 색인 중이던 작업이 실패로 끝맺어진다
        second = await new_manager(settings, RecoverSpy(False))
        try:
            await notified(receiver, ids["blocker"], "failed")
            await notified(receiver, ids["pending"], "failed")
        finally:
            await second.stop(0)
        return ids

    ids = go(scenario())

    assert receiver.states(ids["ok"]) == ["queued", "running", "succeeded"]
    assert receiver.states(ids["fail"]) == ["queued", "running", "failed"]
    assert receiver.states(ids["superseded"]) == ["queued", "superseded"]
    assert receiver.states(ids["deleted"]) == ["queued", "failed"]
    assert receiver.states(ids["blocker"]) == ["queued", "running", "failed"]
    assert receiver.states(ids["pending"]) == ["queued", "failed"]
    for job_id in ids.values():
        states = receiver.states(job_id)
        assert any(states == path[: len(states)] for path in _ALLOWED_PATHS), states


@pytest.mark.req("REQ-RAG-10.8.2.1")
def test_terminal_states_fixed(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.2.1] 끝난 작업은 이후 fail_queued와 새 접수에도 상태·알림이 그대로다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            failed_id = await submit(
                manager, "doc-a", ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "오류"))
            )
            await wait_state(manager, failed_id, JobState.FAILED)

            running = ScriptedRunner(WAIT)
            succeeded_id = await submit(manager, "doc-a", running, version="v2")
            await wait_event(running.waiting)
            superseded_id = await submit(manager, "doc-a", ScriptedRunner(), version="v3")
            last_id = await submit(manager, "doc-a", ScriptedRunner(), version="v4")
            running.release.set()
            await wait_state(manager, last_id, JobState.SUCCEEDED)
            await notified(receiver, last_id, "succeeded")
            await notified(receiver, superseded_id, "superseded")

            finished = [failed_id, succeeded_id, superseded_id]
            views = {job_id: await manager.get_job(job_id) for job_id in finished}
            assert [v.state for v in views.values()] == [
                JobState.FAILED,
                JobState.SUCCEEDED,
                JobState.SUPERSEDED,
            ]
            counts = {job_id: len(receiver.bodies(job_id=job_id)) for job_id in finished}

            await manager.fail_queued("doc-a", "DOCUMENT_DELETED", "삭제 요청")
            newest = await submit(manager, "doc-a", ScriptedRunner(), version="v5")
            await wait_state(manager, newest, JobState.SUCCEEDED)
            await notified(receiver, newest, "succeeded")
            await settle()

            for job_id in finished:
                assert await manager.get_job(job_id) == views[job_id]
                assert len(receiver.bodies(job_id=job_id)) == counts[job_id]

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.2")
def test_get_job(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.2] 접수한 작업을 ID로 조회하면 문서·버전이 나온다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner(WAIT), version="v7")
            view = await manager.get_job(job_id)
            assert view.job_id == job_id
            assert view.doc_id == "doc-a"
            assert view.version == "v7"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.2")
def test_unknown_job(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.2] 없는 작업 ID는 JobNotFoundError다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            with pytest.raises(JobNotFoundError):
                await manager.get_job("no-such-job")

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.3")
def test_stage_recorded(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.3] 알린 단계가 색인 중 조회되고, 대기·완료 작업의 단계는 None이다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            job_id = await submit(manager, "doc-a", runner)
            await wait_event(runner.waiting)
            assert (await manager.get_job(job_id)).stage is JobStage.EMBEDDING

            queued_id = await submit(manager, "doc-b", ScriptedRunner())  # 상한 1이라 대기한다
            queued = await manager.get_job(queued_id)
            assert queued.state is JobState.QUEUED
            assert queued.stage is None

            runner.release.set()
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            assert (await manager.get_job(job_id)).stage is None

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.3")
def test_running_starts_with_chunking(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.3] 러너가 단계를 알리기 전에도 RUNNING 작업의 단계는 CHUNKING이다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(WAIT)  # 단계를 알리지 않는다
            job_id = await submit(manager, "doc-a", runner)
            await wait_event(runner.waiting)
            view = await manager.get_job(job_id)
            assert view.state is JobState.RUNNING
            assert view.stage is JobStage.CHUNKING

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.4")
def test_job_failure_recorded(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.4] JobFailure의 코드·설명이 그대로 조회된다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(
                result=JobFailure("STORE_UNAVAILABLE", "저장소에 연결하지 못했습니다")
            )
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.FAILED)
            failure = (await manager.get_job(job_id)).failure
            assert failure is not None
            assert failure.code == "STORE_UNAVAILABLE"
            assert failure.message == "저장소에 연결하지 못했습니다"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.4")
def test_unexpected_error_internal(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.4] 다른 예외는 INTERNAL_ERROR와 내부 정보 없는 한국어 설명으로 기록된다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(result=RuntimeError("secret-detail C:\\x\\y.py"))
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.FAILED)
            failure = (await manager.get_job(job_id)).failure
            assert failure is not None
            assert failure.code == "INTERNAL_ERROR"
            assert failure.message
            assert any("가" <= ch <= "힣" for ch in failure.message)
            assert "secret-detail" not in failure.message
            assert "y.py" not in failure.message

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.5")
@pytest.mark.parametrize(
    "location",
    [
        FailureLocation(("설치", "Docker"), "t1"),
        FailureLocation(None, "t1"),
        FailureLocation(("A",), None),
        None,
    ],
)
def test_failure_location(settings: Settings, location: FailureLocation | None) -> None:
    """[REQ-RAG-10.8.2.5] JobFailure의 위치가 같은 값으로 조회되고, 없으면 None이다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(result=JobFailure("CHUNKING_FAILED", "분할 실패", location))
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.FAILED)
            failure = (await manager.get_job(job_id)).failure
            assert failure is not None
            assert failure.location == location

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.5")
def test_empty_location_is_none(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.5] 위치의 두 값이 모두 None이면 위치를 기록하지 않는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(
                result=JobFailure("CHUNKING_FAILED", "분할 실패", FailureLocation(None, None))
            )
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.FAILED)
            failure = (await manager.get_job(job_id)).failure
            assert failure is not None
            assert failure.location is None

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.6")
def test_success_result(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.6] 러너의 결과가 SUCCEEDED와 함께 문서·버전·결과로 조회된다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(result=IndexOutcome(7, True))
            job_id = await submit(manager, "doc-a", runner, version="v3")
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            view = await manager.get_job(job_id)
            assert view.result == IndexOutcome(7, True)
            assert view.doc_id == "doc-a"
            assert view.version == "v3"
            assert view.failure is None

    go(scenario())
