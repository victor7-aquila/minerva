"""수명주기 서비스(REQ-RAG-10.1) 테스트."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import cast

import pytest

from minerva_rag.core import (
    GlossaryError,
    ModelLoadError,
    ServerNotReadyError,
    Settings,
    ShuttingDownError,
    StoreUnavailableError,
)
from minerva_rag.indexing import Indexer
from minerva_rag.resource import ChunkStore, ModelHub
from minerva_rag.search import Searcher, SearchQuery
from minerva_rag.service import Health, LifecycleService, Services, build_services
from minerva_rag.service.jobs import JobManager

from .fakes import (
    WAIT,
    FakeHub,
    FakeIndexer,
    FakeSearcher,
    FakeStore,
    RecoverSpy,
    ScriptedRunner,
    assert_service_log,
    build_lifecycle,
    eval_case,
    go,
    index_request,
    run_logged,
    submit,
    until,
    wait_event,
    wire,
)


@pytest.mark.req("REQ-RAG-10.1.1")
def test_startup_order(settings: Settings) -> None:
    """[REQ-RAG-10.1.1] 용어집 → 모델 → Qdrant → 작업 처리기 순으로 시작하고 끝나면 ready다."""
    fakes = build_lifecycle(settings)
    assert fakes.service.ready is False

    go(fakes.service.startup())

    # 명세는 순서만 정한다 — 부가 호출이 끼어도 이 네 호출의 상대 순서만 본다
    steps = ("load_glossary", "prepare", "connect", "queue.start")
    ordered = [entry for entry in fakes.timeline if entry[0] in steps]
    assert [entry[0] for entry in ordered] == list(steps)
    # ★ 차원은 prepare 뒤에 읽는다 — 가짜 property는 prepare 전에 읽으면 오류를 낸다
    assert ordered[2] == ("connect", 8)
    assert ordered[3][1] == fakes.indexer.recover
    assert fakes.service.ready is True


@pytest.mark.req("REQ-RAG-10.1.1")
def test_not_ready_before_last_step(settings: Settings) -> None:
    """[REQ-RAG-10.1.1] 마지막 단계가 끝나기 전에는 ready가 거짓이다."""
    fakes = build_lifecycle(settings)

    async def scenario() -> None:
        gate = asyncio.Event()
        fakes.queue.start_block = gate
        task = asyncio.create_task(fakes.service.startup())
        await until(lambda: any(e[0] == "queue.start" for e in fakes.timeline))
        assert fakes.service.ready is False
        gate.set()
        await asyncio.wait_for(task, 5)
        assert fakes.service.ready is True

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.1")
@pytest.mark.parametrize(
    ("step", "error", "absent"),
    [
        ("glossary", GlossaryError(), ["prepare", "connect", "queue.start"]),
        ("models", ModelLoadError(), ["connect", "queue.start"]),
        ("store", StoreUnavailableError(), ["queue.start"]),
    ],
)
def test_step_failure_stops(
    settings: Settings, step: str, error: Exception, absent: list[str]
) -> None:
    """[REQ-RAG-10.1.1] 한 단계가 실패하면 뒤 단계가 불리지 않고 그 예외가 나며 ready는 거짓이다."""
    fakes = build_lifecycle(settings)
    if step == "glossary":
        fakes.searcher.glossary_error = error
    elif step == "models":
        fakes.hub.prepare_error = error
    else:
        fakes.store.connect_error = error

    async def scenario() -> Exception:
        with pytest.raises(type(error)) as caught:
            await fakes.service.startup()
        return caught.value

    raised, logs = run_logged(scenario())

    assert raised is error
    names = [entry[0] for entry in fakes.timeline]
    for name in absent:
        assert name not in names
    assert fakes.service.ready is False
    assert_service_log(logs, "service.lifecycle.startup_failed", "error", {"step", "error_type"})


@pytest.mark.req("REQ-RAG-10.1.1")
def test_other_step_failure(settings: Settings) -> None:
    """[REQ-RAG-10.1.1] 세 예외가 아닌 작업 처리기 시작 오류도 같게 처리한다."""
    fakes = build_lifecycle(settings)
    fakes.queue.start_error = RuntimeError("sqlite")

    async def scenario() -> None:
        with pytest.raises(RuntimeError):
            await fakes.service.startup()

    _, logs = run_logged(scenario())

    assert_service_log(logs, "service.lifecycle.startup_failed", "error", {"step", "error_type"})
    assert fakes.service.ready is False


@pytest.mark.req("REQ-RAG-10.1.1")
def test_start_calls_recover_for_running(settings: Settings) -> None:
    """[REQ-RAG-10.1.1] 작업 처리기 시작 때 남은 RUNNING 작업에 Indexer.recover가 불린다."""

    async def scenario() -> None:
        # 이전 프로세스: 색인 중인 작업을 남기고 멈춘다
        first = JobManager(settings)
        await first.start(RecoverSpy(False))
        runner = ScriptedRunner(WAIT)
        job_id = await submit(first, "doc-a", runner)
        await wait_event(runner.waiting)
        await first.stop(0)

        # 다시 시작: 진짜 작업 관리자와 가짜 indexer로 startup한다
        second = JobManager(settings)
        indexer = FakeIndexer()
        indexer.recover_result = False
        service = LifecycleService(
            cast(ModelHub, FakeHub()),
            cast(ChunkStore, FakeStore()),
            cast(Searcher, FakeSearcher()),
            cast(Indexer, indexer),
            second,
            settings,
        )
        try:
            await service.startup()
            assert indexer.recovered == [("doc-a", job_id)]
        finally:
            await second.stop(0)

    go(scenario())


def _calls(services: Services) -> list[tuple[str, Callable[[], Awaitable[object]]]]:
    """준비 전에 막혀야 하는 열한 개 메서드 호출을 만든다."""
    return [
        ("caption.summarize_table", lambda: services.caption.summarize_table("| a |\n| - |")),
        ("caption.caption_image", lambda: services.caption.caption_image(b"img")),
        ("index.submit", lambda: services.index.submit(index_request())),
        ("index.get_job", lambda: services.index.get_job("job-1")),
        ("index.index_state", lambda: services.index.index_state("doc-a")),
        ("index.index_states", lambda: services.index.index_states(["doc-a"])),
        ("search.search", lambda: services.search.search(SearchQuery("질의"))),
        ("search.document_chunks", lambda: services.search.document_chunks("doc-a")),
        ("delete.delete", lambda: services.delete.delete("doc-a")),
        ("metadata.update", lambda: services.metadata.update("doc-a", "이름", None)),
        ("evaluation.evaluate", lambda: services.evaluation.evaluate(eval_case())),
    ]


@pytest.mark.req("REQ-RAG-10.1.2")
def test_methods_refuse_before_ready(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.1.2] 준비 전 열한 개 메서드는 단위를 부르지 않고 ServerNotReadyError를 낸다."""
    services, parts = wire(monkeypatch, settings)

    async def scenario() -> None:
        for name, call in _calls(services):
            with pytest.raises(ServerNotReadyError):
                await call()
            assert parts.timeline == [], f"{name}이 단위를 불렀다"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.2")
