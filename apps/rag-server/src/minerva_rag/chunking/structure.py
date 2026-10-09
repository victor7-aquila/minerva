"""색인용 MD의 줄·헤딩·코드 블록·자리표시를 읽는다 (REQ-RAG-2.1.3, 2.1.5, 2.1.6)."""

import re
from bisect import bisect_right
from dataclasses import dataclass, replace

from minerva_rag.core import Placeholder, find_placeholders

# ★ 헤딩: 펜스 코드 블록 밖에서 0~3칸 들여쓰기 뒤 `#` 1~6개와 공백(또는 줄 끝)으로 시작하는 줄(ATX)
_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*))?$")
_CLOSING_HASHES_RE = re.compile(r"(?:^|[ \t]+)#+[ \t]*$")
# ★ 코드 블록: 0~3칸 들여쓰기 뒤 ``` 또는 ~~~ 3개 이상으로 여는 펜스
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_LEADING_BLANK_LINES_RE = re.compile(r"\A(?:[ \t\r]*\n)+")


@dataclass(frozen=True)
class Span:
    """원문의 글자 범위 [start, end)다."""

    start: int
    end: int


@dataclass(frozen=True)
class CodeBlock:
    """펜스 코드 블록 하나다."""

    open_line: int  # 여는 펜스 줄 번호(0부터)
    close_line: int | None  # 닫는 펜스 줄 번호. 닫지 않았으면 None(문서 끝까지)
    fence: str  # 여는 펜스의 문자 열(예: "```", "~~~~")
    open_text: str  # 여는 펜스 줄 원문(언어 표시 포함, 끝 "\r" 뗌)
    close_text: str | None  # 닫는 펜스 줄 원문


def _parse_heading(content: str) -> tuple[int, str]:
    """헤딩 줄이면 (수준, 헤딩 텍스트)를, 아니면 (0, "")을 돌려준다."""
    matched = _HEADING_RE.match(content)
    if matched is None:
        return 0, ""
    text = (matched.group(2) or "").strip()
    # 닫는 `#` 열은 앞에 공백이 있을 때(또는 텍스트 전체일 때)만 뗀다
    return len(matched.group(1)), _CLOSING_HASHES_RE.sub("", text).strip()


def _open_fence(content: str) -> str | None:
    """코드 블록을 여는 펜스 줄이면 펜스 문자 열을 돌려준다."""
    matched = _FENCE_RE.match(content)
    if matched is None:
        return None
    # 백틱 펜스의 안내 문자열에는 백틱이 들어갈 수 없다
    if matched.group(1)[0] == "`" and "`" in matched.group(2):
        return None
    return matched.group(1)


def _closes_fence(content: str, fence: str) -> bool:
    """content가 fence로 연 코드 블록을 닫는 줄인지 본다."""
    matched = _FENCE_RE.match(content)
    return (
        matched is not None
        and matched.group(1)[0] == fence[0]
        and len(matched.group(1)) >= len(fence)
        and not matched.group(2).strip()
    )


