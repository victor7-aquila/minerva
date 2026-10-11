"""요약·캡션 서비스와 생성 헬퍼(REQ-RAG-10.2) 테스트."""

from pathlib import Path
from typing import cast

import pytest

from minerva_rag.core import (
    CaptionFailedError,
    MinervaError,
    ModelUnavailableError,
    PromptTooLongError,
    Settings,
)
from minerva_rag.resource import LlmRole, ModelHub
from minerva_rag.service import CaptionService
from minerva_rag.service.captioner import Captioner

from .fakes import (
    FakeHub,
    FakeJobQueue,
    FakeReceiver,
    ReadyStub,
    Timeline,
    go,
    wire,
)

_TABLE = "| 항목 | 값 |\n| --- | --- |\n| 갱신 | 30일 전 |"
_PNG = b"\x89PNG\r\n\x1a\n\x00\x01\x02binary"


def _captioner(hub: FakeHub) -> Captioner:
    """가짜 허브로 Captioner를 만든다."""
    return Captioner(cast(ModelHub, hub))


def _files(root: Path) -> set[Path]:
    """폴더 아래의 모든 파일·폴더를 모은다."""
    return set(root.rglob("*"))


@pytest.mark.req("REQ-RAG-10.2.2.1")
def test_table_summary_role_and_strip() -> None:
    """[REQ-RAG-10.2.2.1] TABLE_SUMMARY 역할로 한 번 생성하고 결과의 앞뒤 공백을 뺀다."""
    hub = FakeHub()
    hub.reply = "  표 요약 문장입니다.\n"

    result = go(_captioner(hub).summarize_table(_TABLE))

    assert result == "표 요약 문장입니다."
    generated = [e for e in hub.timeline if e[0] == "generate"]
    assert len(generated) == 1
    _, role, prompt, image = generated[0]
    assert role is LlmRole.TABLE_SUMMARY
    assert _TABLE in prompt
    assert image is None


@pytest.mark.req("REQ-RAG-10.2.2.2")
def test_table_summary_no_side_effects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings: Settings
) -> None:
    """[REQ-RAG-10.2.2.2] 요약은 파일·작업 DB에 쓰지 않고 모델 호출 하나뿐이다."""
    monkeypatch.chdir(tmp_path)
    before = _files(tmp_path)
    hub = FakeHub()

    go(_captioner(hub).summarize_table(_TABLE))

    assert _files(tmp_path) == before
    assert not settings.jobs_db_path.exists()
    assert [e[0] for e in hub.timeline] == ["generate"]


@pytest.mark.req("REQ-RAG-10.2.2.3")
@pytest.mark.parametrize(
    ("reply", "error", "expected"),
    [
        ("", None, CaptionFailedError),
        ("  \n", None, CaptionFailedError),
        ("x", PromptTooLongError(), CaptionFailedError),
        ("x", RuntimeError("boom"), CaptionFailedError),
        ("x", ModelUnavailableError(), ModelUnavailableError),
    ],
)
def test_table_summary_failures(
    reply: str, error: Exception | None, expected: type[MinervaError]
) -> None:
    """[REQ-RAG-10.2.2.3] 빈 응답·생성 오류는 CaptionFailedError, 연결 거부는 그대로 낸다."""
    hub = FakeHub()
    hub.reply = reply
    hub.generate_error = error

    with pytest.raises(expected) as caught:
        go(_captioner(hub).summarize_table(_TABLE))

    # CaptionFailedError가 기대되는 곳에서 연결 오류가 새지 않게 정확한 클래스를 본다
    assert type(caught.value) is expected


@pytest.mark.req("REQ-RAG-10.2.3.1")
def test_image_caption_role_and_bytes() -> None:
    """[REQ-RAG-10.2.3.1] IMAGE_CAPTION 역할로 이미지 바이트를 그대로 넘기고 결과를 다듬는다."""
    hub = FakeHub()
    hub.reply = "\n 이미지 캡션입니다. "

    result = go(_captioner(hub).caption_image(_PNG))

    assert result == "이미지 캡션입니다."
    generated = [e for e in hub.timeline if e[0] == "generate"]
    assert len(generated) == 1
    _, role, _, image = generated[0]
    assert role is LlmRole.IMAGE_CAPTION
    assert image == _PNG


