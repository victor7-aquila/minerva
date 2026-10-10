"""분할 LLM에 보내는 경계·제목·요약 요청과 응답 해석 (REQ-RAG-2.1.1, 2.1.2, 2.5.2.2)."""

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final, cast

# ★ 아래 두 스키마의 속성 이름과 프롬프트의 문서 블록 형식은 테스트의 가짜 ModelHub가 읽는다
BOUNDARY_SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "properties": {
        "chunks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["start_line", "end_line", "title", "summary"],
            },
        },
    },
    "required": ["chunks"],
}

TITLE_SCHEMA: Final[dict[str, Any]] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["title", "summary"],
}

_TITLE_INSTRUCTION: Final = (
    "아래 청크는 개발 문서의 한 부분이다. "
    "내용을 나타내는 제목(한 줄)과 요약(한두 문장)을 한국어로 JSON에 담아 답한다."
)
_TRUNCATED_NOTE: Final = "본문이 길어 앞부분만 보냈다."
_EMPTY_PATH: Final = "(없음)"


@dataclass(frozen=True)
class BoundaryItem:
    """경계 응답의 청크 하나다. 줄 번호는 1부터, 양끝을 포함한다."""

    start_line: int
    end_line: int
    title: str
    summary: str


@dataclass(frozen=True)
class BoundaryParseError:
    """경계 응답을 해석하지 못한 사유다. ★ 본문·제목·요약은 담지 않는다 (MODULE.md 「로그」)."""

    detail: str  # not_json, no_chunks, bad_item, line_out_of_range, empty_title, empty_summary
    item: int | None = None  # 걸린 범위의 차례(1부터)
    line: int | None = None  # 걸린 줄 번호


def _boundary_instruction(chunk_max_tokens: int) -> str:
    """경계 요청의 지시문을 만든다."""
    return (
        "개발 문서를 검색용 청크로 나눈다. 아래 문서 블록의 줄마다 `번호| 내용` 형식으로 "
        "번호가 붙어 있다. 의미가 이어지는 줄을 묶어 청크를 정하고, 청크마다 시작 줄 번호, "
        "끝 줄 번호, 제목(한 줄), 요약(한두 문장)을 한국어로 JSON에 담아 답한다. "
        "모든 줄을 차례대로 빠짐없이 한 번씩 덮고 범위를 겹치지 않는다(빈 줄은 어느 청크에 "
        "넣어도 된다). 코드 블록(백틱 세 개나 물결표 세 개로 감싼 부분) 중간에서 나누지 "
        "않는다. `[[minerva:`로 시작하는 자리표시를 빠뜨리거나 자르지 않는다. "
        f"청크 하나는 대략 {chunk_max_tokens} 토큰 이하를 목표로 한다. 본문을 고쳐 쓰지 않는다."
    )


def build_boundary_prompt(part_text: str, chunk_max_tokens: int) -> str:
    """부분 텍스트에 줄 번호를 붙여 경계 요청 프롬프트를 만든다."""
    rows = part_text.split("\n")
    numbered = "\n".join(
        f"{number}| {row.removesuffix('\r')}" for number, row in enumerate(rows, 1)
    )
    return f"{_boundary_instruction(chunk_max_tokens)}\n\n<document>\n{numbered}\n</document>"


def _load_object(raw: str) -> dict[str, object] | None:
    """응답을 JSON 객체로 읽는다. 아니면 None이다."""
    try:
        data: object = json.loads(raw.strip())
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    return {str(key): value for key, value in cast(dict[object, object], data).items()}


def _clean_text(value: object) -> str | None:
    """비어 있지 않은 문자열이면 앞뒤 공백을 뗀 값을, 아니면 None을 돌려준다."""
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _parse_item(
    entry: object, number: int, rows: Sequence[str]
) -> BoundaryItem | BoundaryParseError:
    """경계 응답의 범위 하나를 읽는다. 해석할 수 없으면 사유를 돌려준다."""
    if not isinstance(entry, dict):
        return BoundaryParseError("bad_item", number)
    fields = {str(key): value for key, value in cast(dict[object, object], entry).items()}
    start, end = fields.get("start_line"), fields.get("end_line")
    # ★ bool은 정수로 받지 않는다
    if type(start) is not int or type(end) is not int:
        return BoundaryParseError("bad_item", number)
    line_count = len(rows)
    for line in (start, end):
        if not 1 <= line <= line_count:
            return BoundaryParseError("line_out_of_range", number, line)
    title, summary = _clean_text(fields.get("title")), _clean_text(fields.get("summary"))
    # ★ 빈 줄만 덮는 범위는 결과 청크가 되지 않으므로 제목·요약이 비어도 받는다 (REQ-RAG-2.1.1)
    if not any(row.strip() for row in rows[start - 1 : end]):
        return BoundaryItem(start, end, title or "", summary or "")
    if title is None:
        return BoundaryParseError("empty_title", number, start)
    if summary is None:
        return BoundaryParseError("empty_summary", number, start)
    return BoundaryItem(start, end, title, summary)


def parse_boundary_response(
    raw: str, rows: Sequence[str]
) -> list[BoundaryItem] | BoundaryParseError:
    """경계 응답을 읽는다. 해석할 수 없는 응답이면 처음 걸린 사유를 돌려준다."""
    data = _load_object(raw)
    if data is None:
        return BoundaryParseError("not_json")
    entries = data.get("chunks")
    if not isinstance(entries, list) or not entries:
        return BoundaryParseError("no_chunks")
    items: list[BoundaryItem] = []
    for number, entry in enumerate(cast(list[object], entries), start=1):
        parsed = _parse_item(entry, number, rows)
        if isinstance(parsed, BoundaryParseError):
            return parsed
        items.append(parsed)
    return items


def _title_prompt(heading_path: tuple[str, ...], body: str, note: str) -> str:
    """제목·요약 요청 프롬프트를 만든다."""
    instruction = f"{_TITLE_INSTRUCTION} {note}" if note else _TITLE_INSTRUCTION
    path = " > ".join(heading_path) if heading_path else _EMPTY_PATH
    return f"{instruction}\n\n헤딩 경로: {path}\n\n<chunk>\n{body}\n</chunk>"


def build_title_prompt(
    heading_path: tuple[str, ...], body: str, fits: Callable[[str], bool]
) -> str | None:
    """제목·요약 요청 프롬프트를 만든다. 입력 한도를 넘으면 본문의 앞부분만 보낸다.

    본문을 빼도 한도를 넘으면 None이다.
    """
    full = _title_prompt(heading_path, body, "")
    if fits(full):
        return full
    if not fits(_title_prompt(heading_path, "", _TRUNCATED_NOTE)):
        return None
    # 앞부분 글자 수를 이분 탐색한다. 줄바꿈이 있으면 마지막 줄 경계까지만 쓴다
    low, high = 0, len(body)
    while high - low > 1:
        middle = (low + high) // 2
        if fits(_title_prompt(heading_path, body[:middle], _TRUNCATED_NOTE)):
            low = middle
        else:
            high = middle
    head = body[:low]
    cut = head.rfind("\n")
    if cut > 0:
        head = head[:cut]
    return _title_prompt(heading_path, head.rstrip(), _TRUNCATED_NOTE)


def parse_title_response(raw: str) -> tuple[str, str] | None:
    """제목·요약 응답을 읽는다. 해석할 수 없으면 None이다."""
    data = _load_object(raw)
    if data is None:
        return None
    title, summary = _clean_text(data.get("title")), _clean_text(data.get("summary"))
    if title is None or summary is None:
        return None
    return title, summary
