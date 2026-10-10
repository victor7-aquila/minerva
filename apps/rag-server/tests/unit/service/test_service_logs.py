"""service 로그(MODULE.md 「로그」) 테스트."""

from typing import cast

import pytest

from minerva_rag.core import (
    CaptionFailedError,
    Settings,
    StoreUnavailableError,
)
from minerva_rag.resource import ModelHub
from minerva_rag.search import Searcher, SearchQuery
from minerva_rag.service import JobState, SearchService
from minerva_rag.service.captioner import Captioner
from minerva_rag.service.jobs import JobFailure

from ..resource.fakes import assert_logs_exclude, events_named
from .fakes import (
    FakeHub,
    FakeSearcher,
    ReadyStub,
    ScriptedRunner,
    assert_service_log,
    build_lifecycle,
    eval_case,
    index_request,
    placeholder,
    run_logged,
    running_manager,
    submit,
    wait_state,
    wire,
)

_TABLE = "| 항목 | 값 |\n| --- | --- |\n| 갱신 | 30일 전 |"
_SECRETS = {
    "markdown": "비밀본문XYZ",
    "asset": "비밀요약ABC",
    "name": "비밀문서이름DEF",
    "table": "비밀표GHI",
    "reply": "비밀생성JKL",
    "query": "비밀질의MNO",
    "span": "비밀정답PQR",
}
_TOKEN = "events-token-for-test"


@pytest.mark.req("REQ-RAG-10.1.2")
def test_entry_events(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.1.2] 모든 서비스 메서드가 진입 때 service.{서비스}.{동작} info 로그를 남긴다."""
    services, parts = wire(monkeypatch, settings)

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            await services.lifecycle.health()
            await services.caption.summarize_table(_TABLE)
            await services.caption.caption_image(b"img")
            accepted = await services.index.submit(index_request())
            await wait_state(parts.manager, accepted.job_id, JobState.SUCCEEDED)
            await services.index.get_job(accepted.job_id)
            await services.index.index_state("doc-a")
            await services.index.index_states(["doc-a"])
            await services.search.search(SearchQuery("질의"))
            await services.search.document_chunks("doc-a")
            await services.metadata.update("doc-a", "이름", None)
            await services.evaluation.evaluate(eval_case())
            await services.delete.delete("doc-a")
        finally:
            await services.lifecycle.shutdown()

    _, logs = run_logged(scenario())

    expected = [
        "service.lifecycle.startup",
        "service.lifecycle.health",
        "service.lifecycle.shutdown",
        "service.caption.summarize_table",
        "service.caption.caption_image",
        "service.index.submit",
        "service.index.get_job",
        "service.index.index_state",
        "service.index.index_states",
        "service.search.search",
        "service.search.document_chunks",
        "service.delete.delete",
        "service.metadata.update",
        "service.evaluation.evaluate",
    ]
    for event in expected:
        found = events_named(logs, event)
        assert found, f"{event} 로그가 없다"
        assert all(entry["log_level"] == "info" for entry in found), event


@pytest.mark.req("REQ-RAG-10.3.1")
def test_submit_log_fields(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 색인 요청 진입·결정 로그가 허용 필드만 담고 글자 수·개수를 남긴다."""
    services, parts = wire(monkeypatch, settings)
    markdown = "# 제목\n\n본문\n\n" + placeholder("table", "t1", "표 설명")
    request = index_request(markdown=markdown, assets={"t1": "요약", "t2": "안 쓰는 요약"})

    async def scenario() -> str:
        await services.lifecycle.startup()
        try:
            accepted = await services.index.submit(request)
            await wait_state(parts.manager, accepted.job_id, JobState.SUCCEEDED)
            return accepted.job_id
        finally:
            await services.lifecycle.shutdown()

    job_id, logs = run_logged(scenario())

    (entry,) = assert_service_log(
        logs,
        "service.index.submit",
        "info",
        {"doc_id", "version", "markdown_chars", "assets", "force"},
    )
    assert entry["markdown_chars"] == len(markdown)
    assert entry["assets"] == 2
    (decided,) = assert_service_log(
        logs, "service.index.decided", "info", {"doc_id", "outcome", "job_id"}
    )
    assert decided["outcome"] == "queued"
    assert decided["job_id"] == job_id


