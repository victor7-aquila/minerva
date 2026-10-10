"""chunking 단위 테스트의 가짜 ModelHub, 응답 도우미, 단언 도우미.

★ 가짜가 읽는 요청 형식(경계 요청은 스키마에 `chunks`가 있고, 프롬프트에 `<document>` 블록과
`n| 내용` 줄이 있다)은 구현 계획의 고정 형식이다. 형식이 다르면 AssertionError로 분명히 실패한다.
"""

import asyncio
import json
import re
from collections.abc import Callable, Coroutine, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from minerva_rag.chunking import Chunker
from minerva_rag.core import Chunk, ChunkingResult, ChunkKind, Settings
from minerva_rag.resource import LlmRole, ModelHub

# conftest의 make_settings 픽스처가 돌려주는 함수의 타입이다
MakeSettings = Callable[..., Settings]


class GenerationError(Exception):
    """연결된 뒤 생성이 실패한 상황을 흉내 내는 MinervaError가 아닌 예외다."""


# ── 토큰 세기 ─────────────────────────────────────────────────────────

_W_TOKEN = re.compile(r"(?<![\w])w\d+(?![\w])")


def count_w(text: str) -> int:
    """'w숫자' 낱말 수만 센다. 지시문·줄 번호·한국어 본문은 세지 않아 한도를 정확히 고른다."""
    return len(_W_TOKEN.findall(text))


def count_words(text: str) -> int:
    """공백으로 나눈 낱말 수를 센다(지시문·줄 번호까지 모두)."""
    return len(text.split())


# ── 줄 읽기 ───────────────────────────────────────────────────────────

_HEADING = re.compile(r"^ {0,3}#{1,6}(\s|$)")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_NUMBERED = re.compile(r"^(\d+)\| ?(.*)$")


def is_heading_line(line: str) -> bool:
    """ATX 헤딩 줄인지 본다(코드 블록 안인지는 따지지 않는다)."""
    return _HEADING.match(line) is not None


def first_line(text: str) -> str:
    """텍스트의 첫 줄을 돌려준다."""
    return text.split("\n", 1)[0]


def document_lines(prompt: str) -> list[str]:
    """경계 요청 프롬프트의 `<document>` 블록에서 줄 내용 목록을 읽는다."""
    rows = prompt.split("\n")
    assert "<document>" in rows, "경계 요청에 <document> 줄이 없다"
    start = rows.index("<document>") + 1
    assert "</document>" in rows[start:], "경계 요청에 </document> 줄이 없다"
    end = rows.index("</document>", start)
    lines: list[str] = []
    for number, row in enumerate(rows[start:end], start=1):
        matched = _NUMBERED.match(row)
        assert matched is not None, f"번호 붙은 줄 형식이 아니다: {row!r}"
        assert int(matched[1]) == number, f"줄 번호가 {number}번이 아니다: {row!r}"
        lines.append(matched[2])
    return lines


def heading_starts(lines: Sequence[str]) -> list[int]:
    """펜스 코드 블록 밖 헤딩 줄의 번호(1부터)를 차례로 돌려준다."""
    starts: list[int] = []
    fence: tuple[str, int] | None = None
    for number, line in enumerate(lines, start=1):
        matched = _FENCE.match(line)
        if fence is None:
            if matched is not None:
                fence = (matched[1][0], len(matched[1]))
            elif is_heading_line(line):
                starts.append(number)
        elif (
            matched is not None
            and matched[1][0] == fence[0]
            and len(matched[1]) >= fence[1]
            and not matched[2].strip()
        ):
            fence = None
    return starts


def _ranges_from_starts(starts: Sequence[int], total: int) -> list[tuple[int, int]]:
    """시작 줄 번호 목록으로 빈틈 없는 범위를 만든다(첫 범위는 1번 줄부터)."""
    ordered = sorted({1, *starts})
    ends = [start - 1 for start in ordered[1:]] + [total]
    return list(zip(ordered, ends, strict=True))


# ── 응답 도우미 (모두 JSON 문자열을 돌려준다) ──────────────────────────


