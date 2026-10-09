"""의미 단위 분할(REQ-RAG-2.1.1~2.1.5, 2.1.7) 테스트."""

import json
from typing import Any

import pytest

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import (
    ChunkingFailedError,
    MinervaError,
    ModelUnavailableError,
    PromptTooLongError,
    Settings,
)
from minerva_rag.resource import LlmRole

from .fakes import (
    FakeModelHub,
    GenerationError,
    assert_verbatim,
    by_headings,
    has_bodyless_text_chunk,
    make_chunker,
    raw_chunk,
    raw_response,
    responder,
    run,
    scripted,
    starting_at,
    text_chunks,
    whole_part,
)

DOC = (
    "# 설치\n\n설치 개요 문단 w1.\n\n"
    "## Docker\n\nDocker 문단 w2.\n\n[[minerva:table:t1 | 포트 표]]\n\n"
    "## 환경변수\n\n환경변수 문단 w3.\n"
)

CODE_DOC = "# 설치\n\n설치 w1.\n\n```bash\n# 주석 줄\n\nrun w2\n```\n\n## 끝\n\n끝 문단 w3.\n"
CODE_BLOCK = "```bash\n# 주석 줄\n\nrun w2\n```"

SMALL_DOC = "# 설치\n\n본문 w1.\n"


def _one(chunk: dict[str, Any]) -> str:
    """청크 하나짜리 경계 응답 원문을 만든다."""
    return json.dumps({"chunks": [chunk]}, ensure_ascii=False)


@pytest.mark.req("REQ-RAG-2.1.1")
def test_follows_llm_boundaries(settings: Settings) -> None:
    """[REQ-RAG-2.1.1] LLM이 정한 경계대로 본문 청크가 만들어지고 원문과 같다."""
    rows = DOC.split("\n")
    fake = FakeModelHub(
        boundary=responder(lambda lines: [(1, 7), (8, 10), (11, len(lines))]),
    )

    result = run(make_chunker(fake, settings).split(DOC, ChunkingMode.SEMANTIC))

    expected = [
        "\n".join(rows[0:7]).strip(),
        "\n".join(rows[7:10]).strip(),
        "\n".join(rows[10:]).strip(),
    ]
    chunks = text_chunks(result)
    assert [c.text for c in chunks] == expected
    assert_verbatim([c.text for c in chunks], DOC)
    assert fake.calls
    assert all(call.role is LlmRole.CHUNKING for call in fake.calls)


@pytest.mark.req("REQ-RAG-2.1.1")
@pytest.mark.parametrize(
    "response",
    ["이건 JSON이 아니다", '{"result": []}', "[]"],
    ids=["not-json", "no-chunks-key", "not-object"],
)
def test_unparseable_response_fails(settings: Settings, response: str) -> None:
    """[REQ-RAG-2.1.1] 정해진 형식이 아닌 응답은 다시 시도하지 않고 ChunkingFailedError다."""
    fake = FakeModelHub(boundary=raw_response(response))

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split(SMALL_DOC, ChunkingMode.SEMANTIC))

    assert info.value.location is not None
    assert len(fake.boundary_calls) == 1


@pytest.mark.req("REQ-RAG-2.1.1")
@pytest.mark.req("REQ-RAG-2.1.2")
@pytest.mark.parametrize(
    "response",
    [
        '{"chunks": []}',
        _one(raw_chunk(0, 3)),
        _one(raw_chunk(1, 999)),
        _one(raw_chunk(1, 3, title="")),
        _one(raw_chunk(1, 3, summary="  ")),
    ],
    ids=["no-chunk", "line-zero", "line-out-of-range", "empty-title", "blank-summary"],
)
def test_unparseable_detail_fails(settings: Settings, response: str) -> None:
    """[REQ-RAG-2.1.1] 청크가 없거나 원문에 없는 위치이거나 제목·요약이 빈 응답은 즉시 실패한다."""
    fake = FakeModelHub(boundary=raw_response(response))

    with pytest.raises(ChunkingFailedError):
        run(make_chunker(fake, settings).split(SMALL_DOC, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 1


@pytest.mark.req("REQ-RAG-2.1.1")
def test_failure_location_heading_path(settings: Settings) -> None:
    """[REQ-RAG-2.1.1] 경계 호출 실패의 위치에 그 부분의 헤딩 경로가 담기고 자리표시 ID는 없다."""
    fake = FakeModelHub(boundary=raw_response("x"))

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split(SMALL_DOC, ChunkingMode.SEMANTIC))

    location = info.value.location
    assert location is not None
    assert location.heading_path == ("설치",)
    assert location.placeholder_id is None


@pytest.mark.req("REQ-RAG-2.1.1")
def test_prompt_too_long_becomes_chunking_failed(settings: Settings) -> None:
    """[REQ-RAG-2.1.1] PromptTooLongError는 ChunkingFailedError로 바뀌고 다시 시도하지 않는다."""
    fake = FakeModelHub(error=lambda call: PromptTooLongError() if call.is_boundary else None)

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split(SMALL_DOC, ChunkingMode.SEMANTIC))

    assert info.value.location is not None
    assert len(fake.boundary_calls) == 1


@pytest.mark.req("REQ-RAG-2.1.1")
def test_model_unavailable_propagates(settings: Settings) -> None:
    """[REQ-RAG-2.1.1] Ollama 연결 실패(ModelUnavailableError)는 그대로 난다."""
    fake = FakeModelHub(error=lambda call: ModelUnavailableError())

    with pytest.raises(ModelUnavailableError) as info:
        run(make_chunker(fake, settings).split(SMALL_DOC, ChunkingMode.SEMANTIC))

    assert not isinstance(info.value, ChunkingFailedError)


