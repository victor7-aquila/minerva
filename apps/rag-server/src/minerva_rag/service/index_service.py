"""색인 서비스: 색인 요청 검증·중복 확인·접수와 작업 조회 (REQ-RAG-10.3)."""

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from minerva_rag.chunking import Chunker, ChunkingMode
from minerva_rag.core import (
    ChunkingFailedError,
    Edition,
    InvalidRequestError,
    JobFailureCode,
    MinervaError,
    ModelUnavailableError,
    StoreUnavailableError,
    VectorDimensionMismatchError,
    find_placeholders,
    get_logger,
)
from minerva_rag.indexing import IndexDecision, Indexer, IndexInput, decide_index

from ._guard import Readiness, guarded
from .jobs import (
    IndexOutcome,
    IndexRunner,
    IndexStateView,
    JobFailure,
    JobManager,
    JobStage,
    JobView,
    ProgressReporter,
)

log = get_logger(__name__)

# 러너 안의 resource 오류를 작업 실패 사유로 바꾸는 표다 (MODULE.md 「예외」)
_FAILURE_CODES: tuple[tuple[type[MinervaError], str], ...] = (
    (ModelUnavailableError, JobFailureCode.MODEL_UNAVAILABLE.value),
    (StoreUnavailableError, JobFailureCode.STORE_UNAVAILABLE.value),
    (VectorDimensionMismatchError, JobFailureCode.VECTOR_DIMENSION_MISMATCH.value),
)


def _failure_code(exc: MinervaError) -> str:
    """★ 하위 클래스도 안전하게 찾도록 isinstance로 사유 코드를 고른다."""
    for error_type, code in _FAILURE_CODES:
        if isinstance(exc, error_type):
            return code
    return JobFailureCode.INTERNAL_ERROR.value


@dataclass(frozen=True)
class IndexRequest:
    """색인 요청 하나다."""

    doc_id: str
    version: str
    markdown: str
    name: str
    assets: Mapping[str, str]  # 자리표시 ID → 요약·캡션 문장
    edition: Edition | None = None
    chunking: ChunkingMode = ChunkingMode.SEMANTIC
    force: bool = False


@dataclass(frozen=True)
class IndexAccepted:
    """색인 요청의 접수 결과다."""

    outcome: Literal["queued", "joined", "reused"]
    job_id: str
    doc_id: str
    version: str  # 요청한 버전


def _missing_placeholder_count(markdown: str, assets: Mapping[str, str]) -> int:
    """MD의 자리표시 ID 중 assets에 없는 것의 개수를 센다. assets에만 있는 ID는 세지 않는다."""
    return len({p.placeholder_id for p in find_placeholders(markdown)} - set(assets))


def _decided_job_id(decision: IndexDecision) -> str:
    """합류·재사용 결정에 들어 있는 작업 ID를 꺼낸다."""
    if decision.job_id is None:
        raise RuntimeError("합류·재사용 결정에 작업 ID가 없습니다")
    return decision.job_id