def raw_chunk(start: int, end: int, title: str = "제목", summary: str = "요약") -> dict[str, Any]:
    """경계 응답의 청크 하나를 만든다."""
    return {"start_line": start, "end_line": end, "title": title, "summary": summary}


def ranges_json(
    ranges: Sequence[tuple[int, int]], title: str = "경계 제목", summary: str = "경계 요약"
) -> str:
    """줄 범위 목록으로 경계 응답을 만든다. 제목·요약에는 1부터 번호를 붙인다."""
    chunks = [
        raw_chunk(start, end, f"{title} {i}", f"{summary} {i}")
        for i, (start, end) in enumerate(ranges, start=1)
    ]
    return json.dumps({"chunks": chunks}, ensure_ascii=False)


BoundaryResponder = Callable[[list[str], int], str]
TitleResponder = Callable[[str], str]


def whole_part(lines: list[str], attempt: int) -> str:
    """부분 전체를 청크 하나로 나눈다."""
    return ranges_json([(1, len(lines))])


def by_headings(lines: list[str], attempt: int) -> str:
    """헤딩 줄마다 새 청크로 나누고 첫 헤딩 앞은 따로 둔다."""
    return ranges_json(_ranges_from_starts(heading_starts(lines), len(lines)))


def fixed_title(prompt: str) -> str:
    """규칙·대체 분할의 제목·요약 응답이다."""
    return json.dumps({"title": "규칙 제목", "summary": "규칙 요약"}, ensure_ascii=False)


def responder(make_ranges: Callable[[list[str]], Sequence[tuple[int, int]]]) -> BoundaryResponder:
    """줄 목록에서 범위를 계산하는 함수로 응답자를 만든다."""

    def respond(lines: list[str], attempt: int) -> str:
        return ranges_json(make_ranges(lines))

    return respond


def raw_response(text: str) -> BoundaryResponder:
    """줄 목록과 관계없이 같은 원문을 늘 돌려주는 응답자를 만든다."""

    def respond(lines: list[str], attempt: int) -> str:
        return text

    return respond


def dropping(marker: str) -> BoundaryResponder:
    """`by_headings` 범위에서 `marker`가 든 줄을 빼도록 범위를 쪼갠다(그 줄이 빠진다)."""

    def make_ranges(lines: list[str]) -> list[tuple[int, int]]:
        ranges: list[tuple[int, int]] = []
        for start, end in _ranges_from_starts(heading_starts(lines), len(lines)):
            hit = next((n for n in range(start, end + 1) if marker in lines[n - 1]), None)
            if hit is None:
                ranges.append((start, end))
                continue
            if hit > start:
                ranges.append((start, hit - 1))
            if hit < end:
                ranges.append((hit + 1, end))
        return ranges

    return responder(make_ranges)


def starting_at(predicate: Callable[[str], bool]) -> BoundaryResponder:
    """`by_headings` 범위에 더해 조건을 만족하는 첫 줄에서 새 범위를 시작한다."""

    def make_ranges(lines: list[str]) -> list[tuple[int, int]]:
        starts = heading_starts(lines)
        extra = next((n for n, line in enumerate(lines, start=1) if predicate(line)), None)
        if extra is not None:
            starts.append(extra)
        return _ranges_from_starts(starts, len(lines))

    return responder(make_ranges)


def scripted(*responders: BoundaryResponder) -> BoundaryResponder:
    """같은 부분에 대한 attempt번째 호출에 attempt번째 응답자를 쓰고, 넘으면 마지막을 되풀이한다."""

    def respond(lines: list[str], attempt: int) -> str:
        return responders[min(attempt, len(responders) - 1)](lines, attempt)

    return respond


# ── 가짜 ModelHub ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class Call:
    """generate 호출 하나의 기록이다."""

    role: LlmRole
    prompt: str
    schema: dict[str, Any]

    @property
    def is_boundary(self) -> bool:
        """경계 요청인지(스키마에 `chunks`가 있는지) 돌려준다."""
        return "chunks" in self.schema.get("properties", {})


