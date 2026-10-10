"""검색 서비스: 검색과 문서 청크 조회를 search에 넘긴다 (REQ-RAG-10.4)."""

from minerva_rag.core import get_logger
from minerva_rag.search import DocumentChunks, Searcher, SearchHit, SearchQuery

from ._guard import Readiness, guarded

log = get_logger(__name__)


class SearchService:
    """검색 요청을 Searcher에 한 번 넘기고 결과를 그대로 돌려준다."""

    def __init__(self, searcher: Searcher, readiness: Readiness) -> None:
        """검색기와 준비 상태를 받는다. I/O는 하지 않는다."""
        self._searcher = searcher
        self._readiness = readiness

    async def search(self, q: SearchQuery) -> tuple[SearchHit, ...]:
        """검색 결과를 돌려준다. 0건은 빈 값이다."""
        log.info(
            "service.search.search",
            query_chars=len(q.query),
            top_n=q.top_n,
            doc_ids=None if q.doc_ids is None else len(q.doc_ids),
            edition_scope=q.edition_scope.value,
            expand_neighbors=q.expand_neighbors,
        )
        with guarded(log, "search.search", self._readiness):
            return await self._searcher.search(q)

    async def document_chunks(self, doc_id: str) -> DocumentChunks:
        """문서 하나의 청크 목록을 돌려준다."""
        log.info("service.search.document_chunks", doc_id=doc_id)
        with guarded(log, "search.document_chunks", self._readiness):
            return await self._searcher.document_chunks(doc_id)
