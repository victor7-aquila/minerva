"""색인용 MD를 청크로 나눈다 (REQ-RAG-2.1·2.2·2.3·2.4)."""

import asyncio
from collections import Counter
from dataclasses import dataclass, replace
from enum import StrEnum
from itertools import pairwise
from typing import Any

from minerva_rag.core import (
    Chunk,
    ChunkingFailedError,
    ChunkingResult,
    ChunkKind,
    FailureLocation,
    MinervaError,
    PromptTooLongError,
    Settings,
    find_placeholders,
    get_logger,
)
from minerva_rag.resource import LlmRole, ModelHub

from .llm_protocol import (
    BOUNDARY_SCHEMA,
    TITLE_SCHEMA,
    BoundaryItem,
    build_boundary_prompt,
    build_title_prompt,
    parse_boundary_response,
    parse_title_response,
)
from .sizing import merge_bodyless, presplit, resplit
from .structure import MarkdownDocument, Span

log = get_logger(__name__)

_REASON_BOUNDARY = "boundary"
_REASON_PLACEHOLDER = "placeholder"


class ChunkingMode(StrEnum):
    """청킹 방식이다."""

    SEMANTIC = "semantic"  # 의미 단위 분할
    RULE = "rule"  # 규칙 분할


@dataclass(frozen=True)
class _Draft:
    """제목·요약을 아직 못 받았을 수 있는 청크 범위 하나다."""

    span: Span
    title: str | None
    summary: str | None


@dataclass(frozen=True)
class _PartLines:
    """부분 텍스트를 줄로 나눈 것이다. 줄 i(0부터)의 원문 범위는 [starts[i], ends[i])다."""

    rows: list[str]
    starts: list[int]
    ends: list[int]
    end: int  # 부분의 끝 위치

    @classmethod
    def of(cls, doc: MarkdownDocument, span: Span) -> "_PartLines":
        """부분의 텍스트를 "\\n"으로 나눠 줄 위치를 계산한다."""
        rows = doc.source[span.start : span.end].split("\n")
        starts: list[int] = []
        position = span.start
        for row in rows:
            starts.append(position)
            position += len(row) + 1
        return cls(rows, starts, [s + len(r) for s, r in zip(starts, rows, strict=True)], span.end)

    def span_of(self, item: BoundaryItem) -> Span:
        """경계 응답의 청크 하나가 덮는 원문 범위를 돌려준다."""
        return Span(self.starts[item.start_line - 1], self.ends[item.end_line - 1])

    def has_text(self, item: BoundaryItem) -> bool:
        """청크가 덮는 줄에 빈 줄이 아닌 줄이 있는지 본다."""
        return any(row.strip() for row in self.rows[item.start_line - 1 : item.end_line])


@dataclass(frozen=True)
class _Verdict:
    """경계 응답의 검증 결과다."""

    boundary_ok: bool
    placeholder_ok: bool
    missing: int
    duplicated: int

    @property
    def ok(self) -> bool:
        """경계와 자리표시 검증을 모두 통과했는지 돌려준다."""
        return self.boundary_ok and self.placeholder_ok

    @property
    def reason(self) -> str:
        """실패 사유를 돌려준다. 자리표시가 어긋나면 자리표시를 우선한다."""
        return _REASON_BOUNDARY if self.placeholder_ok else _REASON_PLACEHOLDER


def _lines_covered(lines: _PartLines, items: list[BoundaryItem]) -> bool:
    """빈 줄이 아닌 모든 줄이 어느 범위에든 드는지 본다."""
    covered = bytearray(len(lines.rows))
    for item in items:
        if item.start_line <= item.end_line:
            width = item.end_line - item.start_line + 1
            covered[item.start_line - 1 : item.end_line] = b"\x01" * width
    return all(covered[number] or not row.strip() for number, row in enumerate(lines.rows))


def _splits_code_block(doc: MarkdownDocument, lines: _PartLines, items: list[BoundaryItem]) -> bool:
    """여는 펜스 줄이 아닌 코드 블록 안 줄에서 시작하는 범위가 있는지 본다."""
    for item in items:
        if item.start_line == 1:
            continue
        offset = lines.starts[item.start_line - 1]
        if offset >= lines.end:
            continue
        number = doc.line_of(offset)
        block = doc.code_block_of[number]
        if block is not None and doc.code_blocks[block].open_line != number:
            return True
    return False


def _validate(
    doc: MarkdownDocument,
    lines: _PartLines,
    items: list[BoundaryItem],
    expected: list[str],
) -> _Verdict:
    """경계 응답이 부분을 빠짐·겹침 없이 차례로 나누는지, 자리표시가 그대로인지 본다."""
    ordered = all(item.start_line <= item.end_line for item in items) and all(
        after.start_line > before.end_line for before, after in pairwise(items)
    )
    boundary_ok = (
        ordered and _lines_covered(lines, items) and not _splits_code_block(doc, lines, items)
    )
    found = [
        placeholder.raw
        for item in items
        if item.start_line <= item.end_line
        for placeholder in find_placeholders(
            doc.source[lines.starts[item.start_line - 1] : lines.ends[item.end_line - 1]]
        )
    ]
    have, want = Counter(found), Counter(expected)
    missing = sum((want - have).values())
    duplicated = sum((have - want).values())
    return _Verdict(boundary_ok, found == expected, missing, duplicated)


