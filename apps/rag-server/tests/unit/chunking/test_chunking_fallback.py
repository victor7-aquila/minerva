"""대체 분할(REQ-RAG-2.3)과 경계 검증 테스트."""

import pytest

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import ChunkingResult, Settings, find_placeholders

from .fakes import (
    BoundaryResponder,
    FakeModelHub,
    MakeSettings,
    assert_verbatim,
    by_headings,
    dropping,
    first_line,
    is_heading_line,
    make_chunker,
    responder,
    run,
    scripted,
    starting_at,
    text_chunks,
    whole_part,
)

FB_DOC = (
    "## 하나\n\n하나 문단 w1.\n\n"
    "## 둘\n\n둘 문단 w2.\n\n[[minerva:table:t1 | 표]]\n\n"
    "## 셋\n\n셋 문단 w3.\n"
)

# 본문 줄 하나("빠질줄")가 든 문서. 줄 번호: 1 헤딩, 3~4 본문, 6 헤딩, 8 본문
GAP_DOC = "# 문서\n\n첫 줄 w1.\n빠질줄 w2.\n\n## 절\n\n셋째 줄 w3.\n"

# 줄 번호: 1 헤딩, 3~4 본문, 5 빈 줄, 6 헤딩, 8 본문, 9 빈 줄(끝)
OVERLAP_DOC = "# 문서\n\n첫 줄 w1.\n둘째 줄 w2.\n\n## 절\n\n셋째 줄 w3.\n"

CODE_DOC = "# 설치\n\n설치 w1.\n\n```bash\n# 주석 줄\n\nrun w2\n```\n\n## 끝\n\n끝 문단 w3.\n"
CODE_BLOCK = "```bash\n# 주석 줄\n\nrun w2\n```"

BLANK_DOC = (
    "# 설치\n\n설치 개요 문단 w1.\n\n"
    "## Docker\n\nDocker 문단 w2.\n\n[[minerva:table:t1 | 포트 표]]\n\n"
    "## 환경변수\n\n환경변수 문단 w3.\n"
)


def _placeholders_once(result: ChunkingResult, markdown: str) -> bool:
    """본문 청크 전체의 자리표시 목록이 입력과 같은지 본다."""
    joined = "\n".join(c.text for c in text_chunks(result))
    return [p.raw for p in find_placeholders(joined)] == [
        p.raw for p in find_placeholders(markdown)
    ]


