"""요청 모델과 응답 변환: API.md 「공용 모델」을 service 입력·출력에 옮긴다 (REQ-RAG-9.1.1)."""

import re
from collections.abc import Sequence
from datetime import date
from typing import Annotated, Any, Literal, Protocol

from pydantic import (
    BaseModel,
    BeforeValidator,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    model_validator,
)

from minerva_rag.core import Edition
from minerva_rag.service import (
    ChunkingMode,
    DocumentChunks,
    EditionRef,
    EditionScope,
    EvaluationCase,
    EvaluationResult,
    Health,
    IndexAccepted,
    IndexRequest,
    IndexStateView,
    JobView,
    SearchHit,
    SearchQuery,
)

_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

# ── 요청 모델 ─────────────────────────────────────────────────────


def _parse_iso_date(value: object) -> date:
    """`YYYY-MM-DD` 문자열만 날짜로 바꾼다. ★ 숫자·날짜시간 같은 느슨한 입력은 거부한다."""
    if not isinstance(value, str) or _ISO_DATE.fullmatch(value) is None:
        raise ValueError("edition_date는 YYYY-MM-DD 문자열이어야 합니다")
    return date.fromisoformat(value)


PositiveInt = Annotated[StrictInt, Field(ge=1)]


class TableCaptionBody(BaseModel):
    """표 요약 요청 본문이다."""

    table_markdown: StrictStr


class EditionBody(BaseModel):
    """판 정보 요청 모델이다."""

    label: StrictStr
    edition_date: Annotated[date, BeforeValidator(_parse_iso_date)]

    def to_edition(self) -> Edition:
        """core의 판 정보로 바꾼다."""
        return Edition(label=self.label, edition_date=self.edition_date)


class AssetTextBody(BaseModel):
    """자리표시 ID별 요약·캡션 요청 모델이다."""

    placeholder_id: StrictStr
    text: StrictStr


class IndexJobBody(BaseModel):
    """색인 요청 본문이다."""

    doc_id: StrictStr
    version: StrictStr
    markdown: StrictStr
    assets: list[AssetTextBody]
    name: StrictStr
    edition: EditionBody | None = None
    chunking: Literal["semantic", "rule"] | None = None
    force: StrictBool | None = None

    @model_validator(mode="after")
    def _reject_duplicate_placeholders(self) -> "IndexJobBody":
        """★ assets의 placeholder_id가 겹치면 하나가 조용히 사라지므로 거부한다 (G4)."""
        ids = [asset.placeholder_id for asset in self.assets]
        if len(ids) != len(set(ids)):
            raise ValueError("assets의 placeholder_id가 겹칩니다")
        return self

    def to_request(self) -> IndexRequest:
        """service의 색인 요청으로 바꾼다. null은 빠뜨린 것과 같게 기본값을 쓴다 (G5)."""
        return IndexRequest(
            doc_id=self.doc_id,
            version=self.version,
            markdown=self.markdown,
            name=self.name,
            assets={asset.placeholder_id: asset.text for asset in self.assets},
            edition=self.edition.to_edition() if self.edition is not None else None,
            chunking=ChunkingMode(self.chunking) if self.chunking else ChunkingMode.SEMANTIC,
            force=bool(self.force),
        )


class IndexStatesBody(BaseModel):
    """여러 문서의 색인 상태 조회 요청 본문이다."""

    doc_ids: Annotated[list[StrictStr], Field(min_length=1, max_length=100)]


class MetadataBody(BaseModel):
    """이름·판 정보 변경 요청 본문이다. ★ edition은 필수이고 null을 허용한다."""

    name: StrictStr
    edition: EditionBody | None


class EditionRefBody(BaseModel):
    """이름과 판 표기로 판을 가리키는 요청 모델이다."""

    name: StrictStr
    label: StrictStr


