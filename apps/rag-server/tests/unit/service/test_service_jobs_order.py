"""처리 순서와 실패·재색인(REQ-RAG-10.8.3, REQ-RAG-10.8.4) 테스트."""

from collections.abc import Callable

import pytest

from minerva_rag.core import Settings
from minerva_rag.service import JobState
from minerva_rag.service.jobs import JobFailure

from .fakes import (
    WAIT,
    FakeReceiver,
    ScriptedRunner,
    go,
    notified,
    running_manager,
    settle,
    submit,
    wait_event,
    wait_state,
)


@pytest.mark.req("REQ-RAG-10.8.3.1")
def test_concurrency_limit(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.3.1] 상한이 2이면 RUNNING은 둘이고 하나가 끝나면 셋째가 시작한다."""

    async def scenario() -> None:
        async with running_manager(make_settings(concurrency=2)) as manager:
            a, b, c = ScriptedRunner(WAIT), ScriptedRunner(WAIT), ScriptedRunner(WAIT)
            ids = [
                await submit(manager, "doc-a", a),
                await submit(manager, "doc-b", b),
                await submit(manager, "doc-c", c),
            ]
            await wait_event(a.waiting)
            await wait_event(b.waiting)
            await settle()

            states = [(await manager.get_job(job_id)).state for job_id in ids]
            assert states.count(JobState.RUNNING) == 2
            assert states[2] is JobState.QUEUED
            assert c.calls == 0

            a.release.set()
            await wait_event(c.waiting)
            assert (await manager.get_job(ids[2])).state is JobState.RUNNING

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.3.2")
def test_accepted_order(settings: Settings) -> None:
    """[REQ-RAG-10.8.3.2] 상한 1에서 A·B·C를 차례로 접수하면 A·B·C 순으로 실행된다."""

    async def scenario() -> None:
        trace: list[str] = []
        async with running_manager(settings) as manager:
            runners = {
                name: ScriptedRunner(WAIT, name=name, trace=trace) for name in ("a", "b", "c")
            }
            ids = {name: await submit(manager, f"doc-{name}", r) for name, r in runners.items()}

            await wait_event(runners["a"].waiting)
            assert (await manager.get_job(ids["b"])).state is JobState.QUEUED
            assert (await manager.get_job(ids["c"])).state is JobState.QUEUED

            runners["a"].release.set()
            await wait_event(runners["b"].waiting)
            assert (await manager.get_job(ids["c"])).state is JobState.QUEUED

            runners["b"].release.set()
            await wait_event(runners["c"].waiting)
            assert trace == ["a", "b", "c"]

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.3.3")
def test_same_doc_sequential(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.3.3] 같은 문서의 다음 작업은 여유가 있어도 앞 작업이 끝난 뒤 시작한다."""

    async def scenario() -> None:
        async with running_manager(make_settings(concurrency=2)) as manager:
            first = ScriptedRunner(WAIT)
            second = ScriptedRunner(WAIT)
            await submit(manager, "doc-a", first)
            await wait_event(first.waiting)
            second_id = await submit(manager, "doc-a", second, version="v2")
            await settle()

            assert (await manager.get_job(second_id)).state is JobState.QUEUED
            assert second.calls == 0

            first.release.set()
            await wait_event(second.waiting)
            assert (await manager.get_job(second_id)).state is JobState.RUNNING

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.3.4")
def test_queued_superseded(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.3.4] 새 submit이 같은 문서의 QUEUED를 대체하고 RUNNING은 건드리지 않는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            a1, a2, a3 = ScriptedRunner(WAIT), ScriptedRunner(), ScriptedRunner()
            a1_id = await submit(manager, "doc-a", a1, version="v1")
            await wait_event(a1.waiting)
            a2_id = await submit(manager, "doc-a", a2, version="v2")
            a3_id = await submit(manager, "doc-a", a3, version="v3")

            assert (await manager.get_job(a2_id)).state is JobState.SUPERSEDED
            assert (await manager.get_job(a1_id)).state is JobState.RUNNING
            assert (await manager.get_job(a3_id)).state is JobState.QUEUED

            a1.release.set()
            await wait_state(manager, a3_id, JobState.SUCCEEDED)
            assert a2.calls == 0
            await notified(receiver, a2_id, "superseded")
            assert receiver.states(a2_id) == ["queued", "superseded"]

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.4.1")
def test_failed_not_retried(settings: Settings) -> None:
    """[REQ-RAG-10.8.4.1] 실패한 러너는 같은 문서의 새 작업을 돌려도 다시 불리지 않는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            failing = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            failed_id = await submit(manager, "doc-a", failing, version="v1")
            await wait_state(manager, failed_id, JobState.FAILED)

            new_id = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            await wait_state(manager, new_id, JobState.SUCCEEDED)
            await settle()

            assert failing.calls == 1

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.4.2")
def test_failed_stays_failed(settings: Settings) -> None:
    """[REQ-RAG-10.8.4.2] 실패한 작업은 같은 문서의 새 접수 전후로 FAILED 그대로다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            failing = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            failed_id = await submit(manager, "doc-a", failing, version="v1")
            await wait_state(manager, failed_id, JobState.FAILED)
            before = await manager.get_job(failed_id)

            new_id = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            assert (await manager.get_job(failed_id)).state is JobState.FAILED
            await wait_state(manager, new_id, JobState.SUCCEEDED)

            assert await manager.get_job(failed_id) == before

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.4.3")
def test_same_checksum_new_job(settings: Settings) -> None:
    """[REQ-RAG-10.8.4.3] 실패한 작업은 열린 작업이 아니라서 같은 체크섬으로 새 작업을 만든다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            failing = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            failed_id = await submit(manager, "doc-a", failing, checksum="c1")
            await wait_state(manager, failed_id, JobState.FAILED)

            assert await manager.find_open("doc-a", "c1") is None
            new_id = await submit(manager, "doc-a", ScriptedRunner(), checksum="c1")
            assert new_id != failed_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.4.3")
def test_find_open_queued_running(settings: Settings) -> None:
    """[REQ-RAG-10.8.4.3] find_open은 QUEUED·RUNNING 작업을 문서·체크섬이 같을 때만 찾는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            running = ScriptedRunner(WAIT)
            running_id = await submit(manager, "doc-a", running, version="v1", checksum="c1")
            await wait_event(running.waiting)
            queued_id = await submit(manager, "doc-b", ScriptedRunner(), checksum="d1")

            assert await manager.find_open("doc-a", "c1") == running_id
            assert await manager.find_open("doc-a", "d1") is None
            assert await manager.find_open("doc-b", "d1") == queued_id
            assert await manager.find_open("doc-b", "c1") is None

    go(scenario())
