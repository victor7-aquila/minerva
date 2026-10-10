"""문서 삭제 서비스: 작업과 청크를 정해진 순서로 정리한다 (REQ-RAG-10.5)."""

from minerva_rag.core import JobFailureCode, get_logger
from minerva_rag.indexing import Indexer

from ._guard import Readiness, guarded
from .jobs import JobManager

log = get_logger(__name__)

_DELETED_MESSAGE = "작업을 시작하기 전에 문서 삭제를 요청받았습니다"


class DeleteService:
    """시작하지 않은 작업 실패, 색인 중 작업 대기, 청크 삭제, 색인 상태 비우기 순으로 지운다."""

    def __init__(self, indexer: Indexer, jobs: JobManager, readiness: Readiness) -> None:
        """색인기, 작업 관리자, 준비 상태를 받는다. I/O는 하지 않는다."""
        self._indexer = indexer
        self._jobs = jobs
        self._readiness = readiness

    async def delete(self, doc_id: str) -> None:
        """문서를 삭제한다. 청크와 문서 색인 상태를 모두 비운다."""
        log.info("service.delete.delete", doc_id=doc_id)
        with guarded(log, "delete.delete", self._readiness):
            # ★ 순서를 바꾸지 않는다. 1을 2보다 먼저 해야 기다리는 동안 남은 작업이 시작되지 않고,
            #   3을 2보다 먼저 하면 색인 중이던 작업이 삭제한 문서를 다시 저장한다
            await self._jobs.fail_queued(
                doc_id, JobFailureCode.DOCUMENT_DELETED.value, _DELETED_MESSAGE
            )
            await self._jobs.wait_running(doc_id)
            await self._indexer.delete_document(doc_id)
            await self._jobs.forget_document(doc_id)
