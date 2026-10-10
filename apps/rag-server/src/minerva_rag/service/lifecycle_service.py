"""수명주기 서비스: 단위 조립, 기동·종료, 준비 상태, 상태 확인 (REQ-RAG-10.1)."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

# ★ 테스트 대체 경계: 조립에 쓰는 클래스는 이름으로 가져와 build_services가 호출 시점에
#   이 모듈의 전역 이름으로 만든다. 테스트가 이 이름을 가짜로 바꿔 끼우므로
#   `import minerva_rag.resource as resource`처럼 모듈 경로로 바꾸지 않는다
from minerva_rag.chunking import Chunker
from minerva_rag.core import MinervaError, Settings, get_logger
from minerva_rag.evaluation import Evaluator
from minerva_rag.indexing import Indexer
from minerva_rag.resource import ChunkStore, ModelHub
from minerva_rag.search import Searcher

from .caption_service import CaptionService
from .captioner import Captioner
from .delete_service import DeleteService
from .evaluation_service import EvaluationService
from .index_service import IndexService
from .jobs import JobManager, JobQueue
from .metadata_service import MetadataService
from .search_service import SearchService

log = get_logger(__name__)


@dataclass(frozen=True)
class Health:
    """외부 자원 연결 상태다."""

    qdrant: bool
    ollama: bool


class LifecycleService:
    """기동·종료와 준비 상태를 맡는다."""

    def __init__(
        self,
        model_hub: ModelHub,
        chunk_store: ChunkStore,
        searcher: Searcher,
        indexer: Indexer,
        jobs: JobQueue,
        settings: Settings,
    ) -> None:
        """기동·종료에 쓰는 단위와 설정을 받는다. I/O는 하지 않는다."""
        self._model_hub = model_hub
        self._chunk_store = chunk_store
        self._searcher = searcher
        self._indexer = indexer
        self._jobs = jobs
        self._settings = settings
        self._ready = False

    @property
    def ready(self) -> bool:
        """기동을 마쳐 요청을 받을 수 있으면 참이다."""
        return self._ready

    async def startup(self) -> None:
        """용어집 읽기, 모델 준비, Qdrant 연결, 작업 처리기 시작 순으로 한 뒤 준비 상태로 바꾼다."""
        log.info("service.lifecycle.startup")
        started = time.perf_counter()
        steps: tuple[tuple[str, Callable[[], Awaitable[None]]], ...] = (
            ("glossary", lambda: asyncio.to_thread(self._searcher.load_glossary)),
            ("models", self._model_hub.prepare),
            # ★ 임베딩 차원은 모델 준비 뒤에 읽는다. 그래서 람다 안에서 읽는다
            ("store", lambda: self._chunk_store.connect(self._model_hub.embedding_dimension)),
            ("jobs", lambda: self._jobs.start(self._indexer.recover)),
        )
        for step, action in steps:
            try:
                await action()
            except Exception as exc:
                # ★ ready는 거짓으로 남는다. 프로세스를 끝내는 일은 api가 한다
                log.error(
                    "service.lifecycle.startup_failed", step=step, error_type=type(exc).__name__
                )
                raise
        self._ready = True  # ★ 마지막 단계 뒤에만 바꾼다
        log.info(
            "service.lifecycle.ready", elapsed_ms=round((time.perf_counter() - started) * 1000)
        )

    async def shutdown(self) -> None:
        """작업을 기다린 뒤 연결과 모델을 닫는다. ready는 바꾸지 않는다."""
        log.info("service.lifecycle.shutdown")
        try:
            try:
                await self._jobs.stop(self._settings.shutdown_timeout_seconds)
            finally:
                try:
                    await self._chunk_store.close()
                finally:
                    await self._model_hub.close()
        except MinervaError as exc:
            log.warning(
                "service.failed",
                operation="lifecycle.shutdown",
                error_type=type(exc).__name__,
                code=exc.code,
            )
            raise
        except Exception as exc:
            log.exception(
                "service.failed", operation="lifecycle.shutdown", error_type=type(exc).__name__
            )
            raise

    async def health(self) -> Health:
        """Qdrant와 Ollama 연결 상태를 돌려준다. 준비 전에도 되고 오류를 내지 않는다."""
        log.info("service.lifecycle.health")
        qdrant, ollama = await asyncio.gather(
            self._chunk_store.ping(), self._model_hub.ollama_available()
        )
        return Health(qdrant=qdrant, ollama=ollama)


@dataclass(frozen=True)
class Services:
    """조립한 서비스 묶음이다."""

    lifecycle: LifecycleService
    caption: CaptionService
    index: IndexService
    search: SearchService
    delete: DeleteService
    metadata: MetadataService
    evaluation: EvaluationService


def build_services(settings: Settings) -> Services:
    """설정으로 모든 단위를 만들어 엮는다. 연결이나 모델 준비는 하지 않는다."""
    hub = ModelHub(settings)
    store = ChunkStore(settings)
    # ★ Indexer는 하나만 만든다. 같은 이름의 최신판 재계산 직렬화가 인스턴스 하나 안에서만 성립한다
    indexer = Indexer(hub, store, settings)
    searcher = Searcher(hub, store, settings)
    jobs = JobManager(settings)
    lifecycle = LifecycleService(hub, store, searcher, indexer, jobs, settings)
    return Services(
        lifecycle=lifecycle,
        caption=CaptionService(Captioner(hub), lifecycle),
        index=IndexService(Chunker(hub, settings), indexer, jobs, lifecycle),
        search=SearchService(searcher, lifecycle),
        delete=DeleteService(indexer, jobs, lifecycle),
        metadata=MetadataService(indexer, jobs, lifecycle),
        evaluation=EvaluationService(Evaluator(searcher, settings), lifecycle),
    )
