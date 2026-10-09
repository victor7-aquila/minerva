"""자리표시 읽기(REQ-RAG-2.2.1) 단위 테스트."""

import dataclasses

import pytest

from minerva_rag.core import find_placeholders


def _assign(target: object, name: str, value: object) -> None:
    """필드 대입을 이름으로 시도한다 (정적 검사가 frozen 대입을 막는 것을 피한다)."""
    setattr(target, name, value)


@pytest.mark.req("REQ-RAG-2.2.1")
def test_finds_in_order() -> None:
    """[REQ-RAG-2.2.1] 자리표시를 나오는 차례대로 찾고 text[start:end]가 raw와 같다."""
    text = (
        "# 설치\n\n앞 [[minerva:table:t1 | 환경 변수 표]] 중간\n[[minerva:image:img2 | 구성도]] 끝"
    )
    found = find_placeholders(text)
    assert [p.kind for p in found] == ["table", "image"]
    assert [p.placeholder_id for p in found] == ["t1", "img2"]
    assert [p.raw for p in found] == [
        "[[minerva:table:t1 | 환경 변수 표]]",
        "[[minerva:image:img2 | 구성도]]",
    ]
    assert all(text[p.start : p.end] == p.raw for p in found)


@pytest.mark.req("REQ-RAG-2.2.1")
def test_positions_are_char_indices() -> None:
    """[REQ-RAG-2.2.1] 위치는 바이트가 아니라 글자 기준이다."""
    text = "가나다[[minerva:image:a1 | 그림]]"
    (found,) = find_placeholders(text)
    assert found.start == 3
    assert found.end == len(text)


@pytest.mark.req("REQ-RAG-2.2.1")
@pytest.mark.parametrize("text", ["자리표시 없음 [[링크]]", ""])
def test_returns_tuple_and_empty(text: str) -> None:
    """[REQ-RAG-2.2.1] 자리표시가 없으면 빈 튜플을 돌려준다."""
    result = find_placeholders(text)
    assert isinstance(result, tuple)
    assert result == ()


@pytest.mark.req("REQ-RAG-2.2.1")
def test_single_bracket_in_description() -> None:
    """[REQ-RAG-2.2.1] 설명 안의 `]` 하나는 자리표시를 끝내지 않는다."""
    text = "[[minerva:table:t1 | a]b 표]]"
    (found,) = find_placeholders(text)
    assert found.raw == text


@pytest.mark.req("REQ-RAG-2.2.1")
def test_ends_at_first_double_bracket() -> None:
    """[REQ-RAG-2.2.1] 처음 나오는 `]]`에서 끝나고 남은 `]`는 본문이다."""
    (found,) = find_placeholders("[[minerva:table:t1 | abc]]] 뒤")
    assert found.raw == "[[minerva:table:t1 | abc]]"


@pytest.mark.req("REQ-RAG-2.2.1")
def test_adjacent_placeholders() -> None:
    """[REQ-RAG-2.2.1] 붙어 있는 자리표시도 각각 찾는다."""
    first, second = find_placeholders("[[minerva:table:a | x]][[minerva:image:b | y]]")
    assert first.end == second.start


@pytest.mark.req("REQ-RAG-2.2.1")
@pytest.mark.parametrize(
    "text",
    [
        "[[minerva:video:v1 | 영상]]",
        "[[minerva:table:T1 | 표]]",
        "[[minerva:table:t-1 | 표]]",
        "[[minerva:table:t_1 | 표]]",
        "[[minerva:table: | 표]]",
        "[[minerva:table:t1 | ]]",
        "[[minerva:table:t1|표]]",
        "[[minerva:table:t1 | 줄\n바꿈]]",
        "[[minerva:table:t1 | 닫힘 없음",
        "[[minerva:table:t1]]",
        "[[other:table:t1 | 표]]",
        "[[minerva:table:t1 | x]",
    ],
)
def test_ignores_malformed(text: str) -> None:
    """[REQ-RAG-2.2.1] 형식에 맞지 않는 [[...]]는 찾지 않는다."""
    assert find_placeholders(text) == ()


@pytest.mark.req("REQ-RAG-2.2.1")
def test_malformed_does_not_hide_valid() -> None:
    """[REQ-RAG-2.2.1] 잘못된 형식이 앞에 있어도 올바른 자리표시는 찾는다."""
    (found,) = find_placeholders("[[minerva:video:v | x]] [[minerva:table:t9 | 표]]")
    assert found.placeholder_id == "t9"


@pytest.mark.req("REQ-RAG-2.2.1")
def test_placeholder_frozen() -> None:
    """[REQ-RAG-2.2.1] Placeholder는 바꿀 수 없다."""
    (found,) = find_placeholders("[[minerva:table:t1 | 표]]")
    with pytest.raises(dataclasses.FrozenInstanceError):
        _assign(found, "raw", "x")
