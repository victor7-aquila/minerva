"""Searcher 통합 테스트 (실제 Qdrant). Qdrant가 없으면 skip한다."""

from pathlib import Path
from typing import cast

import pytest

from minerva_rag.core import Settings
from minerva_rag.resource import ChunkStore, ModelHub
from minerva_rag.search import EditionRef, EditionScope, Searcher, SearchQuery

from ...unit.resource.fakes import run, seed
from ...unit.search.fakes import FakeSearchHub, edition_data, rec
from ..resource.conftest import assert_isolated

_QUERY = "절차"  # 용어집과 무관한 질의다


def _isolated_searcher(it_settings: Settings, store: ChunkStore, tmp_path: Path) -> Searcher:
    """★ 실제 config/glossary.yaml이 아니라 빈 임시 용어집을 읽은 Searcher를 만든다."""
    glossary = tmp_path / "glossary.yaml"
    glossary.write_text("terms: []\n", encoding="utf-8")
    settings = it_settings.model_copy(update={"glossary_path": glossary})
    searcher = Searcher(cast(ModelHub, FakeSearchHub()), store, settings)
    searcher.load_glossary()
    return searcher


def _doc_ids(
    it_settings: Settings, isolated_collection: str, query: SearchQuery, tmp_path: Path
) -> set[str]:
    """실제 Qdrant에 판 처리 데이터를 넣고 검색한 결과의 문서 ID 집합을 돌려준다."""

    async def scenario() -> set[str]:
        store = ChunkStore(it_settings)
        await store.connect(8)
        try:
            await assert_isolated(it_settings, isolated_collection)
            await seed(store, edition_data())
            searcher = _isolated_searcher(it_settings, store, tmp_path)
            return {hit.doc_id for hit in await searcher.search(query)}
        finally:
            await store.close()

    return run(scenario())


@pytest.mark.req("REQ-RAG-4.5.3", "REQ-RAG-4.5.6")
def test_it_specific_scope(it_settings: Settings, isolated_collection: str, tmp_path: Path) -> None:
    """[REQ-RAG-4.5.3] 실제 Qdrant에서 SPECIFIC은 지정한 판만 찾고 판 정보 없는 문서는 뺀다."""
    query = SearchQuery(
        _QUERY, top_n=10, edition_scope=EditionScope.SPECIFIC, edition=EditionRef("표준", "2022")
    )

    assert _doc_ids(it_settings, isolated_collection, query, tmp_path) == {"d-2022"}


@pytest.mark.req("REQ-RAG-4.5.3", "REQ-RAG-4.5.4", "REQ-RAG-4.5.6")
def test_it_latest_scope(it_settings: Settings, isolated_collection: str, tmp_path: Path) -> None:
    """[REQ-RAG-4.5.3] 실제 Qdrant에서 LATEST는 최신판과 판 정보 없는 문서를 찾는다."""
    query = SearchQuery(_QUERY, top_n=10, edition_scope=EditionScope.LATEST)

    assert _doc_ids(it_settings, isolated_collection, query, tmp_path) == {"d-2025", "d-none"}


@pytest.mark.req("REQ-RAG-4.5.3", "REQ-RAG-4.5.6")
def test_it_all_scope(it_settings: Settings, isolated_collection: str, tmp_path: Path) -> None:
    """[REQ-RAG-4.5.3] 실제 Qdrant에서 ALL은 모든 판과 판 정보 없는 문서를 찾는다."""
    query = SearchQuery(_QUERY, top_n=10, edition_scope=EditionScope.ALL)

    assert _doc_ids(it_settings, isolated_collection, query, tmp_path) == {
        "d-2022",
        "d-2025",
        "d-none",
    }


@pytest.mark.req("REQ-RAG-4.7.1")
def test_it_document_chunks_two_active_versions(
    it_settings: Settings, isolated_collection: str, tmp_path: Path
) -> None:
    """[REQ-RAG-4.7.1] 실제 Qdrant에서 두 버전이 active면 마지막 버전 청크만 나온다."""
    records = [
        rec("n1", version="v2", order=1),
        rec("o0", version="v1", order=0),
        rec("n0", version="v2", order=0),
        rec("o1", version="v1", order=1),
    ]

    async def scenario() -> tuple[str | None, list[str]]:
        store = ChunkStore(it_settings)
        await store.connect(8)
        try:
            await assert_isolated(it_settings, isolated_collection)
            await seed(store, records)
            searcher = _isolated_searcher(it_settings, store, tmp_path)
            result = await searcher.document_chunks("doc-1")
            return result.version, [c.chunk_id for c in result.chunks]
        finally:
            await store.close()

    version, chunk_ids = run(scenario())

    assert version == "v2"
    assert chunk_ids == ["n0", "n1"]
