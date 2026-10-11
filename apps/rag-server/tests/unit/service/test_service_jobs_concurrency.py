"""일괄 색인의 동시성·견고성(교착·경쟁 회귀 방지) 테스트.

모든 테스트는 `go()`의 상한 안에서 끝나야 한다. 교착이 생기면 TimeoutError로 실패한다.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import cast

import pytest

from minerva_rag.core import BatchIndexingError, Settings
from minerva_rag.indexing import Indexer
from minerva_rag.resource import ModelHub
from minerva_rag.service import CaptionService, DeleteService, JobStage, JobState
from minerva_rag.service.captioner import Captioner
from minerva_rag.service.jobs import EmbedRunner, IndexOutcome, JobManager, ProgressReporter

from .fakes import (
    WAIT,
    WAIT_LIMIT,
    FakeHub,
    FakeIndexer,
    IdleClock,
    ReadyStub,
    RecoverSpy,
    ScriptedRunner,
    SwitchOnlyHub,
    Timeline,
    finish_batch,
    go,
    install_write_failure,
    manager_with_hub,
    new_manager,
    run_logged,
    running_manager,
    settle,
    started_spy,
    submit,
    until,
    wait_event,
    wait_stage,
    wait_state,
)

_TABLE = "| 항목 | 값 |\n| --- | --- |\n| 갱신 | 30일 전 |"


def _caption_service(manager: JobManager, hub: FakeHub) -> CaptionService:
    """진짜 작업 관리자와 가짜 허브로 요약·캡션 서비스를 만든다."""
    return CaptionService(Captioner(cast(ModelHub, hub)), manager, ReadyStub(True))


def _names(timeline: Timeline) -> list[str]:
    """timeline의 항목 이름만 순서대로 돌려준다."""
    return [str(entry[0]) for entry in timeline]


@pytest.mark.req("REQ-RAG-10.2.4.1")
def test_caption_cancel_while_waiting(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.2.4.1] 임베딩 단계에서 기다리던 캡션 요청을 취소해도 일괄 색인이 정상으로
    끝난다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            a = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            a_id = await submit(manager, "doc-a", a)
            await wait_event(a.embed_waiting)  # 임베딩 단계 중이다

            caption = asyncio.create_task(_caption_service(manager, hub).summarize_table(_TABLE))
            await settle()
            assert not caption.done()
            caption.cancel()
            with pytest.raises(asyncio.CancelledError):
                await caption

            a.release.set()
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            await finish_batch(idle_clock, timeline)  # 남은 캡션 수 때문에 막히지 않는다
            await manager.reject_during_batch()
            assert "generate" not in _names(timeline)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_activity_during_batch_end(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.6] 끝내는 도중 접수가 오면 끝내는 동안 거부하고, 끝낸 뒤 새 일괄 색인으로
    이어 간다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        gate = asyncio.Event()
        async with running_manager(settings, hub=hub) as manager:
            a_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            hub.blocks["load_local"] = gate  # 끝내기를 멈춘다
            await until(lambda: idle_clock.pending == 1)
            idle_clock.tick()
            await until(lambda: ("load_local",) in timeline)

            b = ScriptedRunner(name="b", timeline=timeline)
            b_id = await asyncio.wait_for(submit(manager, "doc-b", b), WAIT_LIMIT)
            with pytest.raises(BatchIndexingError):
                await manager.reject_during_batch()  # 끝내는 동안에도 거부한다
            assert b.calls == 0

            gate.set()
            await wait_state(manager, b_id, JobState.SUCCEEDED)
        return timeline

    timeline, logs = run_logged(scenario())

    events = [str(entry["event"]) for entry in logs]
    ended_at = events.index("service.batch_ended")
    restarted = [
        i
        for i, entry in enumerate(logs)
        if entry["event"] == "service.batch_started" and i > ended_at
    ]
    assert restarted
    assert logs[restarted[0]]["trigger"] == "job"
    # 새 일괄 색인은 로컬 모델을 먼저 내린 뒤 분할한다
    tail = timeline[timeline.index(("load_local", "end")) :]
    assert tail.index(("release_local", "end")) < tail.index(("index_runner", "b"))


@pytest.mark.req("REQ-RAG-10.5.2")
def test_delete_during_pending(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.5.2] PENDING인 문서를 삭제하면 그 작업의 임베딩·완료 뒤에 청크를 지운다(교착
    없음)."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        spy = await started_spy(make_settings(concurrency=2), timeline)
        service = DeleteService(cast(Indexer, FakeIndexer(timeline)), spy, ReadyStub(True))
        try:
            b = ScriptedRunner(WAIT, name="b", timeline=timeline)
            a = ScriptedRunner(name="a", timeline=timeline)
            await submit(spy, "doc-b", b)
            await wait_event(b.waiting)
            a_id = await submit(spy, "doc-a", a)
            await wait_stage(spy, a_id, JobStage.EMBEDDING_PENDING)  # A는 분할을 마치고 PENDING이다

            task = asyncio.create_task(service.delete("doc-a"))
            await wait_event(spy.entered_wait)
            await settle()
            assert not task.done()  # A가 임베딩·완료될 때까지 기다린다
            assert "delete_document" not in _names(timeline)

            b.release.set()
            await asyncio.wait_for(task, WAIT_LIMIT)
            assert (await spy.get_job(a_id)).state is JobState.SUCCEEDED
        finally:
            await spy.stop(0)
        return timeline

    timeline = go(scenario())

    names = _names(timeline)
    assert timeline.index(("embed_runner_end", "a")) < names.index("delete_document")
    assert names.index("delete_document") < names.index("forget_document")


@pytest.mark.req("REQ-RAG-10.5.1")
def test_fail_queued_during_embedding(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.5.1] 임베딩 단계 중 QUEUED 작업을 실패시키면 그 러너는 불리지 않고 일괄
    색인이 끝난다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            a = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            b = ScriptedRunner()
            a_id = await submit(manager, "doc-a", a)
            await wait_event(a.embed_waiting)
            b_id = await submit(manager, "doc-b", b)  # 임베딩 단계 중이라 QUEUED다
            await manager.fail_queued("doc-b", "DOCUMENT_DELETED", "삭제 요청")

            a.release.set()
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            await finish_batch(idle_clock, timeline)

            assert b.calls == 0
            view = await manager.get_job(b_id)
            assert view.state is JobState.FAILED
            assert view.failure is not None
            assert view.failure.code == "DOCUMENT_DELETED"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_caption_during_batch_end_swap(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.6] 끝내는 도중 캡션 요청이 와도 새 일괄 색인(trigger=caption)으로 이어서
    처리한다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        gate = asyncio.Event()
        async with running_manager(settings, hub=hub) as manager:
            a_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            hub.blocks["load_local"] = gate
            await until(lambda: idle_clock.pending == 1)
            idle_clock.tick()
            await until(lambda: ("load_local",) in timeline)

            caption = asyncio.create_task(_caption_service(manager, hub).summarize_table(_TABLE))
            await settle()
            assert not caption.done()  # 끝내는 동안은 시작하지 않는다
            gate.set()
            assert await asyncio.wait_for(caption, WAIT_LIMIT) == "생성된 문장"

    _, logs = run_logged(scenario())

    triggers = [str(e["trigger"]) for e in logs if e["event"] == "service.batch_started"]
    assert triggers == ["job", "caption"]


@pytest.mark.req("REQ-RAG-10.8.2.4")
def test_record_failure_does_not_block_batch(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, idle_clock: IdleClock
) -> None:
    """[REQ-RAG-10.8.2.4] 결과 기록이 모두 실패해도 작업이 메모리에서 빠져 일괄 색인이
    끝난다(DB는 RUNNING)."""
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            runner = ScriptedRunner(WAIT)
            job_id = await submit(manager, "doc-a", runner)
            await wait_event(runner.waiting)
            # EMBEDDING_PENDING 단계 저장(쓰기 트랜잭션 1)은 통과시키고 이후 쓰기를 모두 실패시킨다
            failure.arm_transactions(skip=1, limit=None)
            runner.release.set()

            await until(lambda: idle_clock.pending == 1)  # 메모리에서 빠져 유휴 타이머가 걸린다
            failure.disarm()
            await finish_batch(idle_clock, timeline)
            assert (await manager.get_job(job_id)).state is JobState.RUNNING

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_scheduler_survives_errors(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.4] 모델 교체가 모두 실패해도 일괄 색인이 두 번 끝까지 간다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        for name in ("release_ollama", "release_local", "load_local"):
            hub.errors[name] = RuntimeError("실패")
        async with running_manager(settings, hub=hub) as manager:
            for doc_id in ("doc-a", "doc-b"):
                job_id = await submit(manager, doc_id, ScriptedRunner())
                await wait_state(manager, job_id, JobState.SUCCEEDED)
                await finish_batch(idle_clock, timeline)
                await manager.reject_during_batch()

    _, logs = run_logged(scenario())

    assert len([e for e in logs if e["event"] == "service.batch_ended"]) == 2
    assert not [e for e in logs if e["event"] == "service.job_error"]


@pytest.mark.req("REQ-RAG-10.1.3")
def test_stop_during_model_switch(settings: Settings) -> None:
    """[REQ-RAG-10.1.3] 임베딩 단계 시작의 모델 내리기가 멈춰 있어도 stop은 상한 안에 끝나고
    PENDING 작업은 RUNNING으로 남는다."""

    async def scenario() -> None:
        hub = FakeHub()
        hub.blocks["release_ollama"] = asyncio.Event()
        manager = await new_manager(settings, hub=hub)
        a_id = await submit(manager, "doc-a", ScriptedRunner())
        await until(lambda: ("release_ollama",) in hub.timeline)

        await asyncio.wait_for(manager.stop(0), WAIT_LIMIT)

        spy = RecoverSpy(False)
        async with running_manager(settings, spy) as second:
            assert spy.calls == [("doc-a", a_id)]
            view = await second.get_job(a_id)
            assert view.failure is not None
            assert view.failure.code == "SERVER_RESTARTED"

    go(scenario())


@dataclass
class _Tracker:
    """러너·캡션의 시작과 끝을 순서대로 모아 겹침을 센다."""

    log: list[tuple[str, str]] = field(default_factory=list[tuple[str, str]])

    def mark(self, event: str, name: str) -> None:
        """사건 하나를 기록한다."""
        self.log.append((event, name))


class _TrackedRunner:
    """분할·임베딩이 몇 번 양보하는 동안 걸리는 러너다. 시작·끝을 tracker에 남긴다."""

    def __init__(self, name: str, tracker: _Tracker) -> None:
        self.name = name
        self.tracker = tracker

    async def __call__(self, reporter: ProgressReporter) -> EmbedRunner:
        """분할을 흉내 내고 EmbedRunner를 돌려준다."""
        self.tracker.mark("index+", self.name)
        await settle(5)
        self.tracker.mark("index-", self.name)
        return self._embed

    async def _embed(self, reporter: ProgressReporter) -> IndexOutcome:
        """임베딩을 흉내 낸다."""
        self.tracker.mark("embed+", self.name)
        await settle(5)
        self.tracker.mark("embed-", self.name)
        return IndexOutcome(1, False)


@pytest.mark.req("REQ-RAG-10.8.3.1")
def test_many_jobs_mixed(make_settings: Callable[..., Settings], idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.3.1] 여러 문서·같은 문서 두 버전·캡션 요청을 섞어도 상한을 지키고 겹치지
    않으며 끝난다."""
    cfg = make_settings(concurrency=2)

    async def scenario() -> tuple[_Tracker, list[str]]:
        tracker = _Tracker()
        timeline: Timeline = []
        hub = FakeHub(timeline)
        job_ids: list[str] = []

        async def caption(i: int) -> None:
            async with manager.caption_slot():
                tracker.mark("cap+", f"c{i}")
                await settle(5)
                tracker.mark("cap-", f"c{i}")

        async with running_manager(cfg, hub=hub) as manager:
            tasks: list[asyncio.Task[None]] = []
            plan = [
                ("doc-a", "v1"),
                ("doc-b", "v1"),
                ("doc-a", "v2"),
                ("doc-c", "v1"),
                ("doc-d", "v1"),
                ("doc-e", "v1"),
            ]
            for i, (doc_id, version) in enumerate(plan):
                runner = _TrackedRunner(f"{doc_id}-{version}", tracker)
                job_ids.append(await submit(manager, doc_id, runner, version=version))
                if i in (1, 3):
                    tasks.append(asyncio.create_task(caption(i)))
            await asyncio.wait_for(asyncio.gather(*tasks), WAIT_LIMIT)
            for job_id in job_ids:
                await wait_state_in_end(manager, job_id)
            await finish_batch(idle_clock, timeline)
            await manager.reject_during_batch()
            states = [(await manager.get_job(job_id)).state.value for job_id in job_ids]
        return tracker, states

    tracker, states = go(scenario())

    assert set(states) <= {"succeeded", "superseded"}
    index_running = embed_running = cap_running = 0
    peak_index = peak_embed = 0
    for event, _name in tracker.log:
        if event == "index+":
            index_running += 1
        elif event == "index-":
            index_running -= 1
        elif event == "embed+":
            embed_running += 1
        elif event == "embed-":
            embed_running -= 1
        elif event == "cap+":
            cap_running += 1
        elif event == "cap-":
            cap_running -= 1
        peak_index = max(peak_index, index_running)
        peak_embed = max(peak_embed, embed_running)
        assert index_running <= 2
        assert embed_running <= 2
        # 임베딩 중에는 분할·캡션이 겹치지 않는다
        if embed_running:
            assert index_running == 0
            assert cap_running == 0
    # 겹침 단언이 공허하지 않게 분할·임베딩 구간이 실제로 있었는지 본다.
    # ★ 상한(2)에 도달했는지는 도착 시각에 달려 있어 여기서 고정하지 않는다 — 상한 도달은
    # test_concurrency_limit·test_embed_runner_limit이 결정적으로 본다
    assert peak_index >= 1
    assert peak_embed >= 1