def _merge_bodyless(doc: MarkdownDocument, drafts: list[_Draft]) -> list[_Draft]:
    """본문 줄이 없는 청크를 다음 청크 앞에 붙인다. 문서 끝이면 앞 청크 뒤에 붙인다."""
    return merge_bodyless(
        doc, drafts, lambda draft: draft.span, lambda draft, span: replace(draft, span=span)
    )


def _verify(doc: MarkdownDocument, chunks: list[Chunk]) -> None:
    """돌려주기 전에 자리표시가 입력과 같은지 결과 전체를 검사한다."""
    texts = sorted(
        (chunk for chunk in chunks if chunk.kind is ChunkKind.TEXT),
        key=lambda chunk: (chunk.order, chunk.split_index or 0),
    )
    found = [p.raw for chunk in texts for p in find_placeholders(chunk.text)]
    if found != [p.raw for p in doc.placeholders]:
        raise ChunkingFailedError()
    for chunk in chunks:
        ids = tuple(p.placeholder_id for p in find_placeholders(chunk.text))
        if chunk.placeholder_ids != ids:
            raise ChunkingFailedError()
    if sum(1 for chunk in chunks if chunk.kind is ChunkKind.ASSET) != len(doc.placeholders):
        raise ChunkingFailedError()


class Chunker:
    """색인용 MD를 청크로 나눈다."""

    def __init__(self, model_hub: ModelHub, settings: Settings) -> None:
        """모델 허브와 설정을 받는다. I/O는 하지 않는다."""
        self._hub = model_hub
        self._settings = settings

    async def split(self, markdown: str, mode: ChunkingMode) -> ChunkingResult:
        """색인용 MD를 청크로 나눠 최종 결과를 돌려준다."""
        if not markdown.strip():
            log.info(
                "chunking.done",
                text_chunks=0,
                asset_chunks=0,
                split_groups=0,
                fallback_used=False,
                parts=0,
            )
            return ChunkingResult(chunks=(), fallback_used=False)
        doc = await asyncio.to_thread(MarkdownDocument, markdown)
        fallback_used = False
        if mode is ChunkingMode.RULE:
            drafts = [_Draft(span, None, None) for span in doc.rule_spans(Span(0, len(markdown)))]
            parts = 1
        else:
            drafts, fallback_used, parts = await self._split_semantic(doc)
        drafts = _merge_bodyless(doc, drafts)
        drafts = await self._fill_titles(doc, drafts)
        chunks = await asyncio.to_thread(self._build_chunks, doc, drafts)
        await asyncio.to_thread(_verify, doc, chunks)
        text_count = sum(1 for chunk in chunks if chunk.kind is ChunkKind.TEXT)
        log.info(
            "chunking.done",
            text_chunks=text_count,
            asset_chunks=len(chunks) - text_count,
            split_groups=len({c.split_group for c in chunks if c.split_group is not None}),
            fallback_used=fallback_used,
            parts=parts,
        )
        return ChunkingResult(chunks=tuple(chunks), fallback_used=fallback_used)

    def _fits_input(self, prompt: str) -> bool:
        """프롬프트가 분할 LLM 입력 한도 이하인지 본다."""
        return self._hub.count_tokens(prompt) <= self._settings.chunking_llm_max_input_tokens

    def _fits_chunk(self, text: str) -> bool:
        """청크 본문이 크기 상한 이하인지 본다."""
        return self._hub.count_tokens(text) <= self._settings.chunk_max_tokens

    async def _split_semantic(self, doc: MarkdownDocument) -> tuple[list[_Draft], bool, int]:
        """사전 분할한 부분마다 의미 단위로 나눈다. 초안, 대체 분할 여부, 부분 수를 돌려준다."""
        chunk_max = self._settings.chunk_max_tokens

        def fits_prompt(span: Span) -> bool:
            return self._fits_input(
                build_boundary_prompt(doc.source[span.start : span.end], chunk_max)
            )

        part_list = await asyncio.to_thread(presplit, doc, fits_prompt)
        drafts: list[_Draft] = []
        fallback_used = False
        for index, part in enumerate(part_list, start=1):
            if part.oversize or not doc.source[part.span.start : part.span.end].strip():
                drafts.append(_Draft(part.span, None, None))
                continue
            semantic = await self._split_part(doc, part.span, index)
            if semantic is None:
                fallback_used = True
                drafts.extend(_Draft(span, None, None) for span in doc.rule_spans(part.span))
            else:
                drafts.extend(semantic)
        return drafts, fallback_used, len(part_list)

    async def _generate(
        self, prompt: str, schema: dict[str, Any], location: FailureLocation
    ) -> str:
        """분할 LLM을 부른다. 생성 실패는 ChunkingFailedError로 바꾼다."""
        try:
            return await self._hub.generate(LlmRole.CHUNKING, prompt, json_schema=schema)
        except PromptTooLongError as exc:
            raise ChunkingFailedError(location=location) from exc
        except MinervaError:
            raise
        except Exception as exc:  # ★ 연결된 뒤 생성이 실패한 경우(MinervaError가 아닌 예외)
            raise ChunkingFailedError(location=location) from exc

    async def _split_part(
        self, doc: MarkdownDocument, span: Span, index: int
    ) -> list[_Draft] | None:
        """부분 하나를 LLM 경계로 나눈다. 검증에 계속 실패하면 None이다."""
        lines = _PartLines.of(doc, span)
        part_text = doc.source[span.start : span.end]
        prompt = build_boundary_prompt(part_text, self._settings.chunk_max_tokens)
        location = FailureLocation(doc.heading_path_for(span), None)
        expected = [p.raw for p in find_placeholders(part_text)]
        attempts = self._settings.chunking_retries + 1
        for attempt in range(1, attempts + 1):
            raw = await self._generate(prompt, BOUNDARY_SCHEMA, location)
            items = parse_boundary_response(raw, len(lines.rows))
            if items is None:
                raise ChunkingFailedError(location=location)
            verdict = _validate(doc, lines, items, expected)
            if verdict.ok:
                return [
                    _Draft(lines.span_of(item), item.title, item.summary)
                    for item in items
                    if lines.has_text(item)
                ]
            log.warning(
                "chunking.validation_failed",
                part=index,
                attempt=attempt,
                reason=verdict.reason,
                missing=verdict.missing,
                duplicated=verdict.duplicated,
            )
        log.warning("chunking.fallback", part=index, attempts=attempts)
        return None

    async def _fill_titles(self, doc: MarkdownDocument, drafts: list[_Draft]) -> list[_Draft]:
        """제목·요약이 없는 청크마다 분할 LLM으로 만든다."""
        filled: list[_Draft] = []
        for draft in drafts:
            if draft.title is not None:
                filled.append(draft)
                continue
            path = doc.heading_path_for(draft.span)
            location = FailureLocation(path, None)
            prompt = await asyncio.to_thread(
                build_title_prompt, path, doc.text_of(draft.span), self._fits_input
            )
            if prompt is None:
                raise ChunkingFailedError(location=location)
            parsed = parse_title_response(await self._generate(prompt, TITLE_SCHEMA, location))
            if parsed is None:
                raise ChunkingFailedError(location=location)
            filled.append(_Draft(draft.span, parsed[0], parsed[1]))
        return filled

    def _build_chunks(self, doc: MarkdownDocument, drafts: list[_Draft]) -> list[Chunk]:
        """초안마다 상한으로 다시 나눠 본문 청크를 만들고 자리표시마다 표·이미지 청크를 붙인다."""
        chunks: list[Chunk] = []
        text_count = asset_count = 0
        for order, draft in enumerate(drafts):
            made = self._draft_chunks(doc, draft, order, text_count, asset_count)
            added_text = sum(1 for chunk in made if chunk.kind is ChunkKind.TEXT)
            text_count += added_text
            asset_count += len(made) - added_text
            chunks.extend(made)
        return chunks

    def _draft_chunks(
        self, doc: MarkdownDocument, draft: _Draft, order: int, text_start: int, asset_start: int
    ) -> list[Chunk]:
        """초안 하나의 본문 조각과, 조각 바로 뒤에 둘 표·이미지 청크를 만든다."""
        path = doc.heading_path_for(draft.span)
        pieces = resplit(doc, draft.span, self._fits_chunk)
        total = len(pieces)
        made: list[Chunk] = []
        text_number, asset_number = text_start, asset_start
        for position, piece in enumerate(pieces, start=1):
            split = total > 1
            found = find_placeholders(piece.text)
            made.append(
                Chunk(
                    chunk_key=f"text-{text_number}",
                    kind=ChunkKind.TEXT,
                    order=order,
                    heading_path=path,
                    title=draft.title,
                    summary=draft.summary,
                    text=piece.text,
                    placeholder_ids=tuple(p.placeholder_id for p in found),
                    split_group=f"split-{order}" if split else None,
                    split_index=position if split else None,
                    split_total=total if split else None,
                )
            )
            text_number += 1
            for placeholder in found:
                made.append(self._asset_chunk(doc, asset_number, placeholder.raw, order))
                asset_number += 1
        return made

    def _asset_chunk(self, doc: MarkdownDocument, number: int, raw: str, order: int) -> Chunk:
        """입력의 number번째 자리표시로 표·이미지 청크를 만든다."""
        if number >= len(doc.placeholders) or doc.placeholders[number].raw != raw:
            raise ChunkingFailedError()
        placeholder = doc.placeholders[number]
        return Chunk(
            chunk_key=f"asset-{number}",
            kind=ChunkKind.ASSET,
            order=order,
            heading_path=doc.path_at_line[doc.line_of(placeholder.start)],
            title=None,
            summary=None,
            text=placeholder.raw,
            placeholder_ids=(placeholder.placeholder_id,),
            split_group=None,
            split_index=None,
            split_total=None,
        )
