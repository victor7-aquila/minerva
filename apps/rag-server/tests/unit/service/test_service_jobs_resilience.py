"""기록·배정·기동의 실패와 호출자 취소에도 상태가 어긋나지 않는지 보는 테스트.

근거는 REQ-RAG-10.8.5(재시작 끝맺음), 10.8.7(상태가 바뀔 때마다 알림, 실패한 변경은 알리지 않음),
10.8.1(접수 계약)과 MODULE.md 「로그」의 `service.job_error` 행이다.
"""

import asyncio
import sqlite3
from typing import Any

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import Settings, StoreUnavailableError
from minerva_rag.service import IndexOutcome, JobState
from minerva_rag.service.jobs import JobFailure, JobManager

from .fakes import (
    WAIT,
    FakeReceiver,
    RecoverSpy,
    ScriptedRunner,
    assert_service_log,
    go,
    install_write_failure,
    new_manager,
    notified,
    run_logged,
    running_manager,
    settle,
    submit,
    until,
    wait_event,
    wait_state,
)

_JOB_ERROR_FIELDS = {"job_id", "doc_id", "step", "error_type"}

_RESULTS = [
    pytest.param(IndexOutcome(2, False), "succeeded", id="success"),
    pytest.param(JobFailure("STORE_UNAVAILABLE", "저장소 오류"), "failed", id="failure"),
]


def _failed_code(view: Any) -> str:
    """실패한 작업의 실패 코드를 돌려준다."""
    assert view.state is JobState.FAILED
    assert view.failure is not None
    return str(view.failure.code)


@pytest.mark.req("REQ-RAG-10.8.5.2")
@pytest.mark.req("REQ-RAG-10.8.7.1")
@pytest.mark.req("REQ-RAG-10.8.2.1")
@pytest.mark.parametrize(("result", "_final"), _RESULTS)
def test_record_exhausted(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    receiver: FakeReceiver,
    result: IndexOutcome | JobFailure,
    _final: str,
) -> None:
    """[REQ-RAG-10.8.5.2] 결과 기록이 계속 실패하면 RUNNING으로 남고 재시작이 끝맺는다."""
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        first = await new_manager(settings)
        try:
            runner = ScriptedRunner(WAIT, result=result)
            job_id = await submit(first, "doc-a", runner, version="v1")
            await wait_event(runner.waiting)
            await notified(receiver, job_id, "running")
            # 같은 문서의 다음 작업은 앞 작업이 끝나야 배정된다
            next_id = await submit(first, "doc-a", ScriptedRunner(), version="v2")
            await notified(receiver, next_id, "queued")

            # ★ 끝난 결과의 기록 쓰기가 연달아 3번 실패한다
            failure.arm_transactions(skip=0, limit=3)
            with capture_logs() as logs:
                runner.release.set()
                await wait_state(first, next_id, JobState.SUCCEEDED)  # 슬롯이 반납됐다
                await notified(receiver, next_id, "succeeded")
            failure.disarm()
            assert failure.failures == 3

            # 기록 실패 로그가 한 번, 스택과 함께 남는다
            entries = assert_service_log(
                list(logs), "service.job_error", "error", _JOB_ERROR_FIELDS, stack=True
            )
            assert len(entries) == 1
            assert entries[0]["step"] == "record"
            assert entries[0]["job_id"] == job_id
            assert entries[0]["doc_id"] == "doc-a"

            # 끝난 상태가 기록되지 않았으니 알림도 없고, 쓰기가 되살아나도 늦게 기록되지 않는다
            await settle()
            assert (await first.get_job(job_id)).state is JobState.RUNNING
            assert receiver.states(job_id) == ["queued", "running"]
            state = await first.index_state("doc-a")
            assert state.searchable_version == "v2"
            assert state.latest_job_id == next_id
        finally:
            await first.stop(0)

        # 같은 DB로 다시 시작하면 RUNNING으로 남은 작업을 SERVER_RESTARTED로 끝맺고 알린다
        spy = RecoverSpy(False)
        second = await new_manager(settings, spy)
        try:
            assert spy.calls == [("doc-a", job_id)]
            assert _failed_code(await second.get_job(job_id)) == "SERVER_RESTARTED"
            await notified(receiver, job_id, "failed")
            assert receiver.states(job_id) == ["queued", "running", "failed"]
            assert (await second.index_state("doc-a")).searchable_version == "v2"
        finally:
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.7.1")
@pytest.mark.parametrize(("result", "final"), _RESULTS)
def test_record_recovers_within_retries(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    receiver: FakeReceiver,
    result: IndexOutcome | JobFailure,
    final: str,
) -> None:
    """[REQ-RAG-10.8.7.1] 결과 기록이 2번 실패한 뒤 성공하면 정상으로 기록되고 알린다."""
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(WAIT, result=result)
            job_id = await submit(manager, "doc-a", runner, version="v1")
            await wait_event(runner.waiting)
            failure.arm_transactions(skip=0, limit=2)
            runner.release.set()
            await notified(receiver, job_id, final)
            failure.disarm()
            assert failure.failures == 2
            assert (await manager.get_job(job_id)).state is JobState(final)
            assert receiver.states(job_id) == ["queued", "running", final]

    _, logs = run_logged(scenario())
    # 기록 실패가 끝내 로그가 되지는 않는다
    assert [e for e in logs if e.get("event") == "service.job_error"] == []