async def wait_state_in_end(manager: JobManager, job_id: str) -> None:
    """작업이 SUCCEEDED 또는 SUPERSEDED가 될 때까지 폴링한다."""

    async def _poll() -> None:
        while (await manager.get_job(job_id)).state not in (
            JobState.SUCCEEDED,
            JobState.SUPERSEDED,
        ):
            await asyncio.sleep(0)

    await asyncio.wait_for(_poll(), WAIT_LIMIT)


@pytest.mark.req("REQ-RAG-10.8.8")
def test_jobs_use_only_model_switch(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8] 작업 큐는 resource에서 모델 내리기·올리기 세 메서드만 쓴다(다른 속성에
    접근하면 hub.violations에 남는다)."""

    async def scenario() -> SwitchOnlyHub:
        timeline: Timeline = []
        hub = SwitchOnlyHub(timeline)
        generated = FakeHub(timeline)  # 캡션 생성용 — 작업 큐 밖의 허브다
        async with manager_with_hub(settings, timeline=timeline, hub=hub) as (manager, used):
            assert used is hub
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            service = _caption_service(manager, generated)
            assert await service.summarize_table(_TABLE) == "생성된 문장"
            await finish_batch(idle_clock, timeline)
            await manager.reject_during_batch()
        return hub

    hub, logs = run_logged(scenario())

    # ★ 삼켜질 수 있는 AssertionError 대신 접근 기록을 본다
    assert hub.violations == []
    assert not [
        e for e in logs if e["event"] in ("service.job_error", "service.batch_model_failed")
    ]