def test_health_before_ready(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.1.2] health는 준비 전에도 결과를 돌려준다."""
    services, parts = wire(monkeypatch, settings)
    parts.store.qdrant = False
    parts.hub.ollama = True

    result = go(services.lifecycle.health())

    assert result == Health(qdrant=False, ollama=True)
    assert services.lifecycle.ready is False


@pytest.mark.req("REQ-RAG-10.1.2")
@pytest.mark.parametrize("qdrant", [True, False])
@pytest.mark.parametrize("ollama", [True, False])
def test_health_reports_both(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, qdrant: bool, ollama: bool
) -> None:
    """[REQ-RAG-10.1.2] health는 ping과 ollama_available 결과를 그대로 돌려준다."""
    services, parts = wire(monkeypatch, settings)
    parts.store.qdrant = qdrant
    parts.hub.ollama = ollama

    assert go(services.lifecycle.health()) == Health(qdrant=qdrant, ollama=ollama)


@pytest.mark.req("REQ-RAG-10.1.2")
def test_ready_shared_after_startup(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.1.2] startup이 끝나면 준비 상태가 모든 서비스에 전달된다."""
    services, parts = wire(monkeypatch, settings)

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            hits = await services.search.search(SearchQuery("질의"))
            assert hits == parts.searcher.hits
        finally:
            await services.lifecycle.shutdown()

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.3")
def test_shutdown_stops_then_closes(make_settings: Callable[..., Settings]) -> None:
    """[REQ-RAG-10.1.3] shutdown은 설정한 시간으로 stop을 부른 뒤 연결과 모델을 닫는다."""
    fakes = build_lifecycle(make_settings(shutdown_timeout=7.5))

    go(fakes.service.shutdown())

    names = [entry[0] for entry in fakes.timeline]
    assert ("queue.stop", 7.5) in fakes.timeline
    stop_at = names.index("queue.stop")
    assert names.index("store.close") > stop_at
    assert names.index("hub.close") > stop_at


@pytest.mark.req("REQ-RAG-10.1.3")
def test_submit_after_shutdown(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.1.3] shutdown 뒤 색인 요청은 ServerNotReadyError가 아니라 ShuttingDownError다."""
    services, _ = wire(monkeypatch, settings, jobs_cls=JobManager)

    async def scenario() -> None:
        await services.lifecycle.startup()
        await services.lifecycle.shutdown()
        with pytest.raises(ShuttingDownError):
            await services.index.submit(index_request())

    go(scenario())


@pytest.mark.req("REQ-RAG-10.1.1")
def test_build_services_single_indexer(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.1.1] build_services는 Indexer를 하나만 만들고 연결·준비를 하지 않는다."""
    services, parts = wire(monkeypatch, settings)

    assert isinstance(services, Services)
    assert len(parts.indexers) == 1
    assert isinstance(services.lifecycle, LifecycleService)
    # ★ 만들기만 하고 prepare·connect·start는 부르지 않는다
    assert parts.timeline == []


@pytest.mark.req("REQ-RAG-10.1.1")
def test_build_services_no_io(settings: Settings) -> None:
    """[REQ-RAG-10.1.1] 가짜로 바꾸지 않은 build_services도 파일을 만들지 않고 끝난다."""
    services = build_services(settings)

    assert isinstance(services, Services)
    assert not settings.jobs_db_path.exists()
    assert not settings.jobs_db_path.parent.exists()