@pytest.mark.req("REQ-RAG-10.5.1")
def test_delete_log_fields(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.5.1] 삭제 요청 진입 로그가 doc_id만 담는다."""
    services, _ = wire(monkeypatch, settings)

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            await services.delete.delete("doc-a")
        finally:
            await services.lifecycle.shutdown()

    _, logs = run_logged(scenario())

    assert_service_log(logs, "service.delete.delete", "info", {"doc_id"})


@pytest.mark.req("REQ-RAG-10.8.2.1")
def test_job_state_log(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.1] 상태가 바뀔 때마다 service.job_state info 로그가 허용 필드만 담는다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            ok_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, ok_id, JobState.SUCCEEDED)
            bad = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            bad_id = await submit(manager, "doc-b", bad)
            await wait_state(manager, bad_id, JobState.FAILED)

    _, logs = run_logged(scenario())

    found = assert_service_log(
        logs,
        "service.job_state",
        "info",
        {"job_id", "doc_id", "version", "state", "failure_code"},
    )
    assert len(found) == 6  # 작업 둘의 queued·running·끝난 상태, 변경마다 하나
    assert {entry["doc_id"] for entry in found} == {"doc-a", "doc-b"}


@pytest.mark.req("REQ-RAG-10.1.1")
def test_startup_ready_log(settings: Settings) -> None:
    """[REQ-RAG-10.1.1] 준비가 끝나면 service.lifecycle.ready info 로그를 elapsed_ms로 남긴다."""
    fakes = build_lifecycle(settings)

    _, logs = run_logged(fakes.service.startup())

    assert_service_log(logs, "service.lifecycle.ready", "info", {"elapsed_ms"})
    assert not events_named(logs, "service.lifecycle.startup_failed")


@pytest.mark.req("REQ-RAG-10.2.2.3")
@pytest.mark.req("REQ-RAG-10.2.3.3")
def test_caption_failed_log() -> None:
    """[REQ-RAG-10.2.2.3] 요약·캡션 실패는 caption_failed warning을 종류별 필드로 남긴다."""
    hub = FakeHub()
    hub.reply = ""
    captioner = Captioner(cast(ModelHub, hub))
    image = b"\x89PNG-bytes"

    async def scenario() -> None:
        with pytest.raises(CaptionFailedError):
            await captioner.summarize_table(_TABLE)
        with pytest.raises(CaptionFailedError):
            await captioner.caption_image(image)

    _, logs = run_logged(scenario())

    found = assert_service_log(
        logs,
        "service.caption_failed",
        "warning",
        {"kind", "input_chars", "image_bytes"},
    )
    table = [e for e in found if e["kind"] == "table"]
    images = [e for e in found if e["kind"] == "image"]
    assert len(table) == 1
    assert len(images) == 1
    assert set(table[0]) - {"event", "log_level", "exc_info"} <= {"kind", "input_chars"}
    assert table[0]["input_chars"] == len(_TABLE)
    assert set(images[0]) - {"event", "log_level", "exc_info"} <= {"kind", "image_bytes"}
    assert images[0]["image_bytes"] == len(image)


@pytest.mark.req("REQ-RAG-10.4.1")
def test_service_failed_levels() -> None:
    """[REQ-RAG-10.4.1] 서비스 예외는 도메인이면 warning, 그 밖은 스택 있는 error로 남긴다."""
    fake = FakeSearcher()
    service = SearchService(cast(Searcher, fake), ReadyStub(True))

    async def domain() -> None:
        fake.error = StoreUnavailableError()
        with pytest.raises(StoreUnavailableError):
            await service.search(SearchQuery("질의"))

    async def other() -> None:
        fake.error = RuntimeError("boom")
        with pytest.raises(RuntimeError):
            await service.search(SearchQuery("질의"))

    _, warning_logs = run_logged(domain())
    _, error_logs = run_logged(other())

    (warned,) = assert_service_log(
        warning_logs, "service.failed", "warning", {"operation", "error_type", "code"}
    )
    assert warned["code"] == "STORE_UNAVAILABLE"
    assert_service_log(
        error_logs,
        "service.failed",
        "error",
        {"operation", "error_type", "code"},
        stack=True,
    )


@pytest.mark.req("REQ-RAG-10.3.1")
@pytest.mark.req("REQ-RAG-10.2.2.1")
def test_logs_exclude_content(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 문서 본문·표·요약·질의·정답 구간·이름·토큰 값이 어떤 로그에도 없다."""
    services, parts = wire(monkeypatch, settings)
    parts.hub.reply = _SECRETS["reply"]
    markdown = f"# 제목\n\n{_SECRETS['markdown']}\n\n" + placeholder("table", "t1", "표 설명")

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            await services.caption.summarize_table(f"| {_SECRETS['table']} |")
            await services.caption.caption_image(b"img")
            accepted = await services.index.submit(
                index_request(
                    markdown=markdown,
                    assets={"t1": _SECRETS["asset"]},
                    name=_SECRETS["name"],
                )
            )
            await wait_state(parts.manager, accepted.job_id, JobState.SUCCEEDED)
            await services.search.search(SearchQuery(_SECRETS["query"]))
            await services.evaluation.evaluate(
                eval_case(query=_SECRETS["query"], answer_span=_SECRETS["span"])
            )
            await services.metadata.update("doc-a", _SECRETS["name"], None)
            await services.delete.delete("doc-a")
            # 실패 경로의 로그에도 내용이 새지 않는다
            parts.searcher.error = StoreUnavailableError()
            with pytest.raises(StoreUnavailableError):
                await services.search.search(SearchQuery(_SECRETS["query"]))
        finally:
            await services.lifecycle.shutdown()

    _, logs = run_logged(scenario())

    assert logs
    assert_logs_exclude(logs, [*_SECRETS.values(), _TOKEN])
