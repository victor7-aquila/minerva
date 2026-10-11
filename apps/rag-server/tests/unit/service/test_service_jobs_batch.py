"""일괄 색인과 임베딩 단계(REQ-RAG-10.8.8, REQ-RAG-10.8.3, REQ-RAG-10.8.2.3 등) 테스트.

시간은 쓰지 않는다. 일괄 색인 끝 타이머는 `IdleClock`(autouse 픽스처 `idle_clock`)이 대신하고,
모델 내리기·올리기와 러너 호출의 순서는 같은 timeline에 기록해 본다.
"""

import asyncio
import sqlite3
from collections.abc import Callable
from typing import cast

import pytest

from minerva_rag.core import BatchIndexingError, InvalidRequestError, Settings
from minerva_rag.evaluation import Evaluator
from minerva_rag.resource import ModelHub
from minerva_rag.search import Searcher, SearchQuery
from minerva_rag.service import (
    CaptionService,
    EvaluationService,
    JobStage,
    JobState,
    SearchService,
)
from minerva_rag.service import jobs as jobs_module
from minerva_rag.service.captioner import Captioner
from minerva_rag.service.jobs import JobFailure, JobManager

from .fakes import (
    REAL_IDLE_WAIT,
    WAIT,
    WAIT_LIMIT,
    CaptionHolder,
    FakeEvaluator,
    FakeHub,
    FakeReceiver,
    FakeSearcher,
    IdleClock,
    ReadyStub,
    RecoverSpy,
    ScriptedRunner,
    Timeline,
    assert_service_log,
    eval_case,
    finish_batch,
    go,
    hold_caption,
    make_manager,
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

_TABLE = "| 항목 | 값 |\n| --- | --- |\n| 갱신 | 30일 전 |"


# ── 도우미 ────────────────────────────────────────────────────────


def _names(timeline: Timeline) -> list[str]:
    """timeline의 항목 이름만 순서대로 돌려준다."""
    return [str(entry[0]) for entry in timeline]


def _db_stage(settings: Settings, job_id: str) -> str | None:
    """작업 DB에 저장된 단계를 읽기만 한다."""
    conn = sqlite3.connect(settings.jobs_db_path)
    try:
        row = conn.execute("SELECT stage FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    finally:
        conn.close()
    return None if row is None else cast("str | None", row[0])


async def _wait_stage(manager: JobManager, job_id: str, stage: JobStage) -> None:
    """작업의 단계가 그 값이 될 때까지 폴링한다."""

    async def _poll() -> None:
        while (await manager.get_job(job_id)).stage is not stage:
            await asyncio.sleep(0)

    await asyncio.wait_for(_poll(), WAIT_LIMIT)


def _caption_service(manager: JobManager, hub: FakeHub) -> CaptionService:
    """진짜 작업 관리자와 가짜 허브로 요약·캡션 서비스를 만든다."""
    return CaptionService(Captioner(cast(ModelHub, hub)), manager, ReadyStub(True))


def _search_service(manager: JobManager, searcher: FakeSearcher) -> SearchService:
    """진짜 작업 관리자와 가짜 Searcher로 검색 서비스를 만든다."""
    return SearchService(cast(Searcher, searcher), manager, ReadyStub(True))


# ── 작업 단계: EMBEDDING_PENDING ──────────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.2.3")
def test_embedding_pending_stage(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.2.3] 분할을 마치고 임베딩을 기다리는 동안 단계는 EMBEDDING_PENDING이다."""
    cfg = make_settings(concurrency=2)

    async def scenario() -> None:
        async with running_manager(cfg) as manager:
            # B가 분할 중이라 A가 분할을 마쳐도 임베딩 단계는 시작하지 않는다
            b = ScriptedRunner(WAIT)
            a = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            await submit(manager, "doc-b", b)
            await wait_event(b.waiting)
            a_id = await submit(manager, "doc-a", a)
            await _wait_stage(manager, a_id, JobStage.EMBEDDING_PENDING)

            view = await manager.get_job(a_id)
            assert view.state is JobState.RUNNING
            assert (await manager.index_state("doc-a")).latest_job_stage is (
                JobStage.EMBEDDING_PENDING
            )
            await until(lambda: _db_stage(cfg, a_id) == "embedding_pending")  # SQLite에도 저장된다

            # B가 끝나면 임베딩 단계가 시작되고 A가 EMBEDDING을 알린다
            b.release.set()
            await wait_event(a.embed_waiting)
            assert (await manager.get_job(a_id)).stage is JobStage.EMBEDDING

            a.release.set()
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            assert (await manager.get_job(a_id)).stage is None

    go(scenario())


# ── 동시 처리 상한과 순서 ─────────────────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.3.1")
def test_index_runner_limit(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.3.1] 분할 상한이 2이면 IndexRunner는 동시에 둘만 실행된다."""

    async def scenario() -> None:
        async with running_manager(make_settings(concurrency=2)) as manager:
            runners = [ScriptedRunner(WAIT) for _ in range(3)]
            for i, runner in enumerate(runners):
                await submit(manager, f"doc-{i}", runner)
            await wait_event(runners[0].waiting)
            await wait_event(runners[1].waiting)
            await settle()

            assert [r.calls for r in runners] == [1, 1, 0]

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.3.1")
def test_embed_runner_limit(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.3.1] 임베딩·저장 상한이 2이면 EmbedRunner는 동시에 둘만 실행된다."""

    async def scenario() -> None:
        async with running_manager(make_settings(concurrency=2)) as manager:
            # 캡션 요청을 슬롯 안에 붙들어 세 작업이 모두 분할을 마칠 때까지 임베딩 단계를 막는다
            holder = await hold_caption(manager)
            runners = [ScriptedRunner(JobStage.EMBEDDING, WAIT) for _ in range(3)]
            for i, runner in enumerate(runners):
                job_id = await submit(manager, f"doc-{i}", runner)
                await _wait_stage(manager, job_id, JobStage.EMBEDDING_PENDING)
            await holder.release()
            await wait_event(runners[0].embed_started)
            await wait_event(runners[1].embed_started)
            await settle()
            assert [r.embed_calls for r in runners] == [1, 1, 0]

            runners[0].release.set()  # 하나가 끝나면 셋째가 시작한다
            await wait_event(runners[2].embed_started)
            for runner in runners:
                runner.release.set()

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.3.1")
def test_pending_not_counted(settings: Settings) -> None:
    """[REQ-RAG-10.8.3.1] EMBEDDING_PENDING 작업은 분할 상한에 세지 않는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:  # 분할 상한 1
            a = ScriptedRunner(WAIT)
            b = ScriptedRunner(WAIT)
            a_id = await submit(manager, "doc-a", a)
            await submit(manager, "doc-b", b)
            await wait_event(a.waiting)
            # A는 분할을 끝내 PENDING이다. 그래도 B의 IndexRunner가 불린다
            a.release.set()
            await wait_event(b.waiting)
            assert (await manager.get_job(a_id)).stage is JobStage.EMBEDDING_PENDING
            assert a.embed_calls == 0

            b.release.set()
            await wait_state(manager, a_id, JobState.SUCCEEDED)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.3.2")
def test_embed_order(settings: Settings) -> None:
    """[REQ-RAG-10.8.3.2] 분할이 모두 끝난 뒤 EmbedRunner가 접수 순서로 불린다."""

    async def scenario() -> list[str]:
        trace: list[str] = []
        async with running_manager(settings) as manager:  # 상한 1
            runners = {
                "a": ScriptedRunner(WAIT, name="a", trace=trace),
                "b": ScriptedRunner(name="b", trace=trace),
                "c": ScriptedRunner(name="c", trace=trace),
            }
            ids = {name: await submit(manager, f"doc-{name}", r) for name, r in runners.items()}
            await wait_event(runners["a"].waiting)
            runners["a"].release.set()
            for job_id in ids.values():
                await wait_state(manager, job_id, JobState.SUCCEEDED)
        return trace

    trace = go(scenario())

    assert [t for t in trace if not t.endswith(":embed")] == ["a", "b", "c"]
    assert [t for t in trace if t.endswith(":embed")] == ["a:embed", "b:embed", "c:embed"]
    assert trace.index("c") < trace.index("a:embed")  # 분할이 다 끝난 뒤에 임베딩한다


@pytest.mark.req("REQ-RAG-10.8.3.3")
def test_same_doc_waits_pending(
    make_settings: Callable[..., Settings],
) -> None:
    """[REQ-RAG-10.8.3.3] 앞 작업이 EMBEDDING_PENDING이면 같은 문서의 다음 작업은 QUEUED로
    기다린다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        hub.blocks["release_ollama"] = asyncio.Event()  # 임베딩 단계 시작을 막아 PENDING을 붙든다
        async with running_manager(make_settings(concurrency=2), hub=hub) as manager:
            v1 = ScriptedRunner()
            v2 = ScriptedRunner(WAIT)
            v1_id = await submit(manager, "doc-a", v1)
            await until(lambda: ("release_ollama",) in timeline)
            assert (await manager.get_job(v1_id)).stage is JobStage.EMBEDDING_PENDING

            v2_id = await submit(manager, "doc-a", v2, version="v2")
            await settle()
            assert (await manager.get_job(v2_id)).state is JobState.QUEUED
            assert v2.calls == 0

            hub.blocks[
                "release_ollama"
            ].set()  # v1이 임베딩을 마치고 SUCCEEDED가 되면 v2가 시작한다
            await wait_state(manager, v1_id, JobState.SUCCEEDED)
            await wait_event(v2.waiting)
            assert (await manager.get_job(v2_id)).state is JobState.RUNNING

    go(scenario())


# ── 임베딩 단계 시작 조건 ─────────────────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.8.1")
def test_no_embed_while_other_chunking(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.8.1] 다른 문서가 분할 중이면 PENDING 작업도 임베딩하지 않는다."""

    async def scenario() -> None:
        async with running_manager(make_settings(concurrency=2)) as manager:
            b = ScriptedRunner(WAIT)
            a = ScriptedRunner()
            b_id = await submit(manager, "doc-b", b)
            await wait_event(b.waiting)
            a_id = await submit(manager, "doc-a", a)
            await _wait_stage(manager, a_id, JobStage.EMBEDDING_PENDING)
            await settle()
            assert a.embed_calls == 0

            b.release.set()  # B의 분할이 끝난 뒤에 둘 다 임베딩된다
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            await wait_state(manager, b_id, JobState.SUCCEEDED)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.1")
def test_no_embed_while_other_waiting(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.1] 분할을 기다리는 작업이 있으면 임베딩하지 않고, 분할이 다 끝난 뒤 접수
    순서로 임베딩한다."""

    async def scenario() -> list[str]:
        trace: list[str] = []
        async with running_manager(settings) as manager:  # 분할 상한 1
            a = ScriptedRunner(WAIT, name="a", trace=trace)
            c = ScriptedRunner(WAIT, name="c", trace=trace)
            b = ScriptedRunner(WAIT, name="b", trace=trace)
            ids = [
                await submit(manager, "doc-a", a),
                await submit(manager, "doc-c", c),
                await submit(manager, "doc-b", b),
            ]
            await wait_event(a.waiting)

            a.release.set()  # A는 PENDING이 되고 C가 분할한다. B는 분할을 기다린다
            await wait_event(c.waiting)
            await settle()
            assert a.embed_calls == 0

            c.release.set()  # C를 풀어도 B의 분할이 끝나기 전에는 임베딩하지 않는다
            await wait_event(b.waiting)
            await settle()
            assert (a.embed_calls, c.embed_calls) == (0, 0)

            b.release.set()
            for job_id in ids:
                await wait_state(manager, job_id, JobState.SUCCEEDED)
        return trace

    trace = go(scenario())

    assert [t for t in trace if t.endswith(":embed")] == ["a:embed", "c:embed", "b:embed"]


@pytest.mark.req("REQ-RAG-10.8.8.1")
def test_no_embed_while_caption_inside(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.1] caption_slot() 안에 요청이 있으면 PENDING 작업도 임베딩하지 않는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            holder = await hold_caption(manager)
            a = ScriptedRunner()
            a_id = await submit(manager, "doc-a", a)
            await _wait_stage(manager, a_id, JobStage.EMBEDDING_PENDING)
            await settle()
            assert a.embed_calls == 0

            await holder.release()  # 슬롯을 나오면 임베딩한다
            await wait_state(manager, a_id, JobState.SUCCEEDED)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.1")
def test_embed_when_only_same_doc_queued(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.8.8.1] 같은 문서의 다음 작업만 QUEUED로 남아 있으면 앞 작업은 임베딩된다(교착
    없음)."""

    async def scenario() -> None:
        async with running_manager(make_settings(concurrency=2)) as manager:
            v1 = ScriptedRunner(WAIT)
            v2 = ScriptedRunner()
            v1_id = await submit(manager, "doc-a", v1, version="v1")
            await wait_event(v1.waiting)
            v2_id = await submit(manager, "doc-a", v2, version="v2")

            v1.release.set()
            await wait_state(manager, v1_id, JobState.SUCCEEDED)
            await wait_state(manager, v2_id, JobState.SUCCEEDED)
            assert (v1.embed_calls, v2.calls) == (1, 1)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.2")
def test_all_pending_embedded(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.2] 단계가 시작되면 모든 EMBEDDING_PENDING 작업이 임베딩되고 종료 로그에
    작업 수가 남는다."""

    async def scenario() -> None:
        timeline: Timeline = []
        async with running_manager(settings, hub=FakeHub(timeline)) as manager:
            first = ScriptedRunner(WAIT)
            runners = [first, ScriptedRunner(), ScriptedRunner()]
            ids = [await submit(manager, f"doc-{i}", r) for i, r in enumerate(runners)]
            await wait_event(first.waiting)
            first.release.set()
            for job_id in ids:
                await wait_state(manager, job_id, JobState.SUCCEEDED)
            assert [r.embed_calls for r in runners] == [1, 1, 1]
            # 일괄 색인을 끝내면 임베딩 단계 종료 로그는 이미 남아 있다
            await finish_batch(idle_clock, timeline)

    _, logs = run_logged(scenario())

    ended = assert_service_log(
        logs, "service.batch_embedding_ended", "info", {"jobs", "elapsed_ms"}
    )
    assert [entry["jobs"] for entry in ended] == [3]


@pytest.mark.req("REQ-RAG-10.8.8.3")
def test_submit_during_embedding_waits(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.3] 임베딩 단계 중 접수한 작업은 QUEUED로 기다리고 단계가 끝나면 분할을
    시작한다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            a = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            b = ScriptedRunner()
            await submit(manager, "doc-a", a)
            await wait_event(a.embed_waiting)  # 임베딩 단계 중이다

            b_id = await submit(manager, "doc-b", b)
            await settle()
            assert (await manager.get_job(b_id)).state is JobState.QUEUED
            assert b.calls == 0

            a.release.set()
            await wait_state(manager, b_id, JobState.SUCCEEDED)
            assert b.calls == 1

    go(scenario())


# ── 모델 내리기·올리기 ────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_before_embed(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.4] 임베딩 단계마다 release_ollama_models가 끝난 뒤에 EmbedRunner를 부른다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        hub.blocks["release_ollama"] = asyncio.Event()
        async with running_manager(settings, hub=hub) as manager:
            a = ScriptedRunner(name="a", timeline=timeline)
            b = ScriptedRunner(name="b", timeline=timeline)
            a_id = await submit(manager, "doc-a", a)
            await until(lambda: ("release_ollama",) in timeline)
            await settle()
            assert a.embed_calls == 0  # 내리는 동안은 EmbedRunner를 부르지 않는다

            hub.blocks["release_ollama"].set()
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            b_id = await submit(manager, "doc-b", b)  # 두 번째 임베딩 단계
            await wait_state(manager, b_id, JobState.SUCCEEDED)
        return timeline

    timeline = go(scenario())

    ends = [i for i, entry in enumerate(timeline) if entry == ("release_ollama", "end")]
    assert len(ends) == 2
    assert ends[0] < timeline.index(("embed_runner", "a")) < ends[1]
    assert ends[1] < timeline.index(("embed_runner", "b"))


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_failure_continues(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.4] Ollama 모델 내리기가 실패해도 경고만 남기고 임베딩을 진행한다."""

    async def scenario() -> None:
        hub = FakeHub()
        hub.errors["release_ollama"] = RuntimeError("내리기 실패")
        async with running_manager(settings, hub=hub) as manager:
            runner = ScriptedRunner()
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            assert runner.embed_calls == 1

    _, logs = run_logged(scenario())

    failed = assert_service_log(
        logs, "service.batch_model_failed", "warning", {"action", "target", "error_type"}
    )
    assert {"action": "release", "target": "ollama", "error_type": "RuntimeError"} in [
        {k: entry[k] for k in ("action", "target", "error_type")} for entry in failed
    ]


@pytest.mark.req("REQ-RAG-10.8.8.5")
def test_release_local_before_first_chunk(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.5] 첫 분할 전에 release_local_models가 끝나 있고, 같은 LLM 단계에서는
    다시 부르지 않는다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:  # 분할 상한 1
            a = ScriptedRunner(WAIT, name="a", timeline=timeline)
            b = ScriptedRunner(name="b", timeline=timeline)
            await submit(manager, "doc-a", a)
            b_id = await submit(manager, "doc-b", b)
            await wait_event(a.waiting)
            a.release.set()
            await wait_state(manager, b_id, JobState.SUCCEEDED)
        return timeline

    timeline = go(scenario())

    assert timeline.count(("release_local",)) == 1
    assert timeline.index(("release_local", "end")) < timeline.index(("index_runner", "a"))
    assert timeline.index(("release_local", "end")) < timeline.index(("index_runner", "b"))


@pytest.mark.req("REQ-RAG-10.8.8.5")
def test_release_local_before_first_caption(settings: Settings) -> None:
    """[REQ-RAG-10.8.8.5] 첫 요약·캡션 생성 전에 release_local_models가 끝나 있다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            assert await _caption_service(manager, hub).summarize_table(_TABLE) == "생성된 문장"
        return timeline

    timeline = go(scenario())

    names = _names(timeline)
    assert timeline.index(("release_local", "end")) < names.index("generate")


@pytest.mark.req("REQ-RAG-10.8.8.5")
@pytest.mark.parametrize("kind", ["job", "caption"])
def test_release_local_again_after_embedding(settings: Settings, kind: str) -> None:
    """[REQ-RAG-10.8.8.5] 임베딩 단계가 끝난 뒤의 새 분할·생성 전에 release_local_models가 다시
    끝나 있다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            a = ScriptedRunner(name="a", timeline=timeline)
            a_id = await submit(manager, "doc-a", a)
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            if kind == "job":
                b = ScriptedRunner(name="b", timeline=timeline)
                b_id = await submit(manager, "doc-b", b)
                await wait_state(manager, b_id, JobState.SUCCEEDED)
            else:
                await _caption_service(manager, hub).summarize_table(_TABLE)
        return timeline

    timeline = go(scenario())

    ends = [i for i, entry in enumerate(timeline) if entry == ("release_local", "end")]
    assert len(ends) == 2
    after_embedding = timeline.index(("embed_runner_end", "a"))
    first_use = (
        timeline.index(("index_runner", "b"))
        if kind == "job"
        else _names(timeline).index("generate")
    )
    assert after_embedding < ends[1] < first_use


@pytest.mark.req("REQ-RAG-10.8.8.5")
@pytest.mark.parametrize("kind", ["job", "caption"])
def test_release_local_failure_continues(settings: Settings, kind: str) -> None:
    """[REQ-RAG-10.8.8.5] 로컬 모델 내리기가 실패해도 경고만 남기고 분할·생성을 진행한다."""

    async def scenario() -> None:
        hub = FakeHub()
        hub.errors["release_local"] = OSError("내리기 실패")
        async with running_manager(settings, hub=hub) as manager:
            if kind == "job":
                runner = ScriptedRunner()
                job_id = await submit(manager, "doc-a", runner)
                await wait_state(manager, job_id, JobState.SUCCEEDED)
                assert runner.calls == 1
            else:
                assert await _caption_service(manager, hub).summarize_table(_TABLE) == "생성된 문장"

    _, logs = run_logged(scenario())

    failed = assert_service_log(
        logs, "service.batch_model_failed", "warning", {"action", "target", "error_type"}
    )
    assert ("release", "local", "OSError") in [
        (entry["action"], entry["target"], entry["error_type"]) for entry in failed
    ]


# ── 일괄 색인의 끝 ────────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_batch_end_swaps_models(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.6] 유휴 시간이 지나면 release_ollama_models → load_local_models가 한 번씩
    불리고 거부가 풀린다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            runner = ScriptedRunner(name="a", timeline=timeline)
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            await until(lambda: idle_clock.pending == 1)
            assert 300.0 in idle_clock.requested  # 기본 설정값이다
            with pytest.raises(BatchIndexingError):
                await manager.reject_during_batch()  # 기다리는 동안은 아직 일괄 색인이다

            await finish_batch(idle_clock, timeline)

            await manager.reject_during_batch()  # 끝난 뒤에는 거부하지 않는다
        return timeline

    _, logs = run_logged(scenario())

    ended = assert_service_log(logs, "service.batch_ended", "info", {"elapsed_ms"})
    assert len(ended) == 1


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_batch_end_order(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.6] 끝낼 때 Ollama 모델을 먼저 내린 뒤 로컬 모델을 올리고, 각각 한 번이다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            runner = ScriptedRunner(name="a", timeline=timeline)
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            await finish_batch(idle_clock, timeline)
        return timeline

    timeline = go(scenario())

    tail = timeline[timeline.index(("embed_runner_end", "a")) :]
    # 임베딩 단계가 끝난 뒤의 모델 교체는 이 순서로 한 번씩이다
    assert [e for e in tail if e[0] in ("release_ollama", "load_local")] == [
        ("release_ollama",),
        ("release_ollama", "end"),
        ("load_local",),
        ("load_local", "end"),
    ]
    assert not [e for e in tail if e[0] == "release_local"]


@pytest.mark.req("REQ-RAG-10.8.8.6")
@pytest.mark.parametrize("activity", ["note", "caption"])
def test_idle_restarts_on_activity(
    settings: Settings, idle_clock: IdleClock, activity: str
) -> None:
    """[REQ-RAG-10.8.8.6] 유휴 시간 안에 색인 요청·캡션 요청이 오면 그 시점부터 다시 잰다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            await until(lambda: idle_clock.pending == 1)
            first_timer = idle_clock.timers[-1]
            requested = len(idle_clock.requested)

            if activity == "note":
                manager.note_index_request()
            else:
                async with manager.caption_slot():
                    await settle()
                    assert idle_clock.pending == 0  # 슬롯 안에서는 타이머가 걸리지 않는다
            # 이전 대기는 취소되고 새 대기가 하나 생긴다
            await until(lambda: idle_clock.pending == 1 and len(idle_clock.requested) > requested)

            idle_clock.release(first_timer)  # 이전 대기가 다 재도 끝나지 않는다
            await settle()
            assert ("load_local",) not in timeline
            assert idle_clock.pending == 1

            await finish_batch(idle_clock, timeline)  # 새 대기를 재면 끝난다

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.6")
@pytest.mark.parametrize("kind", ["job", "caption"])
def test_no_end_with_open_work(settings: Settings, idle_clock: IdleClock, kind: str) -> None:
    """[REQ-RAG-10.8.8.6] QUEUED·RUNNING 작업이나 caption_slot() 안의 요청이 있으면 시간이
    지나도 끝나지 않는다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            runner = ScriptedRunner(WAIT)
            holder: CaptionHolder | None = None
            if kind == "job":
                await submit(manager, "doc-a", runner)
                await wait_event(runner.waiting)
            else:
                holder = await hold_caption(manager)
            await settle()
            assert idle_clock.pending == 0  # 타이머가 걸리지 않는다

            idle_clock.tick()
            await settle()
            assert ("load_local",) not in timeline
            with pytest.raises(BatchIndexingError):
                await manager.reject_during_batch()

            if holder is not None:
                await holder.release()
            else:
                runner.release.set()
            await finish_batch(idle_clock, timeline)  # 열린 일이 없어지면 끝난다
            await manager.reject_during_batch()

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_batch_end_failure_still_ends(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8.6] 끝낼 때 내리기·올리기가 실패해도 경고만 남기고 일괄 색인이 끝난다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            hub.errors["release_ollama"] = RuntimeError("실패")
            hub.errors["load_local"] = RuntimeError("실패")

            await finish_batch(idle_clock, timeline)

            await manager.reject_during_batch()  # 끝났다

    _, logs = run_logged(scenario())

    failed = assert_service_log(
        logs, "service.batch_model_failed", "warning", {"action", "target", "error_type"}
    )
    pairs = [(entry["action"], entry["target"]) for entry in failed]
    assert ("release", "ollama") in pairs
    assert pairs.count(("load", "local")) == 1


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_zero_idle_ends_immediately(
    monkeypatch: pytest.MonkeyPatch, make_settings: Callable[..., Settings]
) -> None:
    """[REQ-RAG-10.8.8.6] 유휴 시간이 0이면 마지막 작업 뒤 곧바로 끝난다(실제 대기 함수 사용)."""
    cfg = make_settings(batch_idle=0)
    monkeypatch.setattr(jobs_module, "_idle_wait", REAL_IDLE_WAIT)

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(cfg, hub=hub) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            await until(lambda: ("load_local", "end") in timeline)
            await manager.reject_during_batch()

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_empty_start_rearms_end_timer(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, idle_clock: IdleClock
) -> None:
    """[REQ-RAG-10.8.8.6] 배정 쓰기가 변경 없이 끝나(이미 대기가 아닌 작업) 일이 하나도 남지 않으면
    끝 타이머가 다시 걸려 일괄 색인이 끝난다."""
    monkeypatch.setattr(jobs_module, "_tx_start", lambda conn, job_id: [])

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            runner = ScriptedRunner(name="a", timeline=timeline)
            await submit(manager, "doc-a", runner)
            await until(lambda: idle_clock.pending == 1)  # 마지막 작업이 실행 없이 지나간 뒤 건다
            assert runner.calls == 0
            with pytest.raises(BatchIndexingError):
                await manager.reject_during_batch()  # 타이머를 기다리는 동안은 일괄 색인이다

            await finish_batch(idle_clock, timeline)

            await manager.reject_during_batch()  # 끝났다

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8")
def test_batch_logs(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.8.8] 일괄 색인 시작·임베딩 단계·끝 로그가 info로 남고 허용 필드만 담는다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            await finish_batch(idle_clock, timeline)
            await _caption_service(manager, hub).summarize_table(_TABLE)  # 새 일괄 색인

    _, logs = run_logged(scenario())

    started = assert_service_log(logs, "service.batch_started", "info", {"trigger"})
    assert [entry["trigger"] for entry in started] == ["job", "caption"]
    embed_started = assert_service_log(
        logs, "service.batch_embedding_started", "info", {"pending_jobs"}
    )
    assert [entry["pending_jobs"] for entry in embed_started] == [1]
    embed_ended = assert_service_log(
        logs, "service.batch_embedding_ended", "info", {"jobs", "elapsed_ms"}
    )
    assert [entry["jobs"] for entry in embed_ended] == [1]
    assert len(assert_service_log(logs, "service.batch_ended", "info", {"elapsed_ms"})) == 1


# ── 일괄 색인 중 검색·평가 거부 ───────────────────────────────────


@pytest.mark.req("REQ-RAG-10.4.3")
def test_reject_after_submit_and_caption(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.4.3] 접수한 뒤부터 일괄 색인이 끝날 때까지 검색이 거부되고 남은 작업 수가
    실린다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        searcher = FakeSearcher()
        async with running_manager(settings, hub=hub) as manager:  # 분할 상한 1
            service = _search_service(manager, searcher)
            query = SearchQuery("질의")

            def searches() -> int:
                return len([e for e in searcher.timeline if e[0] == "search"])

            # start 직후와 note_index_request()만 불린 뒤에는 검색한다
            await service.search(query)
            manager.note_index_request()
            await service.search(query)
            assert searches() == 2

            # 접수한 뒤: 거부하고 남은 작업 수는 QUEUED·RUNNING 수다. 문서 청크 조회는 동작한다
            a = ScriptedRunner(WAIT)
            ids = [
                await submit(manager, "doc-a", a),
                await submit(manager, "doc-b", ScriptedRunner()),
            ]
            await wait_event(a.waiting)
            open_now = [
                (await manager.get_job(job_id)).state in (JobState.QUEUED, JobState.RUNNING)
                for job_id in ids
            ]
            with pytest.raises(BatchIndexingError) as caught:
                await service.search(query)
            assert caught.value.remaining_jobs == sum(open_now) == 2
            assert (await service.document_chunks("doc-a")) is searcher.doc
            assert searches() == 2

            # 마지막 작업이 끝난 뒤 기다리는 동안에는 남은 작업이 0이다
            a.release.set()
            for job_id in ids:
                await wait_state(manager, job_id, JobState.SUCCEEDED)
            await until(lambda: idle_clock.pending == 1)
            with pytest.raises(BatchIndexingError) as waiting:
                await service.search(query)
            assert waiting.value.remaining_jobs == 0

            # 일괄 색인이 끝난 뒤에는 다시 검색한다
            await finish_batch(idle_clock, timeline)
            await service.search(query)
            assert searches() == 3

    go(scenario())


@pytest.mark.req("REQ-RAG-10.4.3")
def test_reject_with_caption_slot(settings: Settings) -> None:
    """[REQ-RAG-10.4.3] caption_slot() 안(과 허가 대기 중)에도 검색이 거부된다."""

    async def scenario() -> None:
        searcher = FakeSearcher()
        async with running_manager(settings) as manager:
            service = _search_service(manager, searcher)
            query = SearchQuery("질의")

            # 임베딩 단계 중에 들어오려는 요청은 허가를 기다린다 — 기다리는 동안에도 거부한다
            a = ScriptedRunner(JobStage.EMBEDDING, WAIT)
            a_id = await submit(manager, "doc-a", a)
            await wait_event(a.embed_waiting)
            waiting = asyncio.create_task(_enter_and_leave(manager))
            await settle()
            with pytest.raises(BatchIndexingError) as caught:
                await service.search(query)
            assert caught.value.remaining_jobs == 1

            a.release.set()
            await asyncio.wait_for(waiting, WAIT_LIMIT)
            await wait_state(manager, a_id, JobState.SUCCEEDED)  # 직전 작업의 기록이 끝났다

            # 슬롯 안에서도 거부한다. 작업이 없으니 남은 작업 수는 0이다
            holder = await hold_caption(manager)
            with pytest.raises(BatchIndexingError) as inside:
                await service.search(query)
            assert inside.value.remaining_jobs == 0
            await holder.release()
            assert [e for e in searcher.timeline if e[0] == "search"] == []

    go(scenario())


async def _enter_and_leave(manager: JobManager) -> None:
    """caption_slot에 들어갔다가 바로 나온다."""
    async with manager.caption_slot():
        pass


@pytest.mark.req("REQ-RAG-10.7.2")
def test_evaluate_rejected_during_batch(settings: Settings, idle_clock: IdleClock) -> None:
    """[REQ-RAG-10.7.2] 일괄 색인 중 평가는 거부되지만 잘못된 입력은 먼저 InvalidRequestError다."""

    async def scenario() -> None:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        evaluator = FakeEvaluator()
        async with running_manager(settings, hub=hub) as manager:
            service = EvaluationService(cast(Evaluator, evaluator), manager, ReadyStub(True))
            runner = ScriptedRunner(WAIT)
            job_id = await submit(manager, "doc-a", runner)
            await wait_event(runner.waiting)

            with pytest.raises(BatchIndexingError) as caught:
                await service.evaluate(eval_case())
            assert caught.value.remaining_jobs == 1
            assert "evaluate" not in _names(evaluator.timeline)

            # 입력 검증이 먼저다
            evaluator.validate_error = InvalidRequestError()
            with pytest.raises(InvalidRequestError):
                await service.evaluate(eval_case(answer_span="   "))
            assert "evaluate" not in _names(evaluator.timeline)

            evaluator.validate_error = None
            runner.release.set()
            await wait_state(manager, job_id, JobState.SUCCEEDED)
            await finish_batch(idle_clock, timeline)
            result = await service.evaluate(eval_case())
            assert result is evaluator.result

    go(scenario())


@pytest.mark.req("REQ-RAG-10.2.4.1")
def test_caption_waits_embedding_phase(settings: Settings) -> None:
    """[REQ-RAG-10.2.4.1] 임베딩 단계 중의 요약 요청은 단계가 끝난 뒤 로컬 모델을 내리고
    처리한다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        hub = FakeHub(timeline)
        async with running_manager(settings, hub=hub) as manager:
            a = ScriptedRunner(JobStage.EMBEDDING, WAIT, name="a", timeline=timeline)
            await submit(manager, "doc-a", a)
            await wait_event(a.embed_waiting)  # 임베딩 단계 중이다

            caption = asyncio.create_task(_caption_service(manager, hub).summarize_table(_TABLE))
            await settle()
            assert "generate" not in _names(timeline)  # 단계가 끝나기 전에는 생성하지 않는다
            assert not caption.done()

            a.release.set()
            assert await asyncio.wait_for(caption, WAIT_LIMIT) == "생성된 문장"
        return timeline

    timeline = go(scenario())

    names = _names(timeline)
    embed_end = timeline.index(("embed_runner_end", "a"))
    release_end = embed_end + timeline[embed_end:].index(("release_local", "end"))
    assert release_end < names.index("generate")


# ── 종료 ──────────────────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-10.1.3")
def test_stop_embeds_pending_without_new_chunks(settings: Settings) -> None:
    """[REQ-RAG-10.1.3] stop 뒤에는 새 분할을 시작하지 않지만 분할을 마친 작업은 임베딩해
    기록한다."""

    async def scenario() -> None:
        manager = await new_manager(settings)  # 분할 상한 1
        a = ScriptedRunner(WAIT)
        b = ScriptedRunner()
        a_id = await submit(manager, "doc-a", a)
        b_id = await submit(manager, "doc-b", b)
        await wait_event(a.waiting)

        stopping = asyncio.create_task(manager.stop(5))
        await settle()
        assert not stopping.done()  # A의 분할이 끝나기 전에는 stop도 끝나지 않는다

        a.release.set()
        await asyncio.wait_for(stopping, WAIT_LIMIT)
        assert a.embed_calls == 1
        assert b.calls == 0

        spy = RecoverSpy(False)
        async with running_manager(settings, spy) as second:
            assert (await second.get_job(a_id)).state is JobState.SUCCEEDED
            queued = await second.get_job(b_id)
            assert queued.state is JobState.FAILED
            assert queued.failure is not None
            assert queued.failure.code == "SERVER_RESTARTED"
            assert spy.calls == []  # 완료한 작업과 대기 작업은 recover 대상이 아니다

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.3")
def test_stop_leaves_pending_running(settings: Settings) -> None:
    """[REQ-RAG-10.1.3] 임베딩이 막혀 PENDING인 작업은 stop 뒤 RUNNING으로 남고 wait_running은
    걸리지 않는다."""

    async def scenario() -> None:
        manager = await new_manager(settings)
        holder = await hold_caption(manager)  # 슬롯 안의 요청이 임베딩을 막는다
        a = ScriptedRunner()
        a_id = await submit(manager, "doc-a", a)
        await _wait_stage(manager, a_id, JobStage.EMBEDDING_PENDING)

        await manager.stop(0)
        await (
            holder.release()
        )  # 정리용이다 — stop 뒤 슬롯의 동작은 명세가 정하지 않아 단언하지 않는다

        # stop이 끝난 뒤에도 기다리는 쪽이 걸리지 않는다
        await asyncio.wait_for(manager.wait_running("doc-a"), WAIT_LIMIT)
        assert _db_stage(settings, a_id) == "embedding_pending"

        spy = RecoverSpy(False)
        async with running_manager(settings, spy) as second:
            assert spy.calls == [("doc-a", a_id)]
            view = await second.get_job(a_id)
            assert view.state is JobState.FAILED
            assert view.failure is not None
            assert view.failure.code == "SERVER_RESTARTED"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.5.2")
def test_pending_job_fails_on_restart(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.5.2] 분할만 마치고 남은 작업은 다시 시작할 때 recover를 거쳐
    SERVER_RESTARTED로 끝맺고 알린다."""

    async def scenario() -> None:
        first = await new_manager(settings)
        holder = await hold_caption(first)
        a_id = await submit(first, "doc-a", ScriptedRunner())
        await _wait_stage(first, a_id, JobStage.EMBEDDING_PENDING)
        await notified(receiver, a_id, "running")
        await first.stop(0)
        await (
            holder.release()
        )  # 정리용이다 — stop 뒤 슬롯의 동작은 명세가 정하지 않아 단언하지 않는다

        spy = RecoverSpy(False)
        async with running_manager(settings, spy) as second:
            assert spy.calls == [("doc-a", a_id)]
            await notified(receiver, a_id, "failed")
            failure = (await second.get_job(a_id)).failure
            assert failure is not None
            assert failure.code == "SERVER_RESTARTED"
        assert receiver.states(a_id) == ["queued", "running", "failed"]

    go(scenario())


# ── 실패와 호출 순서 ──────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.4.1")
def test_failed_embed_not_retried(settings: Settings) -> None:
    """[REQ-RAG-10.8.4.1] EmbedRunner가 JobFailure를 내면 FAILED이고 새 접수에도 다시 불리지
    않는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            failing = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            failed_id = await submit(manager, "doc-a", failing, version="v1")
            await wait_state(manager, failed_id, JobState.FAILED)
            assert failing.embed_calls == 1

            new_id = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            await wait_state(manager, new_id, JobState.SUCCEEDED)
            assert (failing.calls, failing.embed_calls) == (1, 1)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.2.4")
def test_embed_runner_unexpected_error(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.4] EmbedRunner의 예상 못한 예외는 INTERNAL_ERROR로 기록하고 예외 문자열은
    숨긴다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(result=RuntimeError("secret-detail"))
            job_id = await submit(manager, "doc-a", runner)
            await wait_state(manager, job_id, JobState.FAILED)
            failure = (await manager.get_job(job_id)).failure
            assert failure is not None
            assert failure.code == "INTERNAL_ERROR"
            assert "secret-detail" not in failure.message

    _, logs = run_logged(scenario())

    entries = assert_service_log(
        logs, "service.job_error", "error", {"job_id", "doc_id", "step", "error_type"}, stack=True
    )
    assert [entry["step"] for entry in entries] == ["run"]


@pytest.mark.req("REQ-RAG-10.8.1.1")
def test_submit_returns_while_model_switch_blocks(settings: Settings) -> None:
    """[REQ-RAG-10.8.1.1] 모델 내리기가 멈춰 있어도 submit은 작업 ID를 곧 돌려주고 QUEUED다."""

    async def scenario() -> None:
        hub = FakeHub()
        gate = asyncio.Event()
        hub.blocks["release_local"] = gate
        async with running_manager(settings, hub=hub) as manager:
            try:
                runner = ScriptedRunner()
                job_id = await asyncio.wait_for(submit(manager, "doc-a", runner), WAIT_LIMIT)
                await until(lambda: ("release_local",) in hub.timeline)
                assert (await manager.get_job(job_id)).state is JobState.QUEUED
                assert runner.calls == 0
            finally:
                gate.set()

    go(scenario())


@pytest.mark.req("REQ-RAG-10.8.8")
def test_call_order_violation(settings: Settings) -> None:
    """[REQ-RAG-10.8.8] start 전에 caption_slot·note_index_request·reject_during_batch를 부르면
    RuntimeError다."""

    async def scenario() -> None:
        manager = make_manager(settings)
        with pytest.raises(RuntimeError):
            manager.note_index_request()
        with pytest.raises(RuntimeError):
            await manager.reject_during_batch()
        with pytest.raises(RuntimeError):
            async with manager.caption_slot():
                pass

    go(scenario())
