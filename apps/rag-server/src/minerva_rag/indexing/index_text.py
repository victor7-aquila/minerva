"""REQ-RAG-3.1 색인 텍스트를 만든다."""

from collections.abc import Mapping

from minerva_rag.core import Chunk, ChunkKind, find_placeholders


def _context_header(chunk: Chunk) -> str:
    """본문 청크의 머리글(헤딩 경로 한 줄, 제목 한 줄)을 만든다. 넣을 것이 없으면 빈 문자열이다."""
    lines: list[str] = []
    if chunk.heading_path:
        lines.append(" > ".join(chunk.heading_path))
    if chunk.title:
        lines.append(chunk.title)
    return "\n".join(lines)


def build_index_text(chunk: Chunk, assets: Mapping[str, str]) -> str:
    """청크의 색인 텍스트를 만든다. ASSET은 요약·캡션 문장, TEXT는 머리글을 붙인 치환 본문이다."""
    if chunk.kind == ChunkKind.ASSET:
        if len(chunk.placeholder_ids) != 1:
            raise ValueError("ASSET 청크는 자리표시 ID를 정확히 하나 가져야 합니다")
        placeholder_id = chunk.placeholder_ids[0]
        if placeholder_id not in assets:
            raise ValueError("요약·캡션이 없는 자리표시가 1개 있습니다")
        return assets[placeholder_id]

    parts: list[str] = []
    position = 0
    missing = 0
    for placeholder in find_placeholders(chunk.text):
        parts.append(chunk.text[position : placeholder.start])
        sentence = assets.get(placeholder.placeholder_id)
        if sentence is None:
            missing += 1
        else:
            parts.append(sentence)
        position = placeholder.end
    if missing:
        # ★ ID·문장은 메시지에 넣지 않는다
        raise ValueError(f"요약·캡션이 없는 자리표시가 {missing}개 있습니다")
    parts.append(chunk.text[position:])
    body = "".join(parts)
    # ★ 헤딩 경로·제목을 앞에 붙여, 여러 규칙이 섞인 청크도 어느 절의 무엇인지 검색에 드러나게 한다.
    #   요약은 넣지 않는다(측정에서 이득이 없었다). 재정렬은 이 텍스트가 아니라 본문을 본다
    header = _context_header(chunk)
    return f"{header}\n\n{body}" if header else body