class SearchBody(BaseModel):
    """검색 요청 본문이다."""

    query: StrictStr
    top_n: PositiveInt | None = None
    doc_ids: list[StrictStr] | None = None
    edition_scope: Literal["all", "latest", "specific"] | None = None
    edition: EditionRefBody | None = None
    expand_neighbors: StrictBool | None = None

    @model_validator(mode="after")
    def _require_edition_when_specific(self) -> "SearchBody":
        """★ specific인데 edition이 없으면 SearchQuery 생성이 실패하므로 먼저 거부한다."""
        if self.edition_scope == "specific" and self.edition is None:
            raise ValueError("edition_scope가 specific이면 edition이 필요합니다")
        return self

    def to_query(self) -> SearchQuery:
        """service의 검색 요청으로 바꾼다. null은 빠뜨린 것과 같게 기본값을 쓴다 (G5)."""
        scope = EditionScope(self.edition_scope) if self.edition_scope else EditionScope.ALL
        edition = (
            EditionRef(name=self.edition.name, label=self.edition.label)
            if scope is EditionScope.SPECIFIC and self.edition is not None
            else None
        )
        return SearchQuery(
            query=self.query,
            top_n=self.top_n,
            doc_ids=tuple(self.doc_ids) if self.doc_ids is not None else None,
            edition_scope=scope,
            edition=edition,
            expand_neighbors=bool(self.expand_neighbors),
        )


class EvaluationBody(BaseModel):
    """골든셋 한 건 평가 요청 본문이다."""

    query: StrictStr
    doc_id: StrictStr
    answer_span: StrictStr
    edition_only: StrictBool | None = None
    top_n: PositiveInt | None = None

    def to_case(self) -> EvaluationCase:
        """service의 평가 요청으로 바꾼다. null은 빠뜨린 것과 같게 기본값을 쓴다 (G5)."""
        return EvaluationCase(
            query=self.query,
            doc_id=self.doc_id,
            answer_span=self.answer_span,
            edition_only=bool(self.edition_only),
            top_n=self.top_n,
        )


# ── 응답 변환 ─────────────────────────────────────────────────────
# ★ 키 집합은 API.md 표와 정확히 같다. 값이 없는 선택 필드도 키를 빼지 않고 null로 내보낸다


class _ChunkLike(Protocol):
    """검색 결과 청크가 가진 속성이다."""

    @property
    def chunk_id(self) -> str: ...
    @property
    def kind(self) -> str: ...
    @property
    def text(self) -> str: ...
    @property
    def placeholder_ids(self) -> Sequence[str]: ...
    @property
    def split_index(self) -> int | None: ...
    @property
    def split_total(self) -> int | None: ...


class _DocumentChunkLike(_ChunkLike, Protocol):
    """문서 청크 조회 청크가 가진 속성이다."""

    @property
    def order(self) -> int: ...
    @property
    def heading_path(self) -> Sequence[str]: ...
    @property
    def title(self) -> str | None: ...
    @property
    def summary(self) -> str | None: ...


class _MetricsLike(Protocol):
    """평가 지표가 가진 속성이다."""

    @property
    def hit_at_1(self) -> bool: ...
    @property
    def hit_at_3(self) -> bool: ...
    @property
    def hit_at_5(self) -> bool: ...
    @property
    def hit_at_n(self) -> bool: ...
    @property
    def rank(self) -> int | None: ...
    @property
    def reciprocal_rank(self) -> float: ...
    @property
    def coverage(self) -> float: ...


def accepted_payload(accepted: IndexAccepted) -> dict[str, Any]:
    """색인 접수 결과를 IndexJobAccepted로 바꾼다."""
    return {
        "outcome": accepted.outcome,
        "job_id": accepted.job_id,
        "doc_id": accepted.doc_id,
        "version": accepted.version,
    }


def job_payload(job: JobView) -> dict[str, Any]:
    """작업 상태를 IndexJob으로 바꾼다."""
    failure: dict[str, Any] | None = None
    if job.failure is not None:
        location = job.failure.location
        failure = {
            "code": job.failure.code,
            "message": job.failure.message,
            "heading_path": (
                list(location.heading_path)
                if location is not None and location.heading_path is not None
                else None
            ),
            "placeholder_id": location.placeholder_id if location is not None else None,
        }
    result: dict[str, Any] | None = None
    if job.result is not None:
        result = {"chunk_count": job.result.chunk_count, "fallback_used": job.result.fallback_used}
    return {
        "job_id": job.job_id,
        "doc_id": job.doc_id,
        "version": job.version,
        "state": job.state.value,
        "stage": job.stage.value if job.stage is not None else None,
        "failure": failure,
        "result": result,
    }


