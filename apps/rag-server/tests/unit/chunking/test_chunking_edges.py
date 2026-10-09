"""헤딩 합치기 퇴화 사례와 헤딩·코드 블록 정의(REQ-RAG-2.1.2, 2.1.3, 2.1.5, 2.1.8, 2.1.9) 테스트."""

import pytest

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import Settings

from .fakes import (
    FakeModelHub,
    by_headings,
    has_bodyless_text_chunk,
    make_chunker,
    run,
    text_chunks,
    whole_part,
)

MODES = pytest.mark.parametrize(
    "mode", [ChunkingMode.SEMANTIC, ChunkingMode.RULE], ids=["semantic", "rule"]
)


@pytest.mark.req("REQ-RAG-2.1.8")
@MODES
def test_trailing_heading_merged_into_previous(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.1.8] 문서 끝의 헤딩만 있는 청크는 바로 앞 청크 뒤에 붙는다."""
    fake = FakeModelHub(boundary=by_headings)

    result = run(make_chunker(fake, settings).split("# A\n\n본문 w1.\n\n## 끝\n", mode))

    chunks = text_chunks(result)
    assert not has_bodyless_text_chunk(result)
    assert len(chunks) == 1
    assert "본문 w1." in chunks[0].text
    assert chunks[0].text.endswith("## 끝")


@pytest.mark.req("REQ-RAG-2.1.9")
@pytest.mark.req("REQ-RAG-2.1.3")
@pytest.mark.req("REQ-RAG-2.1.2")
@MODES
def test_headings_only_document(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.1.9] 헤딩뿐인 문서는 본문 청크 하나이고 경로는 마지막 헤딩까지다."""
    markdown = "# A\n## B\n"
    fake = FakeModelHub(boundary=whole_part)

    result = run(make_chunker(fake, settings).split(markdown, mode))

    (chunk,) = text_chunks(result)
    assert chunk.text == markdown.strip()
    assert chunk.heading_path == ("A", "B")
    assert chunk.title
    assert chunk.summary


@pytest.mark.req("REQ-RAG-2.1.3")
def test_skipped_heading_level_path(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] `# A` 다음 바로 `### C`가 오면 그 아래 본문의 경로는 (A, C)다."""
    fake = FakeModelHub()

    result = run(
        make_chunker(fake, settings).split("# A\n\n### C\n\n본문 w1.\n", ChunkingMode.RULE)
    )

    holder = next(c for c in text_chunks(result) if "본문 w1." in c.text)
    assert holder.heading_path == ("A", "C")


@pytest.mark.req("REQ-RAG-2.1.3")
@MODES
def test_heading_path_pops_on_sibling_and_ancestor(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.1.3] 형제·상위 헤딩이 오면 경로가 되돌아간다: (A,B) -> (A,C) -> (D,)."""
    markdown = "# A\n\n## B\n\n본문 w1.\n\n## C\n\n본문 w2.\n\n# D\n\n본문 w3.\n"
    fake = FakeModelHub(boundary=by_headings)

    result = run(make_chunker(fake, settings).split(markdown, mode))

    chunks = text_chunks(result)
    paths = {w: next(c for c in chunks if w in c.text).heading_path for w in ("w1", "w2", "w3")}
    assert paths == {"w1": ("A", "B"), "w2": ("A", "C"), "w3": ("D",)}


@pytest.mark.req("REQ-RAG-2.1.3")
def test_heading_path_pops_deeper_levels(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] 깊은 헤딩 뒤에 얕은 헤딩이 오면 깊은 헤딩이 빠진다: (A,X) -> (A,Y)."""
    markdown = "# A\n\n### X\n\n본문 w1.\n\n## Y\n\n본문 w2.\n"
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.RULE))

    chunks = text_chunks(result)
    assert next(c for c in chunks if "w1" in c.text).heading_path == ("A", "X")
    assert next(c for c in chunks if "w2" in c.text).heading_path == ("A", "Y")


@pytest.mark.req("REQ-RAG-2.1.3")
@pytest.mark.req("REQ-RAG-2.1.5")
def test_setext_and_tilde_fence(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] 밑줄(Setext) 제목은 헤딩이 아니고 `~~~` 코드 블록 안 `#`은 경계가 아니다."""
    block = "~~~\n# 안\n~~~"
    markdown = f"제목\n===\n\n본문 w1.\n\n{block}\n"
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.RULE))

    (chunk,) = text_chunks(result)
    assert chunk.heading_path == ()
    assert block in chunk.text


@pytest.mark.req("REQ-RAG-2.1.3")
def test_heading_indent_rules(settings: Settings) -> None:
    """[REQ-RAG-2.1.3] 0~3칸 들여쓴 `#`은 헤딩, 4칸은 아니며 닫는 `#` 열은 뗀다."""
    markdown = "   # 셋칸\n\n본문 w1.\n\n    # 넷칸\n\n본문 w2.\n\n## 닫는 열 ##\n\n본문 w3.\n"
    fake = FakeModelHub()

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.RULE))

    chunks = text_chunks(result)
    second = next(c for c in chunks if "본문 w2." in c.text)
    third = next(c for c in chunks if "본문 w3." in c.text)
    assert second.heading_path == ("셋칸",)
    assert third.heading_path == ("셋칸", "닫는 열")
