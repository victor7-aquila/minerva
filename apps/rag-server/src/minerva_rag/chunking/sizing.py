"""크기 상한 재분할, 분할 LLM 입력 한도 사전 분할, 분할 조각 묶기 (REQ-RAG-2.5)."""

import re
from collections.abc import Callable
from dataclasses import dataclass

from .structure import CodeBlock, MarkdownDocument, Span, strip_leading_blank_lines

_Stage = Callable[[MarkdownDocument, Span], list[Span]]
_Fits = Callable[[Span], bool]

# 문장 끝: 영문 부호는 뒤에 공백이 있어야 하고, 한자 문장 부호는 바로 이어져도 된다
_SENTENCE_END_RE = re.compile(r"[.!?][ \t]+|[。！？][ \t]*")
_LIST_MARKER_RE = re.compile(r"\s*\d+[.]\s*")


@dataclass(frozen=True)
class Part:
    """사전 분할로 나눈 부분 하나다."""

    span: Span
    oversize: bool  # 단위 하나가 지시문과 합쳐 입력 한도를 넘음 → 경계 LLM에 보내지 않는다


@dataclass(frozen=True)
class Piece:
    """재분할로 나온 조각 하나다."""

    span: Span  # 원문 범위
    text: str  # 조각 본문. 코드 줄 조각이면 펜스를 붙여 만든 것


def _split_at(span: Span, cuts: list[int]) -> list[Span]:
    """범위를 자르는 위치들로 나눈 연속 범위들을 돌려준다."""
    points = sorted({cut for cut in cuts if span.start < cut < span.end})
    edges = [span.start, *points, span.end]
    return [Span(a, b) for a, b in zip(edges, edges[1:], strict=False)]


def merge_bodyless[T](
    doc: MarkdownDocument,
    items: list[T],
    span_of: Callable[[T], Span],
    with_span: Callable[[T, Span], T],
) -> list[T]:
    """본문 줄이 없는 항목을 다음 항목 앞에 합친다. 마지막이면 앞 항목 뒤에 합친다."""
    merged: list[T] = []
    carry: Span | None = None
    for item in items:
        span = span_of(item)
        current = item if carry is None else with_span(item, Span(carry.start, span.end))
        carry = None
        if doc.has_body(span_of(current)):
            merged.append(current)
        else:
            carry = span_of(current)
    if carry is not None:
        if merged:
            before = merged[-1]
            merged[-1] = with_span(before, Span(span_of(before).start, carry.end))
        else:
            # ★ 본문이 있는 항목이 하나도 없으면 전체를 한 항목으로 둔다
            merged = [with_span(items[-1], Span(span_of(items[0]).start, carry.end))]
    return merged


def _attach_bodyless(doc: MarkdownDocument, units: list[Span]) -> list[Span]:
    """본문 줄이 없는 단위를 다음 단위에 합친다. 마지막이면 앞 단위에 합친다."""
    return merge_bodyless(doc, units, lambda unit: unit, lambda _unit, span: span)


def _heading_units(doc: MarkdownDocument, span: Span) -> list[Span]:
    """범위를 하위 헤딩 앞에서 나눈다. 가장 얕은 수준부터 시도하고 나뉘면 멈춘다."""
    headings = [
        line
        for line in doc.lines_in(span)
        if doc.is_heading(line) and doc.line_starts[line] > span.start
    ]
    for level in sorted({doc.heading_level[line] for line in headings}):
        cuts = [doc.line_starts[line] for line in headings if doc.heading_level[line] <= level]
        units = _split_at(span, cuts)
        if len(_attach_bodyless(doc, units)) >= 2:
            return units
    return [span]


def _paragraph_units(doc: MarkdownDocument, span: Span) -> list[Span]:
    """범위를 펜스 밖 빈 줄 묶음 뒤에서 나눈다. 코드 블록 하나는 한 단위다."""
    cuts: list[int] = []
    for line in doc.lines_in(span):
        previous = line - 1
        if (
            previous >= 0
            and not doc.is_blank(line)
            and doc.is_blank(previous)
            and doc.code_block_of[previous] is None
            and _may_cut_before(doc, line)
        ):
            cuts.append(doc.line_starts[line])
    return _split_at(span, cuts)