@pytest.mark.req("REQ-RAG-2.1.1")
def test_generation_error_becomes_chunking_failed(settings: Settings) -> None:
    """[REQ-RAG-2.1.1] MinervaError가 아닌 생성 실패는 ChunkingFailedError가 되고 재시도 없다."""
    fake = FakeModelHub(error=lambda call: GenerationError() if call.is_boundary else None)

    with pytest.raises(ChunkingFailedError) as info:
        run(make_chunker(fake, settings).split(SMALL_DOC, ChunkingMode.SEMANTIC))

    assert isinstance(info.value, MinervaError)
    assert info.value.location is not None
    assert len(fake.boundary_calls) == 1


@pytest.mark.req("REQ-RAG-2.1.1")
@pytest.mark.parametrize("markdown", ["", "  \n\n\t\n"], ids=["empty", "blank"])
@pytest.mark.parametrize("mode", list(ChunkingMode))
def test_empty_document(settings: Settings, markdown: str, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.1.1] 비었거나 공백뿐인 문서는 LLM을 부르지 않고 빈 결과를 돌려준다."""
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(markdown, mode))

    assert result.chunks == ()
    assert result.fallback_used is False
    assert fake.calls == []


@pytest.mark.req("REQ-RAG-2.1.2")
def test_semantic_titles_from_response(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 의미 단위 분할 청크의 제목·요약은 경계 응답의 값이다."""
    fake = FakeModelHub(
        boundary=responder(lambda lines: [(1, 7), (8, 10), (11, len(lines))]),
    )

    result = run(make_chunker(fake, settings).split(DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert [c.title for c in chunks] == [f"경계 제목 {i}" for i in (1, 2, 3)]
    assert [c.summary for c in chunks] == [f"경계 요약 {i}" for i in (1, 2, 3)]


@pytest.mark.req("REQ-RAG-2.1.3")
def test_heading_path_nested(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] `# A` 아래 `## B` 아래 본문으로 된 청크의 경로는 (A, B)다."""
    fake = FakeModelHub(boundary=whole_part)

    result = run(
        make_chunker(fake, settings).split("# A\n\n## B\n\n본문 w1.\n", ChunkingMode.SEMANTIC)
    )

    chunks = text_chunks(result)
    assert len(chunks) == 1
    assert chunks[0].heading_path == ("A", "B")


@pytest.mark.req("REQ-RAG-2.1.3")
def test_heading_path_multi_section(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] 여러 절에 걸친 청크의 경로는 첫 본문 줄이 속한 절의 경로다."""
    markdown = "# A\n\n## B\n\n본문 b w1.\n\n## C\n\n본문 c w2.\n"
    fake = FakeModelHub(boundary=whole_part)

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert len(chunks) == 1
    assert chunks[0].heading_path == ("A", "B")


@pytest.mark.req("REQ-RAG-2.1.3")
def test_heading_path_before_first_heading(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] 첫 헤딩 앞의 본문은 빈 경로다."""
    markdown = "머리말 w1.\n\n# A\n\n본문 w2.\n"
    fake = FakeModelHub(boundary=by_headings)

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert chunks[0].heading_path == ()
    assert chunks[1].heading_path == ("A",)


@pytest.mark.req("REQ-RAG-2.1.4")
def test_text_order_increases(settings: Settings) -> None:
    """[REQ-RAG-2.1.4] 본문 청크의 order가 문서에 나오는 차례대로 커진다."""
    fake = FakeModelHub(boundary=by_headings)

    result = run(make_chunker(fake, settings).split(DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    orders = [c.order for c in chunks]
    assert len(chunks) == 3
    assert all(a < b for a, b in zip(orders, orders[1:], strict=False))
    # order 차례로 놓은 청크가 문서 차례와 같다
    assert_verbatim([c.text for c in chunks], DOC)


@pytest.mark.req("REQ-RAG-2.1.5")
def test_code_block_kept_whole(settings: Settings) -> None:
    """[REQ-RAG-2.1.5] 코드 블록 중간에 경계를 둔 응답은 다시 시도해 코드 블록이 한 청크에 든다."""
    fake = FakeModelHub(
        boundary=scripted(starting_at(lambda line: line.startswith("# 주석")), by_headings),
    )

    result = run(make_chunker(fake, settings).split(CODE_DOC, ChunkingMode.SEMANTIC))

    holders = [c for c in text_chunks(result) if CODE_BLOCK in c.text]
    assert len(holders) == 1


@pytest.mark.req("REQ-RAG-2.1.7")
def test_heading_only_chunk_merged(settings: Settings) -> None:
    """[REQ-RAG-2.1.7] 헤딩만 있는 청크는 다음 청크 앞에 붙고 제목은 받는 청크의 것이다."""
    markdown = "# A\n\n## B\n\n본문 w1.\n"
    fake = FakeModelHub(boundary=responder(lambda lines: [(1, 2), (3, len(lines))]))

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert not has_bodyless_text_chunk(result)
    assert len(chunks) == 1
    assert chunks[0].text.startswith("# A")
    assert "## B" in chunks[0].text
    assert "본문 w1." in chunks[0].text
    assert chunks[0].title == "경계 제목 2"
    assert chunks[0].summary == "경계 요약 2"