@pytest.mark.req("REQ-RAG-10.8.7.4")
@pytest.mark.req("REQ-RAG-10.8.5.2")
def test_dispatch_failure_keeps_queued(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.8.7.4] 배정 쓰기가 실패해도 접수는 정상이고 QUEUED로 남아 나중에 배정된다."""
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            first = ScriptedRunner()
            # ★ 접수 트랜잭션은 통과하고 그다음 쓰기 트랜잭션(배정) 하나가 실패한다
            failure.arm_transactions(skip=1, limit=1)
            with capture_logs() as logs:
                first_id = await submit(manager, "doc-a", first)  # 예외 없이 작업 ID를 돌려준다
                await settle()
            failure.disarm()
            assert failure.failures == 1

            assert (await manager.get_job(first_id)).state is JobState.QUEUED
            assert first.calls == 0
            assert receiver.states(first_id) == ["queued"]  # running 알림이 없다
            assert receiver.sequences("doc-a") == [1]  # 순번이 소비되지 않았다
            entries = assert_service_log(
                list(logs), "service.job_error", "error", _JOB_ERROR_FIELDS, stack=True
            )
            assert [e["step"] for e in entries] == ["dispatch"]
            assert entries[0]["job_id"] == first_id

            # 다른 접수가 배정 계기가 되어 먼저 접수된 작업부터 실행된다
            second = ScriptedRunner()
            second_id = await submit(manager, "doc-b", second)
            await wait_state(manager, first_id, JobState.SUCCEEDED)
            await wait_state(manager, second_id, JobState.SUCCEEDED)
            assert (first.calls, second.calls) == (1, 1)
            assert receiver.states(first_id) == ["queued", "running", "succeeded"]
            assert receiver.sequences("doc-a") == [1, 2, 3]

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.2")
def test_dispatch_failure_resolved_on_restart(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.8.5.2] 배정 실패로 QUEUED인 작업은 재시작에서 SERVER_RESTARTED로 끝맺는다."""
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        first = await new_manager(settings)
        runner = ScriptedRunner()
        try:
            failure.arm_transactions(skip=1, limit=1)
            job_id = await submit(first, "doc-a", runner)
            await settle()
            failure.disarm()
            assert (await first.get_job(job_id)).state is JobState.QUEUED
        finally:
            await first.stop(0)

        spy = RecoverSpy(False)
        second = await new_manager(settings, spy)
        try:
            assert _failed_code(await second.get_job(job_id)) == "SERVER_RESTARTED"
            await notified(receiver, job_id, "failed")
            assert receiver.states(job_id) == ["queued", "failed"]
            assert spy.calls == []  # 색인 중이 아니었으니 recover 대상이 아니다
            assert runner.calls == 0
        finally:
            await second.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
