"""크기 상한 재분할(REQ-RAG-2.5.1, 2.5.3, 2.4.4) 테스트.

토큰은 `count_w`('w숫자' 낱말 수)로 센다. 상한은 10이고 입력 한도는 사전 분할이 없을 만큼 크다.
"""

import pytest

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import ChunkingResult, Settings, find_placeholders

from .fakes import (
    FakeModelHub,
    MakeSettings,
    assert_verbatim,
    asset_chunks,
    count_w,
    first_line,
    group_by_split,
    is_heading_line,
    make_chunker,
    run,
    text_chunks,
    whole_part,
)

CHUNK_MAX = 10

# 합 14w, 하위 절마다 6w. 하위 헤딩 경계에서만 나뉘어야 한다
BIG_DOC = (
    "## 큰 절\n\n도입 w1 w2.\n\n"
    "### 가\n\n가 문단 w3 w4 w5.\n\n가 둘째 w6 w7 w8.\n\n"
    "### 나\n\n나 문단 w9 w10 w11.\n\n나 둘째 w12 w13 w14.\n"
)

# 하위 헤딩이 없고 문단마다 6w
PARA_DOC = (
    "## 절\n\n문단 하나 w1 w2 w3 w4 w5 w6.\n\n문단 둘 w7 w8 w9 w10 w11 w12.\n\n"
    "문단 셋 w13 w14 w15 w16 w17 w18.\n"
)

# 한 문단에 문장 4개(각 4w, 합 16w) + 마침표 없는 15w 문장 한 줄
LONG_SENTENCE = " ".join(f"w{i}" for i in range(17, 32))
SENTENCE_DOC = (
    "## 절\n\n"
    "문장 하나 w1 w2 w3 w4. 문장 둘 w5 w6 w7 w8. "
    "문장 셋 w9 w10 w11 w12. 문장 넷 w13 w14 w15 w16.\n\n"
    f"{LONG_SENTENCE}\n"
)

# 자리표시 설명 안에도 문장 경계 후보(`. `)와 'w숫자' 낱말이 있다
# ★ 앞 문장 8w + 자리표시 앞부분 0w = 8 <= 10 < 8 + 뒷부분 3w 이므로, `. `로만 나누고 묶는 구현은
# 자리표시 한가운데를 반드시 자르게 된다
PLACEHOLDER_DOC = (
    "## 절\n\n문장 하나 w1 w2 w3 w4 w5 w6 w7 w8. "
    "구성은 [[minerva:image:i1 | 구성도. 서버 w9 w10 배치]] 와 같다 w11. "
    "문장 셋 w12 w13. 문장 넷 w14.\n"
)


def _split(settings: Settings, markdown: str, mode: ChunkingMode) -> ChunkingResult:
    """whole_part 가짜로 나눈다."""
    fake = FakeModelHub(boundary=whole_part)
    return run(make_chunker(fake, settings).split(markdown, mode))


@pytest.fixture
def small(make_settings: MakeSettings) -> Settings:
    """청크 상한 10, 입력 한도 1000 설정이다."""
    return make_settings(chunk_max=CHUNK_MAX, max_input=1000)


@pytest.mark.req("REQ-RAG-2.5.1.1")
def test_resplit_at_subheadings_only(small: Settings) -> None:
    """[REQ-RAG-2.5.1.1] 하위 헤딩이 있는 큰 청크는 하위 헤딩 경계에서만 나뉘고 상한 이하다."""
    result = _split(small, BIG_DOC, ChunkingMode.SEMANTIC)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    assert all(is_heading_line(first_line(p.text)) for p in pieces[1:])
    assert all(count_w(p.text) <= CHUNK_MAX for p in pieces)


@pytest.mark.req("REQ-RAG-2.5.1.1")
def test_resplit_at_paragraphs(small: Settings) -> None:
    """[REQ-RAG-2.5.1.1] 하위 헤딩이 없으면 문단 경계에서 나뉜다."""
    result = _split(small, PARA_DOC, ChunkingMode.RULE)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    for piece in pieces[1:]:
        assert PARA_DOC[: PARA_DOC.index(piece.text)].endswith("\n\n")
    assert all(count_w(p.text) <= CHUNK_MAX for p in pieces)


@pytest.mark.req("REQ-RAG-2.5.1.1")
def test_resplit_at_sentences_long_sentence_kept(small: Settings) -> None:
    """[REQ-RAG-2.5.1.1] 문단으로 안 되면 문장 경계로 나누고, 상한을 넘는 문장은 한 조각이다."""
    result = _split(small, SENTENCE_DOC, ChunkingMode.RULE)

    pieces = text_chunks(result)
    long_pieces = [p for p in pieces if LONG_SENTENCE in p.text]
    assert len(long_pieces) == 1
    assert long_pieces[0].text.strip() == LONG_SENTENCE
    others = [p for p in pieces if p is not long_pieces[0]]
    assert len(others) >= 2
    assert all(count_w(p.text) <= CHUNK_MAX for p in others)