class IndexService:
    """색인 요청을 검증하고 중복을 확인한 뒤 필요할 때만 작업으로 접수한다."""

    def __init__(
        self, chunker: Chunker, indexer: Indexer, jobs: JobManager, readiness: Readiness
    ) -> None:
        """청킹기, 색인기, 작업 관리자, 준비 상태를 받는다. I/O는 하지 않는다."""
        self._chunker = chunker
        self._indexer = indexer
        self._jobs = jobs
        self._readiness = readiness
        # 같은 요청 두 개가 동시에 와도 둘 다 새 작업이 되지 않게 확인~접수를 묶는다
        self._submit_lock = asyncio.Lock()

    async def submit(self, req: IndexRequest) -> IndexAccepted:
        """색인 요청을 검증하고 중복을 확인한 뒤 필요할 때만 작업으로 접수한다."""
        log.info(
            "service.index.submit",
            doc_id=req.doc_id,
            version=req.version,
            markdown_chars=len(req.markdown),
            assets=len(req.assets),
            force=req.force,
        )
        with guarded(log, "index.submit", self._readiness):
            missing = await asyncio.to_thread(_missing_placeholder_count, req.markdown, req.assets)
            if missing:
                raise InvalidRequestError(
                    f"assets에 요약·캡션이 없는 자리표시가 {missing}개 있습니다"
                )
            checksum = await asyncio.to_thread(
                self._indexer.checksum, req.markdown, req.assets, req.chunking.value
            )
            async with self._submit_lock:
                accepted = await self._decide_and_submit(req, checksum)
            log.info(
                "service.index.decided",
                doc_id=accepted.doc_id,
                outcome=accepted.outcome,
                job_id=accepted.job_id,
            )
            return accepted

    async def get_job(self, job_id: str) -> JobView:
        """작업 ID로 작업 상태를 조회한다."""
        log.info("service.index.get_job", job_id=job_id)
        with guarded(log, "index.get_job", self._readiness):
            return await self._jobs.get_job(job_id)

    async def index_state(self, doc_id: str) -> IndexStateView:
        """문서 하나의 색인 상태를 조회한다."""
        log.info("service.index.index_state", doc_id=doc_id)
        with guarded(log, "index.index_state", self._readiness):
            return await self._jobs.index_state(doc_id)

    async def index_states(self, doc_ids: Sequence[str]) -> list[IndexStateView]:
        """여러 문서의 색인 상태를 받은 순서대로 조회한다."""
        log.info("service.index.index_states", count=len(doc_ids))
        with guarded(log, "index.index_states", self._readiness):
            return await self._jobs.index_states(doc_ids)

    async def _decide_and_submit(self, req: IndexRequest, checksum: str) -> IndexAccepted:
        """열린 작업과 현재 색인으로 합류·재사용·새 접수를 정해 처리한다."""
        open_job_id = await self._jobs.find_open(req.doc_id, checksum)
        current = await self._jobs.current_index(req.doc_id)
        decision = decide_index(
            checksum,
            open_job_id=open_job_id,
            current_job_id=None if current is None else current.job_id,
            current_checksum=None if current is None else current.checksum,
            force=req.force,
        )
        if decision.kind == "submit":
            job_id = await self._jobs.submit(req.doc_id, req.version, checksum, self._runner(req))
            return IndexAccepted("queued", job_id, req.doc_id, req.version)
        outcome = "joined" if decision.kind == "join" else "reused"
        return IndexAccepted(outcome, _decided_job_id(decision), req.doc_id, req.version)

    def _runner(self, req: IndexRequest) -> IndexRunner:
        """요청 하나를 처리하는 러너를 만든다. 청킹을 마친 뒤에만 색인한다."""
        chunker = self._chunker
        indexer = self._indexer

        async def run(reporter: ProgressReporter) -> IndexOutcome:
            try:
                reporter.stage(JobStage.CHUNKING)
                result = await chunker.split(req.markdown, req.chunking)
                reporter.stage(JobStage.EMBEDDING)
                embedded = await indexer.embed(
                    IndexInput(
                        doc_id=req.doc_id,
                        version=req.version,
                        job_id=reporter.job_id,
                        markdown=req.markdown,
                        assets=req.assets,
                        name=req.name,
                        edition=req.edition,
                        chunking_mode=req.chunking.value,
                    ),
                    result,
                )
                outcome = IndexOutcome(
                    chunk_count=len(embedded.records), fallback_used=result.fallback_used
                )
                # ★ write(활성화)보다 먼저 알린다. 활성화 뒤에 멈춰도 다시 시작할 때 완료로 기록한다
                await reporter.prepared(outcome)
                reporter.stage(JobStage.STORING)
                await indexer.write(embedded)
            except ChunkingFailedError as exc:
                raise JobFailure(
                    JobFailureCode.CHUNKING_FAILED.value, exc.message, exc.location
                ) from exc
            except (
                ModelUnavailableError,
                StoreUnavailableError,
                VectorDimensionMismatchError,
            ) as exc:
                raise JobFailure(_failure_code(exc), exc.message) from exc
            return outcome

        return run