def test_restart_after_recover_error(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.3] recover 예외로 start가 실패해도 다음 start가 같은 작업을 다시 확인한다."""

    async def scenario() -> None:
        # 색인 중이던 작업 R(doc-a)과 대기 작업 Q(doc-b)를 남긴다
        seed = await new_manager(settings)
        try:
            running = ScriptedRunner(IndexOutcome(3, True), WAIT)
            r_id = await submit(seed, "doc-a", running, version="v1")
            await wait_event(running.waiting)
            await notified(receiver, r_id, "running")
        finally:
            await seed.stop(0)

        manager = JobManager(settings)
        error = StoreUnavailableError()
        failing = RecoverSpy(error)
        with pytest.raises(StoreUnavailableError) as caught:
            await manager.start(failing)
        assert caught.value is error
        assert failing.calls == [("doc-a", r_id)]

        # 같은 인스턴스로 다시 시작한다 — 작업이 바뀌지 않았으니 같은 작업을 다시 확인한다
        retry = RecoverSpy(True)
        await manager.start(retry)
        try:
            assert retry.calls == [("doc-a", r_id)]
            view = await manager.get_job(r_id)
            assert view.state is JobState.SUCCEEDED
            assert view.result == IndexOutcome(3, True)
            await notified(receiver, r_id, "succeeded")
            # 다시 시작한 관리자는 정상으로 접수·실행한다
            new_id = await submit(manager, "doc-c", ScriptedRunner())
            await wait_state(manager, new_id, JobState.SUCCEEDED)
        finally:
            await manager.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.3")
@pytest.mark.req("REQ-RAG-10.1.1")
def test_restart_after_sqlite_start_error(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.1.1] DB를 여는 중 SQLite 오류로 start가 실패해도 다시 start할 수 있다."""
    real_connect = sqlite3.connect

    def broken_connect(*_args: Any, **_kwargs: Any) -> Any:
        raise sqlite3.OperationalError("injected")

    async def scenario() -> None:
        manager = JobManager(settings)
        monkeypatch.setattr(sqlite3, "connect", broken_connect)
        spy = RecoverSpy(False)
        with pytest.raises(sqlite3.OperationalError):
            await manager.start(spy)
        assert spy.calls == []

        monkeypatch.setattr(sqlite3, "connect", real_connect)
        await manager.start(spy)  # 같은 인스턴스, 정상 상태
        try:
            runner = ScriptedRunner()
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            assert runner.calls == 1
            await notified(receiver, job_id, "succeeded")
        finally:
            await manager.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.7.1")
@pytest.mark.req("REQ-RAG-10.8.1")
@pytest.mark.parametrize("skip", [0, 1], ids=["during_accept_write", "during_dispatch_write"])
def test_caller_cancel_during_submit(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver, skip: int
) -> None:
    """[REQ-RAG-10.8.1] submit 호출자가 접수 도중 취소돼도 DB·알림·실행이 서로 어긋나지 않는다.

    ★ 접수(skip=0) 또는 배정(skip=1) 쓰기를 작업 스레드에서 멈춘 채 호출자를 취소한다. 쓰기는
    이미 시작됐으니 접수된 것이고, 그렇다면 작업은 queued·running·succeeded 알림을 순번대로
    내며 실행되고 열린 작업이 남지 않는다.
    """
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner()
            pause = failure.pause_transaction(skip=skip)
            caller = asyncio.create_task(submit(manager, "doc-a", runner, version="v1"))
            try:
                await until(pause.entered.is_set)  # 쓰기가 멈춘 채 호출자는 접수를 기다린다
                caller.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await caller
            finally:
                pause.release.set()

            # 호출자가 취소됐어도 접수된 작업은 끝까지 실행된다
            await receiver.wait_for(
                1, lambda r: r.body["doc_id"] == "doc-a" and r.body["job_state"] == "succeeded"
            )
            firsts = receiver.firsts(doc_id="doc-a")
            job_id = firsts[0]["job_id"]
            assert [b["job_state"] for b in firsts] == ["queued", "running", "succeeded"]
            assert {b["job_id"] for b in firsts} == {job_id}
            assert receiver.sequences("doc-a") == [1, 2, 3]
            assert runner.calls == 1

            # DB도 알림과 같은 결과다 — 열린 작업이 남지 않는다
            assert (await manager.get_job(job_id)).state is JobState.SUCCEEDED
            assert await manager.find_open("doc-a", "sum-doc-a-v1") is None
            state = await manager.index_state("doc-a")
            assert state.searchable_version == "v1"
            assert state.latest_job_id == job_id
            assert state.latest_job_state is JobState.SUCCEEDED

    go(scenario())