@pytest.mark.req("REQ-RAG-2.5.1.2")
@pytest.mark.req("REQ-RAG-2.1.2")
@pytest.mark.req("REQ-RAG-2.1.4")
def test_pieces_keep_path_title_order(small: Settings) -> None:
    """[REQ-RAG-2.5.1.2] 같은 청크의 조각은 헤딩 경로·제목·요약·order를 그대로 갖는다."""
    result = _split(small, BIG_DOC, ChunkingMode.SEMANTIC)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    assert {p.heading_path for p in pieces} == {("큰 절",)}
    assert {p.title for p in pieces} == {"경계 제목 1"}
    assert {p.summary for p in pieces} == {"경계 요약 1"}
    assert len({p.order for p in pieces}) == 1


@pytest.mark.req("REQ-RAG-2.5.1.3")
def test_split_index_and_total(small: Settings) -> None:
    """[REQ-RAG-2.5.1.3] 조각은 1부터 split_total까지 번호를 갖고, 안 나뉜 청크는 None이다."""
    markdown = PARA_DOC + "\n## 작은 절\n\n작은 문단 w19.\n"

    result = _split(small, markdown, ChunkingMode.RULE)

    groups = group_by_split(result)
    assert len(groups) == 1
    (pieces,) = groups.values()
    assert [p.split_index for p in pieces] == list(range(1, len(pieces) + 1))
    assert {p.split_total for p in pieces} == {len(pieces)}
    unsplit = [p for p in text_chunks(result) if p.split_group is None]
    assert len(unsplit) == 1
    assert unsplit[0].split_index is None
    assert unsplit[0].split_total is None


@pytest.mark.req("REQ-RAG-2.5.1.4")
def test_large_code_block_split_by_lines(small: Settings) -> None:
    """[REQ-RAG-2.5.1.4] 큰 코드 블록은 줄 경계로 나뉘고 조각마다 여는·닫는 펜스가 붙는다."""
    code = [f"w{i} = {i}" for i in range(1, 26)]
    markdown = "```python\n" + "\n".join(code) + "\n```\n"

    result = _split(small, markdown, ChunkingMode.RULE)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    rebuilt: list[str] = []
    for piece in pieces:
        rows = piece.text.strip().split("\n")
        assert rows[0] == "```python"
        assert rows[-1] == "```"
        rebuilt.extend(rows[1:-1])
        assert count_w(piece.text) <= CHUNK_MAX
    assert rebuilt == code


@pytest.mark.req("REQ-RAG-2.5.1.5")
@pytest.mark.req("REQ-RAG-2.2.2")
def test_resplit_keeps_placeholders_whole(small: Settings) -> None:
    """[REQ-RAG-2.5.1.5] 자리표시가 든 큰 청크를 나눠도 자리표시가 잘리거나 겹치지 않는다."""
    result = _split(small, PLACEHOLDER_DOC, ChunkingMode.RULE)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    for piece in pieces:
        assert piece.text.count("[[minerva:") == len(find_placeholders(piece.text))
    joined = "\n".join(p.text for p in pieces)
    assert [p.raw for p in find_placeholders(joined)] == [
        p.raw for p in find_placeholders(PLACEHOLDER_DOC)
    ]


@pytest.mark.req("REQ-RAG-2.5.1.3")
def test_piece_chunk_keys_unique(small: Settings) -> None:
    """[REQ-RAG-2.5.1.3] 나뉜 조각과 안 나뉜 청크 모두 chunk_key가 서로 다르다(IF-RAG-1)."""
    markdown = PARA_DOC + "\n## 작은 절\n\n작은 문단 w19.\n\n[[minerva:table:t1 | 표]]\n"

    result = _split(small, markdown, ChunkingMode.RULE)

    assert any(c.split_group is not None for c in result.chunks)
    keys = [c.chunk_key for c in result.chunks]
    assert len(keys) == len(set(keys))


@pytest.mark.req("REQ-RAG-2.5.1.6")
def test_pieces_no_overlap(small: Settings) -> None:
    """[REQ-RAG-2.5.1.6] 조각을 split_index 차례로 이으면 경계 공백을 빼고 원문과 같다."""
    result = _split(small, SENTENCE_DOC, ChunkingMode.RULE)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    assert_verbatim([p.text for p in pieces], SENTENCE_DOC)


