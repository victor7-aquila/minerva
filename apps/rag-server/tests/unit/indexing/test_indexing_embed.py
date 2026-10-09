"""색인 텍스트와 벡터 만들기(embed) 테스트 (REQ-RAG-3.1, 3.2, 3.6.1, 3.6.4).

모델은 가짜, 저장소는 쓰이지 않는다.
"""

import pytest

from minerva_rag.core import (
    Chunk,
    ChunkingResult,
    Edition,
    ModelUnavailableError,
    Settings,
    find_placeholders,
)
from minerva_rag.indexing import EmbeddedChunks

from .fakes import (
    FakeChunkStore,
    FakeModelHub,
    as_store,
    asset_chunk,
    chunking_result,
    dense_of,
    edition,
    expected_index_text,
    make_indexer,
    make_input,
    run,
    sparse_of,
    text_chunk,
)

ASSETS = {"t1": "환경 변수별 타입과 기본값", "i1": "서버 세 대의 연결 구성"}


def _chunks() -> list[Chunk]:
    """자리표시가 있는 본문, 없는 본문, 표·이미지 청크를 만든다."""
    return [
        text_chunk(
            "k-with",
            "표는 [[minerva:table:t1 | 환경 변수 표]] 고 그림은 [[minerva:image:i1 | 구성도]] 다.",
            order=0,
        ),
        text_chunk("k-plain", "자리표시 없는 평범한 본문이다.", order=1),
        asset_chunk("k-t1", "table", "t1", "환경 변수 표", order=2),
        asset_chunk("k-i1", "image", "i1", "구성도", order=3),
    ]


def _embed(
    settings: Settings,
    chunks: list[Chunk],
    *,
    edition_value: Edition | None = None,
    name: str = "인증 가이드",
) -> tuple[EmbeddedChunks, FakeModelHub]:
    """embed를 한 번 실행한다."""
    indexer, hub = make_indexer(as_store(FakeChunkStore()), settings)
    inp = make_input(assets=ASSETS, name=name, edition=edition_value)
    return run(indexer.embed(inp, chunking_result(chunks))), hub


def _by_key(embedded: EmbeddedChunks) -> dict[str, int]:
    """chunk_key로 레코드 위치를 찾는 사전이다."""
    return {r.chunk.chunk_key: i for i, r in enumerate(embedded.records)}


@pytest.mark.req("REQ-RAG-3.1.1")
def test_index_text_replaces_placeholders(settings: Settings) -> None:
    """[REQ-RAG-3.1.1] 모델에 넘긴 텍스트에는 자리표시가 없고 그 자리에 요약·캡션 문장이 있다."""
    chunks = _chunks()
    _embedded, hub = _embed(settings, chunks)

    for texts in (hub.all_dense_texts(), hub.all_sparse_texts()):
        assert texts
        assert all(not find_placeholders(t) for t in texts)
        assert expected_index_text(chunks[0], ASSETS) in texts
        assert ASSETS["t1"] in expected_index_text(chunks[0], ASSETS)
        assert ASSETS["i1"] in expected_index_text(chunks[0], ASSETS)
        assert chunks[1].text in texts


@pytest.mark.req("REQ-RAG-3.1.1")
def test_asset_index_text_is_sentence(settings: Settings) -> None:
    """[REQ-RAG-3.1.1] ASSET 청크의 색인 텍스트는 요약·캡션 문장 그 자체다."""
    embedded, hub = _embed(settings, _chunks())
    index = _by_key(embedded)

    for key, pid in (("k-t1", "t1"), ("k-i1", "i1")):
        sentence = ASSETS[pid]
        assert sentence in hub.all_dense_texts()
        assert sentence in hub.all_sparse_texts()
        assert embedded.dense[index[key]] == tuple(dense_of(sentence))
        assert embedded.sparse[index[key]] == sparse_of(sentence)


@pytest.mark.req("REQ-RAG-3.1.2")
def test_record_text_keeps_placeholders(settings: Settings) -> None:
    """[REQ-RAG-3.1.2] 레코드의 chunk.text는 입력 청크의 text와 같다(자리표시 원형 유지)."""
    chunks = _chunks()
    embedded, _hub = _embed(settings, chunks)

    texts = {r.chunk.chunk_key: r.chunk.text for r in embedded.records}
    assert texts == {c.chunk_key: c.text for c in chunks}


@pytest.mark.req("REQ-RAG-3.2.1")
def test_dense_per_chunk_from_index_text(settings: Settings) -> None:
    """[REQ-RAG-3.2.1] dense는 청크마다 하나이고 그 청크의 색인 텍스트로 만든 값이다."""
    chunks = _chunks()
    embedded, _hub = _embed(settings, chunks)

    assert len(embedded.dense) == len(embedded.records) == len(chunks)
    for record, dense in zip(embedded.records, embedded.dense, strict=True):
        assert dense == tuple(dense_of(expected_index_text(record.chunk, ASSETS)))


