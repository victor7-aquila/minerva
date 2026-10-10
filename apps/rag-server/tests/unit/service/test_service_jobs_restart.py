"""중단과 복구(REQ-RAG-10.8.5)와 종료 때 작업 기다리기(REQ-RAG-10.1.3) 테스트."""

import asyncio

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import FailureLocation, Settings, StoreUnavailableError
from minerva_rag.service import IndexOutcome, JobState
from minerva_rag.service.jobs import JobFailure, JobManager

from .fakes import (
    WAIT,
    FakeReceiver,
    RecoverSpy,
    ScriptedRunner,
    assert_service_log,
    go,
    new_manager,
    notified,
    running_manager,
    settle,
    submit,
    wait_event,
    wait_state,
)


async def seed_leftovers(settings: Settings, receiver: FakeReceiver) -> tuple[str, str]:
    """색인 중인 작업 R(doc-a)과 대기 중인 작업 Q(doc-b)를 남기고 관리자를 멈춘다.

    R은 prepared 결과를 알린 뒤 멈춰 있다. 두 작업의 상태 알림이 도착한 뒤에 멈춘다.
    """
    first = await new_manager(settings)  # 동시 실행 상한 1
    try:
        running = ScriptedRunner(IndexOutcome(3, True), WAIT)
        r_id = await submit(first, "doc-a", running, version="v1")
        await wait_event(running.waiting)
        q_id = await submit(first, "doc-b", ScriptedRunner(), version="v1")
        await notified(receiver, r_id, "running")
        await notified(receiver, q_id, "queued")
    finally:
        await first.stop(0)
    return r_id, q_id


@pytest.mark.req("REQ-RAG-10.8.5.1")
def test_finished_jobs_survive_restart(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.1] 같은 DB 경로로 새로 시작하면 끝난 작업이 같은 상태·결과로 조회된다."""

    async def scenario() -> None:
        first = await new_manager(settings)
        try:
            ok_id = await submit(
                first, "doc-a", ScriptedRunner(result=IndexOutcome(2, False)), version="v1"
            )
            location = FailureLocation(("설치", "Docker"), "t1")
            failed_id = await submit(
                first,
                "doc-b",
                ScriptedRunner(result=JobFailure("CHUNKING_FAILED", "분할 실패", location)),
            )
            blocker = ScriptedRunner(WAIT)
            await submit(first, "doc-d", blocker)
            await wait_event(blocker.waiting)
            superseded_id = await submit(first, "doc-d", ScriptedRunner(), version="v2")
            last_id = await submit(first, "doc-d", ScriptedRunner(), version="v3")
            blocker.release.set()
            await wait_state(first, ok_id, JobState.SUCCEEDED)
            await wait_state(first, failed_id, JobState.FAILED)
            await wait_state(first, last_id, JobState.SUCCEEDED)
            ids = [ok_id, failed_id, superseded_id]
            before = [await first.get_job(job_id) for job_id in ids]
        finally:
            await first.stop(0)

        second = await new_manager(settings)
        try:
            after = [await second.get_job(job_id) for job_id in ids]
            assert after == before
            assert before[0].state is JobState.SUCCEEDED
            assert before[0].result == IndexOutcome(2, False)
            assert before[1].failure is not None
            assert before[1].failure.location == location
            assert before[2].state is JobState.SUPERSEDED
        finally:
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.2")
def test_unfinished_fail_on_restart(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.2] 다시 시작하면 대기·색인 중 작업이 SERVER_RESTARTED로 실패하고 알린다."""

    async def scenario() -> None:
        r_id, q_id = await seed_leftovers(settings, receiver)
        spy = RecoverSpy(False)
        second = await new_manager(settings, spy)
        try:
            for job_id in (r_id, q_id):
                view = await second.get_job(job_id)
                assert view.state is JobState.FAILED
                assert view.failure is not None
                assert view.failure.code == "SERVER_RESTARTED"
            await notified(receiver, r_id, "failed")
            await notified(receiver, q_id, "failed")
            await settle()
            assert receiver.states(r_id).count("failed") == 1
            assert receiver.states(q_id).count("failed") == 1
            # recover는 색인 중이던 작업에만 부른다
            assert spy.calls == [("doc-a", r_id)]
        finally:
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.2")
def test_new_jobs_after_restart(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.2] start가 돌아온 시점에 남은 작업이 끝나 있고 새 작업은 정상 실행된다."""

    async def scenario() -> None:
        r_id, q_id = await seed_leftovers(settings, receiver)
        second = await new_manager(settings, RecoverSpy(False))
        try:
            assert (await second.get_job(r_id)).state is JobState.FAILED
            assert (await second.get_job(q_id)).state is JobState.FAILED

            new_id = await submit(second, "doc-c", ScriptedRunner())
            await wait_state(second, new_id, JobState.SUCCEEDED)
        finally:
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.2")
def test_no_new_job_before_start_finishes(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.2] start 중의 submit은 RuntimeError이고 그 러너는 실행되지 않는다."""

    async def scenario() -> None:
        r_id, q_id = await seed_leftovers(settings, receiver)
        entered = asyncio.Event()
        gate = asyncio.Event()

        async def slow_recover(doc_id: str, job_id: str) -> bool:
            entered.set()
            await gate.wait()
            return False

        second = JobManager(settings)
        starting = asyncio.create_task(second.start(slow_recover))
        try:
            await wait_event(entered)  # start가 남은 작업을 끝맺는 중이다
            late = ScriptedRunner()
            with pytest.raises(RuntimeError):
                await submit(second, "doc-c", late)
            await settle()
            assert late.calls == 0

            gate.set()
            await asyncio.wait_for(starting, 5)
            assert (await second.get_job(r_id)).state is JobState.FAILED
            assert (await second.get_job(q_id)).state is JobState.FAILED
            assert late.calls == 0

            new_id = await submit(second, "doc-c", ScriptedRunner())  # start가 끝나면 접수된다
            await wait_state(second, new_id, JobState.SUCCEEDED)
        finally:
            gate.set()
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
def test_recovered_job_succeeds(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.3] recover가 참이면 prepared 결과로 SUCCEEDED가 되고 검색 버전이 바뀐다."""

    async def scenario() -> None:
        r_id, q_id = await seed_leftovers(settings, receiver)
        second = await new_manager(settings, RecoverSpy(True))
        try:
            view = await second.get_job(r_id)
            assert view.state is JobState.SUCCEEDED
            assert view.result == IndexOutcome(3, True)
            assert (await second.index_state("doc-a")).searchable_version == "v1"
            await notified(receiver, r_id, "succeeded")
            queued = await second.get_job(q_id)
            assert queued.state is JobState.FAILED
            assert queued.failure is not None
            assert queued.failure.code == "SERVER_RESTARTED"
        finally:
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
def test_recover_error_propagates(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.3] recover가 예외를 내면 start가 그 예외를 내고 다음 start에서 확인된다."""

    async def scenario() -> None:
        r_id, _ = await seed_leftovers(settings, receiver)
        broken = JobManager(settings)
        error = StoreUnavailableError()
        try:
            with pytest.raises(StoreUnavailableError) as caught:
                await broken.start(RecoverSpy(error))
            assert caught.value is error
        finally:
            await broken.stop(0)

        third = await new_manager(settings, RecoverSpy(True))
        try:
            assert (await third.get_job(r_id)).state is JobState.SUCCEEDED
        finally:
            await third.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.3")
