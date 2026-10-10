"""자리표시 보존과 표·이미지 청크(REQ-RAG-2.2, 2.4) 테스트."""

import pytest

from minerva_rag.chunking import Chunker, ChunkingMode
from minerva_rag.core import ChunkingResult, Settings, find_placeholders

from .fakes import (
    FakeModelHub,
    asset_chunks,
    by_headings,
    make_chunker,
    run,
    text_chunks,
    whole_part,
)

PH_DOC = (
    "## 개요\n\n서버 구성은 [[minerva:image:i1 | 서버 구성도]] 와 같다 w1.\n\n"
    "## 표\n\n[[minerva:table:t1 | 환경 변수 표]]\n\n"
    "## 부록\n\n[[minerva:image:i2 | 부록 이미지]]\n"
)

MODES = pytest.mark.parametrize(
    "mode", [ChunkingMode.SEMANTIC, ChunkingMode.RULE], ids=["semantic", "rule"]
)


def _split(settings: Settings, mode: ChunkingMode, markdown: str = PH_DOC) -> ChunkingResult:
    """헤딩 기준 경계를 돌려주는 가짜로 나눈다."""
    fake = FakeModelHub(boundary=by_headings)
    chunker: Chunker = make_chunker(fake, settings)
    return run(chunker.split(markdown, mode))


@pytest.mark.req("REQ-RAG-2.2.1")
@MODES
def test_placeholders_exactly_once(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.2.1] 본문 청크의 자리표시 목록이 입력의 목록과 같은 차례·같은 문자열이다."""
    result = _split(settings, mode)

    joined = "\n".join(c.text for c in text_chunks(result))
    found = [p.raw for p in find_placeholders(joined)]
    assert found == [p.raw for p in find_placeholders(PH_DOC)]


@pytest.mark.req("REQ-RAG-2.2.2")
@MODES
def test_no_partial_placeholder(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.2.2] 어떤 본문 청크에도 자리표시의 일부만 든 조각이 없다."""
    result = _split(settings, mode)

    for chunk in text_chunks(result):
        assert chunk.text.count("[[minerva:") == len(find_placeholders(chunk.text))


@pytest.mark.req("REQ-RAG-2.2.3")
@MODES
def test_placeholder_ids_match_text(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.2.3] 모든 청크의 placeholder_ids가 text에서 찾은 ID와 같은 차례로 같다."""
    result = _split(settings, mode)

    assert result.chunks
    for chunk in result.chunks:
        expected = tuple(p.placeholder_id for p in find_placeholders(chunk.text))
        assert chunk.placeholder_ids == expected


@pytest.mark.req("REQ-RAG-2.4.1")
@MODES
def test_asset_chunk_per_placeholder(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.4.1] 자리표시 k개면 ASSET 청크가 k개이고 ID마다 하나씩이다."""
    result = _split(settings, mode)

    ids = [c.placeholder_ids[0] for c in asset_chunks(result)]
    assert sorted(ids) == ["i1", "i2", "t1"]


@pytest.mark.req("REQ-RAG-2.4.2")
@MODES
def test_asset_text_is_raw(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.4.2] ASSET 청크의 text는 자리표시 원문이고 제목·요약·분할 필드는 None이다."""
    raw_by_id = {p.placeholder_id: p.raw for p in find_placeholders(PH_DOC)}
    result = _split(settings, mode)

    for chunk in asset_chunks(result):
        (placeholder_id,) = chunk.placeholder_ids
        assert chunk.text == raw_by_id[placeholder_id]
        assert chunk.title is None
        assert chunk.summary is None
        assert chunk.split_group is None
        assert chunk.split_index is None
        assert chunk.split_total is None


@pytest.mark.req("REQ-RAG-2.4.3")
def test_asset_heading_path_own_section(settings: Settings) -> None:
    """[REQ-RAG-2.4.3] ASSET 청크의 헤딩 경로는 자리표시가 속한 절의 경로다."""
    markdown = "# A\n\n본문 w1.\n\n## B\n\n[[minerva:table:t1 | 표]]\n"
    fake = FakeModelHub(boundary=whole_part)

    result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))

    (chunk,) = text_chunks(result)
    (asset,) = asset_chunks(result)
    assert chunk.heading_path == ("A",)
    assert asset.heading_path[-1] == "B"


@pytest.mark.req("REQ-RAG-2.4.4")
@MODES
def test_asset_order_matches_container(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.4.4] ASSET 청크의 order는 그 자리표시를 담은 본문 청크의 order와 같다."""
    result = _split(settings, mode)

    for asset in asset_chunks(result):
        holders = [c for c in text_chunks(result) if asset.text in c.text]
        assert len(holders) == 1
        assert asset.order == holders[0].order


@pytest.mark.req("REQ-RAG-2.4.1")
@MODES
def test_chunk_keys_unique(settings: Settings, mode: ChunkingMode) -> None:
    """[REQ-RAG-2.4.1] 모든 청크의 chunk_key가 서로 다르다(IF-RAG-1)."""
    result = _split(settings, mode)

    keys = [c.chunk_key for c in result.chunks]
    assert len(keys) == len(set(keys))