@pytest.mark.req("REQ-RAG-2.3.1")
def test_retry_then_success(settings: Settings) -> None:
    """[REQ-RAG-2.3.1] 자리표시를 빠뜨린 첫 응답 뒤 둘째 응답대로 나뉘고 fallback_used는 False다."""
    fake = FakeModelHub(boundary=scripted(dropping("[[minerva:"), by_headings))

    result = run(make_chunker(fake, settings).split(FB_DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert len(fake.boundary_calls) == 2
    assert [first_line(c.text) for c in chunks] == ["## 하나", "## 둘", "## 셋"]
    assert [c.title for c in chunks] == ["경계 제목 1", "경계 제목 2", "경계 제목 3"]
    assert result.fallback_used is False


@pytest.mark.req("REQ-RAG-2.3.2")
@pytest.mark.req("REQ-RAG-2.2.1")
@pytest.mark.parametrize("retries", [0, 2])
def test_fallback_after_retries(make_settings: MakeSettings, retries: int) -> None:
    """[REQ-RAG-2.3.2] 횟수 + 1번 모두 실패하면 호출이 멈추고 헤딩 줄 앞 경계로 나뉜다."""
    settings = make_settings(retries=retries)
    fake = FakeModelHub(boundary=dropping("[[minerva:"))

    result = run(make_chunker(fake, settings).split(FB_DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert len(fake.boundary_calls) == retries + 1
    assert all(is_heading_line(first_line(c.text)) for c in chunks)
    assert result.fallback_used is True
    assert _placeholders_once(result, FB_DOC)


@pytest.mark.req("REQ-RAG-2.1.2")
def test_fallback_chunks_have_titles(settings: Settings) -> None:
    """[REQ-RAG-2.1.2] 대체 분할로 만든 청크도 제목·요약을 갖는다."""
    fake = FakeModelHub(boundary=dropping("[[minerva:"))

    result = run(make_chunker(fake, settings).split(FB_DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert chunks
    assert all(c.title == "규칙 제목" and c.summary == "규칙 요약" for c in chunks)


@pytest.mark.req("REQ-RAG-2.3.2")
@pytest.mark.req("REQ-RAG-2.3.3")
def test_fallback_only_failing_part(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.3.2] 검증에 실패한 부분만 규칙 분할로 대신하고 fallback_used는 True다."""
    words = " ".join(f"w{i}" for i in range(1, 21))
    markdown = (
        f"## 하나\n\n{words}.\n\n## 둘\n\n{words}.\n\n[[minerva:table:t1 | 표]]\n\n"
        f"## 셋\n\n{words}.\n"
    )
    settings = make_settings(max_input=30, chunk_max=29)

    def pick(lines: list[str], attempt: int) -> str:
        has_placeholder = any("[[minerva:" in line for line in lines)
        responder_ = dropping("[[minerva:") if has_placeholder else whole_part
        return responder_(lines, attempt)

    fake = FakeModelHub(boundary=pick)

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    titles = {first_line(c.text): c.title for c in text_chunks(result)}
    assert result.fallback_used is True
    assert (titles["## 하나"] or "").startswith("경계 제목")
    assert titles["## 둘"] == "규칙 제목"
    assert (titles["## 셋"] or "").startswith("경계 제목")


@pytest.mark.req("REQ-RAG-2.3.3")
def test_fallback_flag_false_when_valid(settings: Settings) -> None:
    """[REQ-RAG-2.3.3] 검증을 통과하면 fallback_used는 False다."""
    fake = FakeModelHub(boundary=by_headings)

    result = run(make_chunker(fake, settings).split(FB_DOC, ChunkingMode.SEMANTIC))

    assert result.fallback_used is False


@pytest.mark.req("REQ-RAG-2.3.1")
def test_body_line_gap_triggers_retry(settings: Settings) -> None:
    """[REQ-RAG-2.3.1] 본문 줄을 빠뜨린 첫 응답은 다시 시도하고 둘째 응답대로 나뉜다."""
    fake = FakeModelHub(boundary=scripted(dropping("빠질줄"), by_headings))

    result = run(make_chunker(fake, settings).split(GAP_DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert len(fake.boundary_calls) == 2
    assert [c.title for c in chunks] == ["경계 제목 1", "경계 제목 2"]
    assert result.fallback_used is False
    assert_verbatim([c.text for c in chunks], GAP_DOC)


@pytest.mark.req("REQ-RAG-2.3.1")
@pytest.mark.parametrize(
    "bad",
    [
        responder(lambda lines: [(1, 4), (4, len(lines))]),
        responder(lambda lines: [(5, len(lines)), (1, 4)]),
    ],
    ids=["overlap", "reversed"],
)
def test_overlap_or_reversed_triggers_retry(settings: Settings, bad: BoundaryResponder) -> None:
    """[REQ-RAG-2.3.1] 줄이 겹치거나 차례가 바뀐 첫 응답은 경계 검증 실패로 다시 시도한다."""
    fake = FakeModelHub(boundary=scripted(bad, by_headings))

    result = run(make_chunker(fake, settings).split(OVERLAP_DOC, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 2
    assert result.fallback_used is False
    assert_verbatim([c.text for c in text_chunks(result)], OVERLAP_DOC)


@pytest.mark.req("REQ-RAG-2.3.1")
def test_code_block_boundary_triggers_retry(settings: Settings) -> None:
    """[REQ-RAG-2.3.1] 코드 블록 안에 경계를 둔 첫 응답은 다시 시도해 코드 블록이 한 청크에 든다."""
    fake = FakeModelHub(
        boundary=scripted(starting_at(lambda line: line.startswith("# 주석")), by_headings)
    )

    result = run(make_chunker(fake, settings).split(CODE_DOC, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 2
    assert result.fallback_used is False
    assert len([c for c in text_chunks(result) if CODE_BLOCK in c.text]) == 1


@pytest.mark.req("REQ-RAG-2.3.1")
def test_closing_fence_boundary_triggers_retry(settings: Settings) -> None:
    """[REQ-RAG-2.3.1] 닫는 펜스 줄에서 시작하는 경계도 코드 블록 중간이라 다시 시도한다."""
    fake = FakeModelHub(
        boundary=scripted(starting_at(lambda line: line.strip() == "```"), by_headings)
    )

    result = run(make_chunker(fake, settings).split(CODE_DOC, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 2
    assert result.fallback_used is False
    assert len([c for c in text_chunks(result) if CODE_BLOCK in c.text]) == 1


@pytest.mark.req("REQ-RAG-2.3.1")
def test_blank_line_gap_is_not_failure(settings: Settings) -> None:
    """[REQ-RAG-2.3.1] 빈 줄만 빠진 응답은 실패가 아니라 응답대로 나뉜다."""
    rows = BLANK_DOC.split("\n")
    assert rows[3] == ""  # 4번 줄이 빈 줄이어야 아래 범위가 빈 줄만 덮지 않는다
    fake = FakeModelHub(boundary=responder(lambda lines: [(1, 3), (5, len(lines))]))

    result = run(make_chunker(fake, settings).split(BLANK_DOC, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 1
    assert result.fallback_used is False
    assert [c.text for c in text_chunks(result)] == [
        "\n".join(rows[0:3]).strip(),
        "\n".join(rows[4:]).strip(),
    ]


@pytest.mark.req("REQ-RAG-2.3.2")
@pytest.mark.req("REQ-RAG-2.3.3")
def test_boundary_failure_fallback(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.3.2] 본문 줄을 늘 빠뜨리면 횟수를 다 쓴 뒤 헤딩 줄 앞 경계로 대체 분할한다."""
    settings = make_settings(retries=1)
    fake = FakeModelHub(boundary=dropping("빠질줄"))

    result = run(make_chunker(fake, settings).split(GAP_DOC, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 2
    assert result.fallback_used is True
    assert all(is_heading_line(first_line(c.text)) for c in text_chunks(result))


@pytest.mark.req("REQ-RAG-2.3.1")
def test_heading_line_gap_triggers_retry(settings: Settings) -> None:
    """[REQ-RAG-2.3.1] 헤딩 줄만 빠진 응답도 경계 검증 실패라 다시 시도한다."""
    # 6번 줄(`## 절`)만 빠뜨린다
    missing_heading = responder(lambda lines: [(1, 5), (7, len(lines))])
    fake = FakeModelHub(boundary=scripted(missing_heading, by_headings))

    result = run(make_chunker(fake, settings).split(GAP_DOC, ChunkingMode.SEMANTIC))

    chunks = text_chunks(result)
    assert len(fake.boundary_calls) == 2
    assert result.fallback_used is False
    assert any("## 절" in c.text for c in chunks)
    assert_verbatim([c.text for c in chunks], GAP_DOC)