@dataclass
class FakeModelHub:
    """ModelHub 대신 쓰는 가짜다. generate와 count_tokens만 가진다."""

    boundary: BoundaryResponder = whole_part
    title: TitleResponder = fixed_title
    counter: Callable[[str], int] = count_w
    error: Callable[[Call], BaseException | None] | None = None
    calls: list[Call] = field(default_factory=lambda: [])
    _attempts: dict[tuple[str, ...], int] = field(default_factory=lambda: {})

    async def generate(
        self,
        role: LlmRole,
        prompt: str,
        *,
        image: bytes | None = None,
        json_schema: Mapping[str, Any] | None = None,
    ) -> str:
        """호출을 기록하고 경계 요청이면 boundary, 아니면 title 응답자의 응답을 돌려준다."""
        assert json_schema is not None, "분할 LLM 호출에는 json_schema가 있어야 한다"
        assert image is None, "분할 LLM 호출에는 이미지가 없어야 한다"
        call = Call(role=role, prompt=prompt, schema=dict(json_schema))
        self.calls.append(call)
        failure = self.error(call) if self.error is not None else None
        if failure is not None:
            raise failure
        if not call.is_boundary:
            return self.title(prompt)
        lines = document_lines(prompt)
        key = tuple(lines)
        attempt = self._attempts.get(key, 0)
        self._attempts[key] = attempt + 1
        return self.boundary(lines, attempt)

    def count_tokens(self, text: str) -> int:
        """토큰 수를 센다. 동기 함수다."""
        return self.counter(text)

    @property
    def boundary_calls(self) -> list[Call]:
        """경계 요청 호출만 돌려준다."""
        return [call for call in self.calls if call.is_boundary]

    @property
    def title_calls(self) -> list[Call]:
        """제목·요약 요청 호출만 돌려준다."""
        return [call for call in self.calls if not call.is_boundary]


# ── 단언 도우미 ───────────────────────────────────────────────────────


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    """코루틴을 동기 테스트에서 실행한다."""
    return asyncio.run(coro)


def make_chunker(fake: FakeModelHub, settings: Settings) -> Chunker:
    """가짜 ModelHub를 넣은 Chunker를 만든다. ★ cast는 여기 한 곳뿐이다."""
    return Chunker(cast(ModelHub, fake), settings)


def text_chunks(result: ChunkingResult) -> list[Chunk]:
    """본문 청크만 (order, split_index) 차례로 돌려준다."""
    chunks = [c for c in result.chunks if c.kind is ChunkKind.TEXT]
    return sorted(chunks, key=lambda c: (c.order, c.split_index or 0))


def asset_chunks(result: ChunkingResult) -> list[Chunk]:
    """표·이미지 청크만 돌려준다."""
    return [c for c in result.chunks if c.kind is ChunkKind.ASSET]


def assert_verbatim(texts: Sequence[str], source: str) -> None:
    """텍스트들을 차례로 이으면 경계 공백을 빼고 원문과 같은지(연속 구간, 겹침 없음) 본다."""
    pos = 0
    for text in texts:
        assert text.strip(), "빈 본문 청크가 있다"
        index = source.find(text, pos)
        assert index >= 0, f"원문 구간이 아니거나 차례가 틀렸다: {text!r}"
        assert not source[pos:index].strip(), f"청크 사이에 빠진 글자가 있다: {source[pos:index]!r}"
        pos = index + len(text)
    assert not source[pos:].strip(), f"마지막 청크 뒤에 빠진 글자가 있다: {source[pos:]!r}"


def has_bodyless_text_chunk(result: ChunkingResult) -> bool:
    """공백이 아닌 줄이 모두 헤딩 줄인 본문 청크가 있는지 본다."""
    for chunk in text_chunks(result):
        rows = [row for row in chunk.text.split("\n") if row.strip()]
        if all(is_heading_line(row) for row in rows):
            return True
    return False


def group_by_split(result: ChunkingResult) -> dict[str, list[Chunk]]:
    """split_group별 조각을 split_index 차례로 묶는다."""
    groups: dict[str, list[Chunk]] = {}
    for chunk in text_chunks(result):
        if chunk.split_group is not None:
            groups.setdefault(chunk.split_group, []).append(chunk)
    return {key: sorted(pieces, key=lambda c: c.split_index or 0) for key, pieces in groups.items()}