@pytest.mark.req("REQ-RAG-10.2.3.2")
def test_image_caption_no_side_effects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings: Settings
) -> None:
    """[REQ-RAG-10.2.3.2] 캡션은 파일·작업 DB에 쓰지 않고 모델 호출 하나뿐이다."""
    monkeypatch.chdir(tmp_path)
    before = _files(tmp_path)
    hub = FakeHub()

    go(_captioner(hub).caption_image(_PNG))

    assert _files(tmp_path) == before
    assert not settings.jobs_db_path.exists()
    assert [e[0] for e in hub.timeline] == ["generate"]


@pytest.mark.req("REQ-RAG-10.2.3.3")
@pytest.mark.parametrize(
    ("reply", "error", "expected"),
    [
        ("", None, CaptionFailedError),
        ("x", RuntimeError("이미지를 읽지 못했다"), CaptionFailedError),
        ("x", ModelUnavailableError(), ModelUnavailableError),
    ],
)
def test_image_caption_failures(
    reply: str, error: Exception | None, expected: type[MinervaError]
) -> None:
    """[REQ-RAG-10.2.3.3] 빈 응답·생성 오류는 CaptionFailedError, 연결 거부는 그대로 낸다."""
    hub = FakeHub()
    hub.reply = reply
    hub.generate_error = error

    with pytest.raises(expected) as caught:
        go(_captioner(hub).caption_image(_PNG))

    assert type(caught.value) is expected


@pytest.mark.req("REQ-RAG-10.2.1")
def test_caption_service_passes_result(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.2.1] 서비스는 Captioner 결과를 돌려주고 슬롯 안에서 처리하며 작업·알림을
    만들지 않는다."""
    services, parts = wire(monkeypatch, settings)
    parts.hub.reply = "  가짜 응답  "

    async def scenario() -> None:
        await services.lifecycle.startup()
        try:
            parts.timeline.clear()
            assert await services.caption.summarize_table(_TABLE) == "가짜 응답"
            assert await services.caption.caption_image(_PNG) == "가짜 응답"
        finally:
            await services.lifecycle.shutdown()

    go(scenario())

    names = [e[0] for e in parts.timeline]
    assert names.count("generate") == 2
    # 슬롯에 들어가 처리한다 — 들어가기 전에 임베딩·재정렬 모델을 내린다(REQ-RAG-10.8.8.5)
    assert names.count("jobs.caption_enter") == 2
    assert names.count("jobs.caption_exit") == 2
    assert names.index("jobs.caption_enter") < names.index("generate")
    assert ("release_local", "end") in parts.timeline
    # 작업은 만들지 않는다
    assert "jobs.submit" not in names
    assert receiver.requests == []


@pytest.mark.req("REQ-RAG-10.2.1")
@pytest.mark.parametrize("kind", ["table", "image"])
def test_caption_inside_slot(kind: str) -> None:
    """[REQ-RAG-10.2.1] 요약·캡션은 caption_slot 안에서 생성하고, 생성이 실패해도 슬롯을 나온다."""
    timeline: Timeline = []
    hub = FakeHub(timeline)
    queue = FakeJobQueue(timeline)
    service = CaptionService(_captioner(hub), queue, ReadyStub(True))

    async def call() -> str:
        if kind == "table":
            return await service.summarize_table(_TABLE)
        return await service.caption_image(_PNG)

    assert go(call()) == "생성된 문장"
    names = [entry[0] for entry in timeline]
    assert names == ["queue.caption_enter", "generate", "queue.caption_exit"]

    # 생성이 실패해도 슬롯을 나온다
    timeline.clear()
    hub.generate_error = RuntimeError("boom")
    with pytest.raises(CaptionFailedError):
        go(call())
    names = [entry[0] for entry in timeline]
    assert names == ["queue.caption_enter", "generate", "queue.caption_exit"]
