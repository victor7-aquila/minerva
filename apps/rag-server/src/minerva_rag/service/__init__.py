"""minerva RAG Server service 단위."""

from minerva_rag.chunking import ChunkingMode
from minerva_rag.evaluation import EvaluationCase, EvaluationResult
from minerva_rag.search import DocumentChunks, EditionRef, EditionScope, SearchHit, SearchQuery

from .caption_service import CaptionService
from .delete_service import DeleteService
from .evaluation_service import EvaluationService
from .index_service import IndexAccepted, IndexRequest, IndexService
from .jobs import IndexOutcome, IndexStateView, JobFailureInfo, JobStage, JobState, JobView
from .lifecycle_service import Health, LifecycleService, Services, build_services
from .metadata_service import MetadataService
from .search_service import SearchService

__all__ = [
    # 수명주기
    "build_services",
    "Services",
    "LifecycleService",
    "Health",
    # 서비스
    "CaptionService",
    "IndexService",
    "IndexRequest",
    "IndexAccepted",
    "SearchService",
    "DeleteService",
    "MetadataService",
    "EvaluationService",
    # 작업 상태, 문서 색인 상태
    "JobView",
    "JobFailureInfo",
    "IndexStateView",
    "JobState",
    "JobStage",
    "IndexOutcome",
    # 다시 내보내는 타입 (정의는 원래 단위)
    "ChunkingMode",
    "SearchQuery",
    "SearchHit",
    "EditionScope",
    "EditionRef",
    "DocumentChunks",
    "EvaluationCase",
    "EvaluationResult",
]
