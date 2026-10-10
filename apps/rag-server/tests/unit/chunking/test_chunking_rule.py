"""규칙 분할(REQ-RAG-2.1.2, 2.1.5~2.1.7, 2.3.3) 테스트."""

import pytest

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import (
    ChunkingFailedError,
    ModelUnavailableError,
    PromptTooLongError,
    Settings,
)
from minerva_rag.resource import LlmRole

from .fakes import (
    FakeModelHub,
    GenerationError,
    MakeSettings,
    assert_verbatim,
    asset_chunks,
    by_headings,
    count_words,
    first_line,
    has_bodyless_text_chunk,
    is_heading_line,
    make_chunker,
    run,
    text_chunks,
)

RULE_DOC = "머리말 w1.\n\n# 설치\n\n설치 w2.\n\n## Docker\n\nDocker w3.\n\n## 환경\n\n환경 w4.\n"


@pytest.mark.req("REQ-RAG-2.1.6")
def test_rule_boundaries_before_headings(settings: Settings) -> None:
    """[REQ-RAG-2.1.6] 규칙 분할은 경계가 모두 헤딩 줄 앞이고 경계를 정하는 LLM 호출이 없다."""
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))

    chunks = text_chunks(result)
    assert len(chunks) == 4
    assert all(is_heading_line(first_line(c.text)) for c in chunks[1:])
    assert fake.boundary_calls == []
    assert_verbatim([c.text for c in chunks], RULE_DOC)


@pytest.mark.req("REQ-RAG-2.1.2")
def test_rule_titles_from_llm(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 규칙 분할 청크도 LlmRole.CHUNKING으로 만든 제목·요약을 갖는다."""
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))

    chunks = text_chunks(result)
    assert all(c.title == "규칙 제목" and c.summary == "규칙 요약" for c in chunks)
    assert fake.title_calls
    assert all(call.role is LlmRole.CHUNKING for call in fake.title_calls)


@pytest.mark.req("REQ-RAG-2.1.2")
def test_rule_title_unparseable_fails(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 제목·요약 응답을 해석할 수 없으면 ChunkingFailedError다."""
    fake = FakeModelHub(title=lambda prompt: "제목 아님")

    with pytest.raises(ChunkingFailedError):
        run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))


@pytest.mark.req("REQ-RAG-2.1.2")
@pytest.mark.parametrize(
    "response",
    ['{"title": "", "summary": "요약"}', '{"title": "제목", "summary": " "}'],
    ids=["empty-title", "blank-summary"],
)
def test_rule_title_empty_fails(settings: Settings, response: str) -> None:
    """[REQ-RAG-2.1.2] 비었거나 공백뿐인 제목·요약 응답은 ChunkingFailedError다."""
    fake = FakeModelHub(title=lambda prompt: response)

    with pytest.raises(ChunkingFailedError):
        run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))


@pytest.mark.req("REQ-RAG-2.1.2")
def test_rule_title_generation_error_fails(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 제목·요약 생성이 실패하면 위치가 있는 ChunkingFailedError다."""
    fake = FakeModelHub(error=lambda call: None if call.is_boundary else GenerationError())

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))

    assert info.value.location is not None


@pytest.mark.req("REQ-RAG-2.1.2")
def test_title_failure_location(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 제목·요약 실패의 위치에 그 청크의 헤딩 경로가 담긴다."""
    fake = FakeModelHub(title=lambda prompt: "x")

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split("# A\n\n## B\n\n본문 w1.\n", ChunkingMode.RULE))

    location = info.value.location
    assert location is not None
    assert location.heading_path == ("A", "B")
    assert location.placeholder_id is None


@pytest.mark.req("REQ-RAG-2.1.2")
@pytest.mark.parametrize(
    "failure",
    [GenerationError, PromptTooLongError],
    ids=["generation-error", "prompt-too-long"],
)
def test_title_call_failure_location(settings: Settings, failure: type[Exception]) -> None:
    """[REQ-RAG-2.1.2] 제목·요약 호출의 생성 실패는 그 청크의 헤딩 경로를 위치로 갖는다."""
    fake = FakeModelHub(error=lambda call: None if call.is_boundary else failure())

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split("# A\n\n## B\n\n본문 w1.\n", ChunkingMode.RULE))

    location = info.value.location
    assert location is not None
    assert location.heading_path == ("A", "B")
    assert location.placeholder_id is None


@pytest.mark.req("REQ-RAG-2.1.2")
def test_title_call_model_unavailable_propagates(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 제목·요약 호출의 ModelUnavailableError는 그대로 난다."""
    fake = FakeModelHub(error=lambda call: None if call.is_boundary else ModelUnavailableError())

    with pytest.raises(ModelUnavailableError) as info:
        run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))

    assert not isinstance(info.value, ChunkingFailedError)


@pytest.mark.req("REQ-RAG-2.1.2")
@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_rule_title_prompt_overflow_fails(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.1.2] 지시문만으로 입력 한도를 넘으면 넘치는 입력을 보내지 않고 실패한다."""
    settings = make_settings(chunk_max=1, max_input=2)
    fake = FakeModelHub(counter=count_words)

    with pytest.raises(ChunkingFailedError):
        run(make_chunker(fake, settings).split("# A\n\n본문 w1.\n", ChunkingMode.RULE))

    assert fake.calls == []


@pytest.mark.req("REQ-RAG-2.1.7")
def test_rule_heading_only_merged(settings: Settings) -> None:
    """[REQ-RAG-2.1.7] 규칙 분할에서도 헤딩만 있는 청크가 다음 청크 앞에 붙는다."""
    markdown = "# A\n## B\n본문 w1.\n## C\n본문 w2.\n"
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.RULE))

    assert not has_bodyless_text_chunk(result)
    holder = next(c for c in text_chunks(result) if "## B" in c.text)
    assert holder.text.startswith("# A")


@pytest.mark.req("REQ-RAG-2.1.5")
@pytest.mark.req("REQ-RAG-2.1.6")
@pytest.mark.req("REQ-RAG-2.1.3")
def test_rule_hash_in_code_not_boundary(settings: Settings) -> None:
    """[REQ-RAG-2.1.5] 코드 블록 안 `#` 줄은 경계도 헤딩 경로도 아니다."""
    block = "```bash\n# 주석\necho w1\n```"
    markdown = f"## 예제\n\n{block}\n\n[[minerva:table:t1 | 표]]\n"
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.RULE))

    holders = [c for c in text_chunks(result) if block in c.text]
    assert len(holders) == 1
    assets = asset_chunks(result)
    assert len(assets) == 1
    assert assets[0].heading_path == ("예제",)


@pytest.mark.req("REQ-RAG-2.3.3")
def test_rule_fallback_flag_false(settings: Settings) -> None:
    """[REQ-RAG-2.3.3] 규칙 분할 결과의 fallback_used는 False다."""
    fake = FakeModelHub(boundary=by_headings)

    result = run(make_chunker(fake, settings).split(RULE_DOC, ChunkingMode.RULE))

    assert result.fallback_used is False