class MarkdownDocument:
    """색인용 MD의 줄·헤딩·코드 블록·자리표시를 미리 읽어 둔다."""

    def __init__(self, source: str) -> None:
        """원문을 한 번 훑어 줄 정보를 채운다."""
        self.source = source
        self.placeholders: tuple[Placeholder, ...] = find_placeholders(source)
        self.line_starts: list[int] = []
        self.line_ends: list[int] = []  # "\n" 앞까지
        self.heading_level: list[int] = []  # 0 = 헤딩 아님
        self.heading_text: list[str] = []
        self.code_block_of: list[int | None] = []  # 줄이 속한 코드 블록 번호(펜스 줄 포함)
        self.code_blocks: list[CodeBlock] = []
        self.path_at_line: list[tuple[str, ...]] = []  # 줄이 속한 절의 헤딩 경로
        self._blank: list[bool] = []
        self._body_prefix: list[int] = [0]
        self._placeholder_starts = [p.start for p in self.placeholders]
        self._scan()

    def _scan(self) -> None:
        """줄마다 펜스 상태와 헤딩 스택을 추적하며 정보를 채운다."""
        stack: list[tuple[int, str]] = []
        path: tuple[str, ...] = ()
        open_block: int | None = None  # 지금 열려 있는 코드 블록 번호
        position = 0
        for number, row in enumerate(self.source.split("\n")):
            start, end = position, position + len(row)
            position = end + 1
            content = row.removesuffix("\r")
            level, text, block = 0, "", None
            if open_block is not None:
                block = open_block
                if _closes_fence(content, self.code_blocks[open_block].fence):
                    self.code_blocks[open_block] = replace(
                        self.code_blocks[open_block], close_line=number, close_text=content
                    )
                    open_block = None
            elif (fence := _open_fence(content)) is not None:
                block = open_block = len(self.code_blocks)
                self.code_blocks.append(CodeBlock(number, None, fence, content, None))
            else:
                level, text = _parse_heading(content)
            if level:
                # ★ 수준 k 헤딩은 수준 k 이상을 빼고 들어간다. 건너뛴 수준은 비운다
                while stack and stack[-1][0] >= level:
                    stack.pop()
                stack.append((level, text))
                path = tuple(name for _, name in stack)
            blank = not content.strip()
            self.line_starts.append(start)
            self.line_ends.append(end)
            self.heading_level.append(level)
            self.heading_text.append(text)
            self.code_block_of.append(block)
            self.path_at_line.append(path)
            self._blank.append(blank)
            self._body_prefix.append(self._body_prefix[-1] + (0 if blank or level else 1))

    def line_of(self, offset: int) -> int:
        """글자 위치가 속한 줄 번호(0부터)를 돌려준다."""
        return max(0, bisect_right(self.line_starts, offset) - 1)

    def lines_in(self, span: Span) -> range:
        """범위와 겹치는 줄 번호를 돌려준다."""
        if span.end <= span.start:
            return range(0)
        return range(self.line_of(span.start), self.line_of(span.end - 1) + 1)

    def is_blank(self, line: int) -> bool:
        """빈 줄(공백뿐인 줄)인지 본다."""
        return self._blank[line]

    def is_heading(self, line: int) -> bool:
        """헤딩 줄인지 본다."""
        return self.heading_level[line] > 0

    def is_body(self, line: int) -> bool:
        """본문 줄(빈 줄도 헤딩도 아닌 줄)인지 본다."""
        return not self._blank[line] and self.heading_level[line] == 0

    def has_body(self, span: Span) -> bool:
        """범위에 본문 줄이 있는지 본다."""
        lines = self.lines_in(span)
        if not lines:
            return False
        return self._body_prefix[lines.stop] - self._body_prefix[lines.start] > 0

    def in_placeholder(self, offset: int) -> bool:
        """글자 위치가 자리표시 한가운데(시작·끝 위치 제외)인지 본다."""
        index = bisect_right(self._placeholder_starts, offset) - 1
        return index >= 0 and self.placeholders[index].start < offset < self.placeholders[index].end

    def heading_path_for(self, span: Span) -> tuple[str, ...]:
        """범위의 헤딩 경로를 돌려준다. 첫 본문 줄이 속한 절의 경로다."""
        lines = self.lines_in(span)
        if not lines:
            return ()
        first_body = next((line for line in lines if self.is_body(line)), None)
        if first_body is not None:
            return self.path_at_line[first_body]
        last_heading = next((line for line in reversed(lines) if self.is_heading(line)), None)
        if last_heading is not None:
            return self.path_at_line[last_heading]
        return self.path_at_line[lines[0]]

    def text_of(self, span: Span) -> str:
        """범위의 본문을 돌려준다. 앞뒤의 빈 줄과 마지막 줄의 오른쪽 공백을 뗀다."""
        rows = self.source[span.start : span.end].split("\n")
        first = 0
        while first < len(rows) and not rows[first].strip():
            first += 1
        last = len(rows)
        while last > first and not rows[last - 1].strip():
            last -= 1
        return "\n".join(rows[first:last]).rstrip()

    def rule_spans(self, span: Span) -> list[Span]:
        """범위를 펜스 밖 헤딩 줄 앞마다 나눈 연속 범위들을 돌려준다."""
        cuts = [
            self.line_starts[line]
            for line in self.lines_in(span)
            if self.is_heading(line) and span.start < self.line_starts[line] < span.end
        ]
        edges = [span.start, *cuts, span.end]
        return [Span(a, b) for a, b in zip(edges, edges[1:], strict=False) if a < b]


def strip_leading_blank_lines(text: str) -> str:
    """앞쪽의 빈 줄들을 뗀다."""
    return _LEADING_BLANK_LINES_RE.sub("", text)