def _may_cut_before(doc: MarkdownDocument, line: int) -> bool:
    """줄 앞에 경계를 둘 수 있는지 본다. 코드 블록 안(여는 줄 제외)은 안 된다."""
    block = doc.code_block_of[line]
    return block is None or doc.code_blocks[block].open_line == line


def _sentence_cuts(doc: MarkdownDocument, line: int) -> list[int]:
    """한 줄 안의 문장 끝 다음 위치들을 돌려준다. 자리표시 안은 뺀다."""
    start, end = doc.line_starts[line], doc.line_ends[line]
    row = doc.source[start:end]
    cuts: list[int] = []
    for matched in _SENTENCE_END_RE.finditer(row):
        cut = start + matched.end()
        if cut >= end or doc.in_placeholder(cut):
            continue
        # `1. 항목` 같은 목록 번호 뒤는 문장 끝이 아니다
        if _LIST_MARKER_RE.fullmatch(row[: matched.end()]):
            continue
        cuts.append(cut)
    return cuts


def _sentence_units(doc: MarkdownDocument, span: Span) -> list[Span]:
    """범위를 줄 시작과 문장 끝 뒤에서 나눈다. 코드 블록 안에는 경계를 두지 않는다."""
    cuts: list[int] = []
    for line in doc.lines_in(span):
        if _may_cut_before(doc, line):
            cuts.append(doc.line_starts[line])
        if doc.code_block_of[line] is None and not doc.is_heading(line):
            cuts.extend(_sentence_cuts(doc, line))
    return _split_at(span, cuts)


def _gallop(start: int, count: int, ok: Callable[[int], bool]) -> int:
    """start부터 ok를 만족하는 가장 먼 끝 번호를 찾는다. start는 늘 받아들인다."""
    good, step = start, 1
    while good + step < count and ok(good + step):
        good += step
        step *= 2
    low, high = good, min(good + step, count)
    while high - low > 1:
        middle = (low + high) // 2
        if ok(middle):
            low = middle
        else:
            high = middle
    return low


def _pack(units: list[Span], fits: _Fits) -> list[tuple[Span, int]]:
    """인접 단위를 fits를 만족하는 한 최대로 묶는다. 묶음과 단위 수를 돌려준다."""
    groups: list[tuple[Span, int]] = []
    index = 0
    while index < len(units):
        first = units[index]

        def ok(last: int, first: Span = first) -> bool:
            return fits(Span(first.start, units[last].end))

        last = _gallop(index, len(units), ok)
        groups.append((Span(first.start, units[last].end), last - index + 1))
        index = last + 1
    return groups


def _fit(
    doc: MarkdownDocument, span: Span, fits: _Fits, stages: list[_Stage]
) -> list[tuple[Span, bool]]:
    """범위를 fits를 만족하는 연속 범위들로 나눈다. 더 나눌 수 없으면 만족 여부를 거짓으로 둔다."""
    if fits(span):
        return [(span, True)]
    for index, stage in enumerate(stages):
        units = _attach_bodyless(doc, stage(doc, span))
        if len(units) < 2:
            continue
        result: list[tuple[Span, bool]] = []
        for group, count in _pack(units, fits):
            if count > 1 or fits(group):
                result.append((group, True))
            else:
                result.extend(_fit(doc, group, fits, stages[index:]))
        return result
    return [(span, False)]


_STAGES: list[_Stage] = [_heading_units, _paragraph_units, _sentence_units]


def presplit(doc: MarkdownDocument, fits_prompt: _Fits) -> list[Part]:
    """분할 LLM 입력 한도를 넘는 문서를 헤딩, 문단, 문장 순으로 나눈다."""
    whole = Span(0, len(doc.source))
    return [Part(span, not ok) for span, ok in _fit(doc, whole, fits_prompt, _STAGES)]


