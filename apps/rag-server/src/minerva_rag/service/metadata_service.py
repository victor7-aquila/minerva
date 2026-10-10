"""이름·판 정보 서비스: 색인 중인 작업이 끝난 뒤 바꾼다 (REQ-RAG-10.6)."""

from minerva_rag.core import Edition, get_logger
from minerva_rag.indexing import Indexer

from ._guard import Readiness, guarded
from .jobs import JobQueue

log = get_logger(__name__)


class MetadataService:
    """색인 중인 작업이 끝나기를 기다린 뒤 문서의 이름·판 정보를 바꾼다."""

    def __init__(self, indexer: Indexer, jobs: JobQueue, readiness: Readiness) -> None:
        """색인기, 작업 큐, 준비 상태를 받는다. I/O는 하지 않는다."""
        self._indexer = indexer
        self._jobs = jobs
        self._readiness = readiness

    async def update(self, doc_id: str, name: str, edition: Edition | None) -> None:
        """문서의 이름과 판 정보를 바꾼다."""
        log.info("service.metadata.update", doc_id=doc_id, has_edition=edition is not None)
        with guarded(log, "metadata.update", self._readiness):
            await self._jobs.wait_running(doc_id)
            await self._indexer.update_metadata(doc_id, name, edition)