@pytest.mark.req("REQ-RAG-3.2.2")
def test_sparse_per_chunk_from_index_text(settings: Settings) -> None:
    """[REQ-RAG-3.2.2] 키워드 벡터는 청크마다 하나이고 그 청크의 색인 텍스트로 만든 값이다."""
    chunks = _chunks()
    embedded, _hub = _embed(settings, chunks)

    assert len(embedded.sparse) == len(embedded.records) == len(chunks)
    for record, sparse in zip(embedded.records, embedded.sparse, strict=True):
        assert sparse == sparse_of(expected_index_text(record.chunk, ASSETS))


@pytest.mark.req("REQ-RAG-3.6.1")
@pytest.mark.parametrize("edition_value", [edition(2025), None], ids=["with-edition", "no-edition"])
def test_records_carry_name_edition(settings: Settings, edition_value: Edition | None) -> None:
    """[REQ-RAG-3.6.1] 모든 레코드의 name·edition이 입력과 같다."""
    embedded, _hub = _embed(settings, _chunks(), edition_value=edition_value, name="표준 문서")

    assert embedded.name == "표준 문서"
    assert embedded.records
    assert all(r.name == "표준 문서" for r in embedded.records)
    assert all(r.edition == edition_value for r in embedded.records)


@pytest.mark.req("REQ-RAG-3.3.1")
@pytest.mark.req("REQ-RAG-10.8.5.3")
def test_records_inactive_with_job_id(settings: Settings) -> None:
    """[REQ-RAG-3.3.1] 레코드는 모두 active가 아니고 최신판이 아니며 작업 ID를 갖는다."""
    chunks = _chunks()
    indexer, _hub = make_indexer(as_store(FakeChunkStore()), settings)
    inp = make_input(doc_id="doc-9", version="v7", job_id="job-9", assets=ASSETS)
    embedded = run(indexer.embed(inp, chunking_result(chunks)))

    assert (embedded.doc_id, embedded.version, embedded.name) == ("doc-9", "v7", inp.name)
    for record in embedded.records:
        assert record.active is False
        assert record.is_latest_edition is False
        assert record.job_id == "job-9"
        assert (record.doc_id, record.version) == ("doc-9", "v7")


@pytest.mark.req("REQ-RAG-3.3.3")
def test_chunk_ids_new_and_unique(settings: Settings) -> None:
    """[REQ-RAG-3.3.3] chunk_id는 한 결과 안에서 모두 다르고, 다시 embed하면 새로 만든다."""
    first, _hub = _embed(settings, _chunks())
    second, _hub2 = _embed(settings, _chunks())

    first_ids = {r.chunk_id for r in first.records}
    second_ids = {r.chunk_id for r in second.records}
    assert len(first_ids) == len(first.records)
    assert len(second_ids) == len(second.records)
    assert first_ids.isdisjoint(second_ids)


@pytest.mark.req("REQ-RAG-3.6.4")
def test_embed_no_edition(settings: Settings) -> None:
    """[REQ-RAG-3.6.4] 판 정보가 없는 입력도 embed되고 edition은 None, 최신판은 거짓이다."""
    embedded, _hub = _embed(settings, _chunks(), edition_value=None)

    assert embedded.records
    assert all(r.edition is None for r in embedded.records)
    assert all(r.is_latest_edition is False for r in embedded.records)


@pytest.mark.req("REQ-RAG-3.2.1")
def test_embed_empty_result(settings: Settings) -> None:
    """[REQ-RAG-3.2.1] 청크가 없으면 records·dense·sparse가 모두 빈 튜플이다."""
    indexer, _hub = make_indexer(as_store(FakeChunkStore()), settings)

    embedded = run(indexer.embed(make_input(), ChunkingResult(chunks=(), fallback_used=False)))

    assert embedded.records == ()
    assert embedded.dense == ()
    assert embedded.sparse == ()


@pytest.mark.req("REQ-RAG-3.2.1")
@pytest.mark.req("REQ-RAG-3.2.2")
@pytest.mark.parametrize("method", ["embed_documents", "encode_sparse_documents"])
def test_embed_propagates_model_unavailable(method: str, settings: Settings) -> None:
    """[REQ-RAG-3.2.1] ModelUnavailableError를 그대로 내고 저장소에 쓰지 않는다."""
    store = FakeChunkStore()
    indexer, hub = make_indexer(as_store(store), settings)
    error = ModelUnavailableError()
    hub.fail[method] = error
    inp = make_input(assets=ASSETS)

    with pytest.raises(ModelUnavailableError) as raised:
        run(indexer.embed(inp, chunking_result(_chunks())))

    assert raised.value is error
    assert store.writes() == []