@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (IndexOutcome(2, False), JobState.SUCCEEDED),
        (JobFailure("STORE_UNAVAILABLE", "저장소 오류"), JobState.FAILED),
    ],
    ids=["success", "failure"],
)
def test_stop_waits_and_records(
    settings: Settings, result: IndexOutcome | JobFailure, expected: JobState
) -> None:
    """[REQ-RAG-10.1.3] stop은 색인 중인 작업을 기다리고 그 안에 끝난 결과를 기록한다."""

    async def scenario() -> None:
        manager = await new_manager(settings)
        runner = ScriptedRunner(WAIT, result=result)
        job_id = await submit(manager, "doc-a", runner)
        await wait_event(runner.waiting)

        stopping = asyncio.create_task(manager.stop(30.0))
        await settle()
        assert not stopping.done()  # 작업이 끝나기 전에는 stop도 끝나지 않는다

        runner.release.set()
        await asyncio.wait_for(stopping, 5)

        # ★ stop 뒤 조회는 명세 밖이다 — 새 관리자로 조회한다
        async with running_manager(settings) as after:
            assert (await after.get_job(job_id)).state is expected

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.3")
def test_stop_timeout_leaves_running(settings: Settings) -> None:
    """[REQ-RAG-10.1.3] 시간 안에 끝나지 않은 작업은 RUNNING으로 남고 다음 start가 끝맺는다."""

    async def scenario() -> None:
        first = await new_manager(settings)
        runner = ScriptedRunner(WAIT)  # 풀지 않는다
        job_id = await submit(first, "doc-a", runner)
        await wait_event(runner.waiting)

        await first.stop(0)

        spy = RecoverSpy(False)
        async with running_manager(settings, spy) as second:
            assert spy.calls == [("doc-a", job_id)]  # 다음 start가 RUNNING으로 남은 작업을 본다
            view = await second.get_job(job_id)
            assert view.state is JobState.FAILED
            assert view.failure is not None
            assert view.failure.code == "SERVER_RESTARTED"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.2")
@pytest.mark.req("REQ-RAG-10.8.5.3")
def test_restart_resolved_log(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.2] 다시 시작에서 끝맺은 작업 수를 job_restart_resolved warning으로 남긴다."""

    async def scenario() -> None:
        await seed_leftovers(settings, receiver)
        with capture_logs() as logs:
            second = await new_manager(settings, RecoverSpy(True))
        await second.stop(0)
        entries = assert_service_log(
            list(logs), "service.job_restart_resolved", "warning", {"failed", "recovered"}
        )
        assert sum(int(e["failed"]) for e in entries) == 1  # 대기 작업 Q
        assert sum(int(e["recovered"]) for e in entries) == 1  # 색인 중이던 R

    go(scenario())