def _code_block_of_span(doc: MarkdownDocument, span: Span) -> CodeBlock | None:
    """범위가 앞의 헤딩·빈 줄과 코드 블록 하나, 뒤의 빈 줄로만 이뤄졌으면 그 블록을 돌려준다."""
    lines = doc.lines_in(span)
    found: int | None = None
    for line in lines:
        if not doc.is_body(line):
            continue
        block = doc.code_block_of[line]
        if block is None or (found is not None and block != found):
            return None
        found = block
    if found is None:
        return None
    code = doc.code_blocks[found]
    last = code.close_line if code.close_line is not None else lines[-1]
    # ★ 블록 뒤에는 빈 줄만 있어야 하고, 블록 전체가 범위 안에 있어야 한다
    if code.open_line not in lines or last not in lines:
        return None
    if any(not doc.is_blank(line) for line in range(last + 1, lines.stop)):
        return None
    return code


def _code_pieces(
    doc: MarkdownDocument, span: Span, fits_chunk: Callable[[str], bool]
) -> list[Piece] | None:
    """큰 코드 블록을 줄 경계에서 나눈다. 조각마다 원래 펜스를 붙인다. 못 나누면 None이다."""
    code = _code_block_of_span(doc, span)
    if code is None:
        return None
    lines = doc.lines_in(span)
    last = code.close_line if code.close_line is not None else lines[-1]
    body_end = last if code.close_line is not None else last + 1
    rows = [
        doc.source[doc.line_starts[n] : doc.line_ends[n]]
        for n in range(code.open_line + 1, body_end)
    ]
    if code.close_line is None:
        # 닫지 않은 블록의 끝 빈 줄은 문서 끝 줄바꿈이 만든 것이다
        while rows and not rows[-1].strip():
            rows.pop()
    if not rows:
        return None
    # ★ 펜스 줄은 원문 그대로 쓴다(CRLF의 캐리지 리턴 포함). 닫는 줄은 청크 끝이라 뒤 공백을 뗀다
    open_raw = doc.source[doc.line_starts[code.open_line] : doc.line_ends[code.open_line]]
    if code.close_line is not None:
        close = doc.source[doc.line_starts[code.close_line] : doc.line_ends[code.close_line]]
        close = close.rstrip()
    else:
        close = code.fence
    lead = strip_leading_blank_lines(doc.source[span.start : doc.line_starts[code.open_line]])

    crlf = open_raw.endswith("\r")

    def build(first: int, end: int) -> str:
        head = lead if first == 0 else ""
        # ★ 문서 끝 개행이 없어 마지막 코드 줄에 \r이 없어도 닫는 펜스 앞은 원문 줄바꿈을 따른다
        eol = "\r\n" if crlf and not rows[end].endswith("\r") else "\n"
        return f"{head}{open_raw}\n" + "\n".join(rows[first : end + 1]) + f"{eol}{close}"

    pieces: list[Piece] = []
    index = 0
    while index < len(rows):
        start = index

        def ok(end: int, start: int = start) -> bool:
            return fits_chunk(build(start, end))

        index = _gallop(start, len(rows), ok) + 1
        pieces.append(Piece(span, build(start, index - 1)))
    # ★ 조각이 하나뿐이면 나눈 것이 아니므로 원문 그대로 둔다(펜스 줄 예외는 나눌 때만)
    return pieces if len(pieces) >= 2 else None


def resplit(doc: MarkdownDocument, span: Span, fits_chunk: Callable[[str], bool]) -> list[Piece]:
    """상한을 넘는 청크를 하위 헤딩, 문단, 문장, 코드 줄 순으로 다시 나눈다."""

    def fits(piece: Span) -> bool:
        return fits_chunk(doc.text_of(piece))

    pieces: list[Piece] = []
    for part, ok in _fit(doc, span, fits, _STAGES):
        if not ok:
            code_pieces = _code_pieces(doc, part, fits_chunk)
            if code_pieces is not None:
                pieces.extend(code_pieces)
                continue
        text = doc.text_of(part)
        if text:
            pieces.append(Piece(part, text))
    return pieces
