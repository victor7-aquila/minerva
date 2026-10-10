"""분할 LLM 입력 한도 사전 분할(REQ-RAG-2.5.2) 테스트."""

import pytest

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import Settings

from .fakes import (
    FakeModelHub,
    MakeSettings,
    assert_verbatim,
    count_w,
    count_words,
    document_lines,
    is_heading_line,
    make_chunker,
    run,
    text_chunks,
    whole_part,
)

MODES = pytest.mark.parametrize(
    "mode", [ChunkingMode.SEMANTIC, ChunkingMode.RULE], ids=["semantic", "rule"]
)

# 낱말 20개(= 20w)짜리 본문
W20 = " ".join(f"w{i}" for i in range(1, 21))


def _first_filled(lines: list[str]) -> str:
    """부분의 첫 번째 비어 있지 않은 줄을 돌려준다."""
    return next(line for line in lines if line.strip())


@pytest.mark.req("REQ-RAG-2.5.2.1")
def test_no_presplit_within_limit(settings: Settings) -> None:
    """[REQ-RAG-2.5.2.1] 입력 한도를 넘지 않으면 문서 전체를 한 번에 보낸다."""
    fake = FakeModelHub(boundary=whole_part)

    run(make_chunker(fake, settings).split("# 제목\n\n본문 w1.\n", ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) == 1


@pytest.mark.req("REQ-RAG-2.5.2.1")
@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_presplit_at_headings(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.5.2.1] 한도를 넘는 문서는 헤딩 앞에서 나눠 여러 번 보내고 입력은 한도 이하다."""
    markdown = f"# 문서\n\n## 절1\n\n{W20}.\n\n## 절2\n\n{W20}.\n\n## 절3\n\n{W20}.\n"
    settings = make_settings(max_input=30, chunk_max=29)
    fake = FakeModelHub(boundary=whole_part)

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) >= 2
    for call in fake.boundary_calls:
        assert is_heading_line(_first_filled(document_lines(call.prompt)))
        assert count_w(call.prompt) <= 30
    assert_verbatim([c.text for c in text_chunks(result)], markdown)


@pytest.mark.req("REQ-RAG-2.5.2.1")
@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_presplit_falls_to_paragraphs(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.5.2.1] 하위 헤딩이 없으면 문단 경계에서 나눈다."""
    paragraphs = [f"문단 {name} {W20}." for name in ("하나", "둘", "셋")]
    markdown = "## 절\n\n" + "\n\n".join(paragraphs) + "\n"
    settings = make_settings(max_input=30, chunk_max=29)
    fake = FakeModelHub(boundary=whole_part)

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    assert len(fake.boundary_calls) >= 2
    for call in fake.boundary_calls:
        assert count_w(call.prompt) <= 30
        head = _first_filled(document_lines(call.prompt))
        if head != "## 절":
            assert markdown[: markdown.index(head)].endswith("\n\n")
    assert_verbatim([c.text for c in text_chunks(result)], markdown)


def _calibrated_settings(make_settings: MakeSettings) -> tuple[Settings, int]:
    """작은 문서의 프롬프트 낱말 수 최댓값(지시문 몫)을 재서 입력 한도를 60 크게 잡는다."""
    base = make_settings()
    probe = FakeModelHub(boundary=whole_part, counter=count_words)
    chunker = make_chunker(probe, base)
    for mode in (ChunkingMode.SEMANTIC, ChunkingMode.RULE):
        run(chunker.split("# 제목\n\n짧은 본문.\n", mode))
    overhead = max(count_words(call.prompt) for call in probe.calls)
    limit = overhead + 60
    return make_settings(max_input=limit, chunk_max=10), limit


def _section(number: int, extra: str = "") -> str:
    """문단 셋이 든 절 하나를 만든다(문단은 6낱말, 한 줄)."""
    paragraphs = "\n\n".join(f"절{number} 문단{j} 단어 단어 단어 단어." for j in range(1, 4))
    return f"## 절{number}\n\n{paragraphs}\n\n{extra}"


@pytest.mark.req("REQ-RAG-2.5.2.2")
@MODES
def test_all_inputs_within_limit(make_settings: MakeSettings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.5.2.2] 어떤 문서를 나누든 LLM으로 보낸 모든 입력의 토큰 수가 한도 이하다."""
    settings, limit = _calibrated_settings(make_settings)
    markdown = (
        _section(1, "[[minerva:table:t1 | 표 하나]]\n\n")
        + _section(2, "```python\na=1\nb=2\nc=3\n```\n\n")
        + _section(3)
        + _section(4, "[[minerva:image:i1 | 그림 하나]]\n\n")
        + _section(5)
        + _section(6)
    )
    fake = FakeModelHub(boundary=whole_part, counter=count_words)

    result = run(make_chunker(fake, settings).split(markdown, mode))

    assert fake.calls
    assert all(count_words(call.prompt) <= limit for call in fake.calls)
    if mode is ChunkingMode.SEMANTIC:
        assert len(fake.boundary_calls) >= 2
    assert_verbatim([c.text for c in text_chunks(result)], markdown)


@pytest.mark.req("REQ-RAG-2.5.2.2")
@MODES
def test_oversize_unit_not_sent(make_settings: MakeSettings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.5.2.2] 한도를 넘는 단일 단위는 경계 LLM에 보내지 않고 청크 하나로 둔다."""
    settings, limit = _calibrated_settings(make_settings)
    long_line = " ".join(["장문"] * 100)
    markdown = f"## 절\n\n{long_line}\n\n## 둘째\n\n짧은 문단.\n"
    fake = FakeModelHub(boundary=whole_part, counter=count_words)

    result = run(make_chunker(fake, settings).split(markdown, mode))

    assert all(count_words(call.prompt) <= limit for call in fake.calls)
    assert all(long_line not in call.prompt for call in fake.boundary_calls)
    holders = [c for c in text_chunks(result) if long_line in c.text]
    assert len(holders) == 1
    if mode is ChunkingMode.SEMANTIC:
        assert result.fallback_used is False