@pytest.mark.req("REQ-RAG-2.5.3.1")
def test_split_group_shared_and_distinct(small: Settings) -> None:
    """[REQ-RAG-2.5.3.1] 한 청크의 조각은 같은 split_group, 다른 청크의 조각은 다른 값을 갖는다."""
    markdown = (
        "## 절 하나\n\n하나 문단 w1 w2 w3 w4 w5 w6.\n\n하나 둘째 w7 w8 w9 w10 w11 w12.\n\n"
        "## 절 둘\n\n둘 문단 w13 w14 w15 w16 w17 w18.\n\n둘 둘째 w19 w20 w21 w22 w23 w24.\n"
    )

    result = _split(small, markdown, ChunkingMode.RULE)

    groups = group_by_split(result)
    assert len(groups) == 2
    assert all(len(pieces) >= 2 for pieces in groups.values())


@pytest.mark.req("REQ-RAG-2.4.4")
def test_asset_order_follows_piece(small: Settings) -> None:
    """[REQ-RAG-2.4.4] 자리표시를 담은 조각이 있으면 ASSET 청크의 order는 그 조각의 order다."""
    result = _split(small, PLACEHOLDER_DOC, ChunkingMode.RULE)

    (asset,) = asset_chunks(result)
    holders = [p for p in text_chunks(result) if asset.text in p.text]
    assert len(holders) == 1
    assert asset.order == holders[0].order


# 한 줄이 상한(10w)을 넘는 코드 줄. 줄 경계로는 더 나눌 수 없다
_BIG_LINE = " ".join(f"w{i}" for i in range(1, 13))


@pytest.mark.req("REQ-RAG-2.5.1.4")
@pytest.mark.req("REQ-RAG-2.5.1.3")
@pytest.mark.req("REQ-RAG-2.1.5")
@pytest.mark.parametrize("mode", [ChunkingMode.RULE, ChunkingMode.SEMANTIC])
def test_unsplittable_big_code_block_crlf_kept_verbatim(
    small: Settings, mode: ChunkingMode
) -> None:
    """[REQ-RAG-2.5.1.4] 줄 경계로 나눌 수 없는 큰 코드 블록(CRLF)은 조각 하나, 원문 그대로다."""
    markdown = f"# T\r\n```py\r\n{_BIG_LINE}\r\n```\r\n"

    result = _split(small, markdown, mode)

    (piece,) = text_chunks(result)
    assert piece.split_index is None
    assert piece.split_total is None
    assert piece.split_group is None
    # ★ 합성 펜스·줄바꿈 변형 없이 경계 공백만 뺀 원문이다
    assert piece.text == markdown.strip()


@pytest.mark.req("REQ-RAG-2.5.1.4")
@pytest.mark.req("REQ-RAG-2.5.1.3")
@pytest.mark.req("REQ-RAG-2.1.5")
@pytest.mark.parametrize("mode", [ChunkingMode.RULE, ChunkingMode.SEMANTIC])
def test_unsplittable_big_code_block_unclosed_kept_verbatim(
    small: Settings, mode: ChunkingMode
) -> None:
    """[REQ-RAG-2.5.1.4] 닫히지 않은 큰 코드 블록은 조각 하나이고 닫는 펜스가 붙지 않는다."""
    markdown = f"# T\n```py\n{_BIG_LINE}\n"

    result = _split(small, markdown, mode)

    (piece,) = text_chunks(result)
    assert piece.split_index is None
    assert piece.split_total is None
    assert piece.split_group is None
    assert piece.text == markdown.strip()


@pytest.mark.req("REQ-RAG-2.5.1.4")
@pytest.mark.req("REQ-RAG-2.1.5")
def test_large_code_block_crlf_split_keeps_fence_and_lines(small: Settings) -> None:
    """[REQ-RAG-2.5.1.4] CRLF 큰 코드 블록이 나뉘면 조각마다 원래 펜스가 붙고 코드 줄이 보존된다."""
    code = [f"w{3 * i + 1} w{3 * i + 2} w{3 * i + 3}" for i in range(8)]
    markdown = "# T\r\n```py\r\n" + "".join(f"{line}\r\n" for line in code) + "```\r\n"

    result = _split(small, markdown, ChunkingMode.RULE)

    pieces = text_chunks(result)
    assert len(pieces) >= 2
    rebuilt: list[str] = []
    for piece in pieces:
        rows = piece.text.strip().split("\n")
        # 펜스 줄의 \r 유무는 따지지 않는다. 첫 조각은 헤딩 줄이 앞에 올 수 있다
        opens = [i for i, row in enumerate(rows) if row.rstrip("\r") == "```py"]
        assert len(opens) == 1
        assert rows[-1].rstrip("\r") == "```"
        rebuilt.extend(rows[opens[0] + 1 : -1])
    # ★ 원래 코드 줄의 \r이 사라지지 않는다 (원문 구간 그대로)
    assert rebuilt == [f"{line}\r" for line in code]