def index_state_payload(state: IndexStateView) -> dict[str, Any]:
    """문서 색인 상태를 IndexState로 바꾼다."""
    return {
        "doc_id": state.doc_id,
        "searchable_version": state.searchable_version,
        "latest_job_id": state.latest_job_id,
        "latest_job_state": (
            state.latest_job_state.value if state.latest_job_state is not None else None
        ),
        "latest_job_stage": (
            state.latest_job_stage.value if state.latest_job_stage is not None else None
        ),
    }


def _result_chunk(chunk: _ChunkLike) -> dict[str, Any]:
    """검색 결과 청크를 ResultChunk로 바꾼다."""
    return {
        "chunk_id": chunk.chunk_id,
        "kind": str(chunk.kind),
        "text": chunk.text,
        "placeholder_ids": list(chunk.placeholder_ids),
        "split_index": chunk.split_index,
        "split_total": chunk.split_total,
    }


def search_result_payload(hit: SearchHit) -> dict[str, Any]:
    """검색 결과 하나를 SearchResult로 바꾼다."""
    edition = hit.edition
    return {
        "rank": hit.rank,
        "score": hit.score,
        "doc_id": hit.doc_id,
        "version": hit.version,
        "heading_path": list(hit.heading_path),
        "name": hit.name,
        "edition": (
            {
                "label": edition.label,
                "edition_date": edition.edition_date.isoformat(),
                "is_latest": edition.is_latest,
            }
            if edition is not None
            else None
        ),
        "other_editions_in_results": hit.other_editions_in_results,
        "chunks": [_result_chunk(chunk) for chunk in hit.chunks],
        "before": [_result_chunk(chunk) for chunk in hit.before],
        "after": [_result_chunk(chunk) for chunk in hit.after],
    }


def _document_chunk(chunk: _DocumentChunkLike) -> dict[str, Any]:
    """문서 청크 하나를 DocumentChunk로 바꾼다."""
    return {
        "chunk_id": chunk.chunk_id,
        "order": chunk.order,
        "kind": str(chunk.kind),
        "heading_path": list(chunk.heading_path),
        "title": chunk.title,
        "summary": chunk.summary,
        "text": chunk.text,
        "placeholder_ids": list(chunk.placeholder_ids),
        "split_index": chunk.split_index,
        "split_total": chunk.split_total,
    }


def document_chunks_payload(chunks: DocumentChunks) -> dict[str, Any]:
    """문서 청크 조회 결과를 응답 본문으로 바꾼다. doc_id·name·edition은 내보내지 않는다."""
    return {
        "version": chunks.version,
        "items": [_document_chunk(chunk) for chunk in chunks.chunks],
    }


def _metrics(metrics: _MetricsLike) -> dict[str, Any]:
    """평가 지표를 EvaluationMetrics로 바꾼다."""
    return {
        "hit_at_1": metrics.hit_at_1,
        "hit_at_3": metrics.hit_at_3,
        "hit_at_5": metrics.hit_at_5,
        "hit_at_n": metrics.hit_at_n,
        "rank": metrics.rank,
        "reciprocal_rank": metrics.reciprocal_rank,
        "coverage": metrics.coverage,
    }


def evaluation_payload(result: EvaluationResult) -> dict[str, Any]:
    """평가 결과를 EvaluationResult로 바꾼다."""
    return {"n": result.n, "base": _metrics(result.base), "expanded": _metrics(result.expanded)}


def health_payload(health: Health) -> dict[str, str]:
    """연결 상태를 `ok`·`unavailable` 문자열로 바꾼다."""
    return {
        "qdrant": "ok" if health.qdrant else "unavailable",
        "ollama": "ok" if health.ollama else "unavailable",
    }
