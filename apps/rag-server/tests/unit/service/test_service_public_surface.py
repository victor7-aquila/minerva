"""service 공개 표면 고정 테스트 (contract 도구가 없어 api가 기대는 형태를 고정한다)."""

import dataclasses
import inspect
from collections.abc import Mapping
from typing import Any, cast, get_args, get_origin, get_type_hints

import pytest

import minerva_rag.chunking as chunking_unit
import minerva_rag.evaluation as evaluation_unit
import minerva_rag.search as search_unit
import minerva_rag.service as service
from minerva_rag.chunking import Chunker, ChunkingMode
from minerva_rag.core import Edition, FailureLocation, Settings
from minerva_rag.evaluation import EvaluationResult, Evaluator
from minerva_rag.indexing import Indexer
from minerva_rag.resource import ChunkStore, ModelHub
from minerva_rag.search import DocumentChunks, Searcher
from minerva_rag.service import (
    CaptionService,
    DeleteService,
    EvaluationService,
    Health,
    IndexAccepted,
    IndexOutcome,
    IndexRequest,
    IndexService,
    IndexStateView,
    JobFailureInfo,
    JobStage,
    JobState,
    JobView,
    LifecycleService,
    MetadataService,
    SearchService,
    Services,
)
from minerva_rag.service.captioner import Captioner
from minerva_rag.service.jobs import CurrentIndex, JobFailure, JobManager, JobQueue

from .fakes import FakeHub

_EXPECTED_EXPORTS = {
    "build_services",
    "Services",
    "LifecycleService",
    "Health",
    "CaptionService",
    "IndexService",
    "IndexRequest",
    "IndexAccepted",
    "JobView",
    "JobFailureInfo",
    "IndexStateView",
    "JobState",
    "JobStage",
    "IndexOutcome",
    "SearchService",
    "DeleteService",
    "MetadataService",
    "EvaluationService",
    "ChunkingMode",
    "SearchQuery",
    "SearchHit",
    "EditionScope",
    "EditionRef",
    "DocumentChunks",
    "EvaluationCase",
    "EvaluationResult",
}


def _hints(cls: type) -> dict[str, Any]:
    """클래스의 필드 타입 힌트를 돌려준다."""
    return get_type_hints(cls)


def _same_mapping(hint: Any) -> bool:
    """힌트가 Mapping[str, str]인지 확인한다. typing·collections.abc 표기 차이는 따지지 않는다."""
    return get_origin(hint) is Mapping and get_args(hint) == (str, str)


def _params(func: Any) -> list[str]:
    """함수의 매개변수 이름을 순서대로 돌려준다."""
    return list(inspect.signature(func).parameters)


@pytest.mark.req("REQ-RAG-10.1.1")
def test_exports() -> None:
    """[REQ-RAG-10.1.1] 공개 이름이 명세의 목록과 같고 헬퍼는 내보내지 않는다."""
    assert set(service.__all__) == _EXPECTED_EXPORTS
    for helper in ("JobManager", "Captioner", "JobQueue", "ProgressReporter", "JobFailure"):
        assert helper not in service.__all__
    assert "CurrentIndex" not in service.__all__
    for name in _EXPECTED_EXPORTS:
        assert hasattr(service, name)


@pytest.mark.req("REQ-RAG-10.4.1")
def test_reexports_are_originals() -> None:
    """[REQ-RAG-10.4.1] 다시 내보낸 타입 여덟 개가 원래 단위의 객체와 같다."""
    assert service.ChunkingMode is chunking_unit.ChunkingMode
    assert service.SearchQuery is search_unit.SearchQuery
    assert service.SearchHit is search_unit.SearchHit
    assert service.EditionScope is search_unit.EditionScope
    assert service.EditionRef is search_unit.EditionRef
    assert service.DocumentChunks is search_unit.DocumentChunks
    assert service.EvaluationCase is evaluation_unit.EvaluationCase
    assert service.EvaluationResult is evaluation_unit.EvaluationResult


@pytest.mark.req("REQ-RAG-10.3.1")
def test_index_request_fields() -> None:
    """[REQ-RAG-10.3.1] IndexRequest의 필드 이름·타입·기본값이 명세와 같다."""
    hints = _hints(IndexRequest)
    assert set(hints) == {
        "doc_id",
        "version",
        "markdown",
        "name",
        "assets",
        "edition",
        "chunking",
        "force",
    }
    for name in ("doc_id", "version", "markdown", "name"):
        assert hints[name] is str
    assert _same_mapping(hints["assets"])
    assert hints["edition"] == Edition | None
    assert hints["chunking"] is ChunkingMode
    assert hints["force"] is bool
    req = IndexRequest(doc_id="d", version="v", markdown="m", name="n", assets={})
    assert req.edition is None
    assert req.chunking is ChunkingMode.SEMANTIC
    assert req.force is False


@pytest.mark.req("REQ-RAG-10.3.1")
@pytest.mark.req("REQ-RAG-10.1.2")
def test_accepted_and_health_fields() -> None:
    """[REQ-RAG-10.3.1] IndexAccepted·Health의 필드 이름·타입이 명세와 같다."""
    accepted = {f.name for f in dataclasses.fields(IndexAccepted)}
    assert accepted == {"outcome", "job_id", "doc_id", "version"}
    hints = _hints(IndexAccepted)
    assert hints["job_id"] is str
    assert hints["doc_id"] is str
    assert hints["version"] is str
    assert _hints(Health) == {"qdrant": bool, "ollama": bool}


@pytest.mark.req("REQ-RAG-10.1.1")
def test_services_fields() -> None:
    """[REQ-RAG-10.1.1] Services가 일곱 서비스를 필드로 가진다."""
    assert _hints(Services) == {
        "lifecycle": LifecycleService,
        "caption": CaptionService,
        "index": IndexService,
        "search": SearchService,
        "delete": DeleteService,
        "metadata": MetadataService,
        "evaluation": EvaluationService,
    }


@pytest.mark.req("REQ-RAG-10.8.2.1")
@pytest.mark.req("REQ-RAG-10.8.2.3")
def test_job_enums() -> None:
    """[REQ-RAG-10.8.2.1] JobState·JobStage의 값이 명세와 같다."""
    assert {m.value for m in JobState} == {
        "queued",
        "running",
        "succeeded",
        "failed",
        "superseded",
    }
    assert {m.value for m in JobStage} == {"chunking", "embedding", "storing"}


@pytest.mark.req("REQ-RAG-10.8.2.2")
@pytest.mark.req("REQ-RAG-10.8.6.2")
def test_view_fields() -> None:
    """[REQ-RAG-10.8.2.2] 작업·색인 상태 데이터 타입의 필드 이름·타입이 명세와 같다."""
    assert _hints(JobView) == {
        "job_id": str,
        "doc_id": str,
        "version": str,
        "state": JobState,
        "stage": JobStage | None,
        "failure": JobFailureInfo | None,
        "result": IndexOutcome | None,
    }
    assert _hints(JobFailureInfo) == {
        "code": str,
        "message": str,
        "location": FailureLocation | None,
    }
    assert _hints(IndexStateView) == {
        "doc_id": str,
        "searchable_version": str | None,
        "latest_job_id": str | None,
        "latest_job_state": JobState | None,
        "latest_job_stage": JobStage | None,
    }
    assert _hints(IndexOutcome) == {"chunk_count": int, "fallback_used": bool}
    assert _hints(CurrentIndex) == {"job_id": str, "version": str, "checksum": str}


_METHODS: list[tuple[type, str, list[str]]] = [
    (LifecycleService, "startup", ["self"]),
    (LifecycleService, "shutdown", ["self"]),
    (LifecycleService, "health", ["self"]),
    (CaptionService, "summarize_table", ["self", "table_markdown"]),
    (CaptionService, "caption_image", ["self", "image"]),
    (IndexService, "submit", ["self", "req"]),
    (IndexService, "get_job", ["self", "job_id"]),
    (IndexService, "index_state", ["self", "doc_id"]),
    (IndexService, "index_states", ["self", "doc_ids"]),
    (SearchService, "search", ["self", "q"]),
    (SearchService, "document_chunks", ["self", "doc_id"]),
    (DeleteService, "delete", ["self", "doc_id"]),
    (MetadataService, "update", ["self", "doc_id", "name", "edition"]),
    (EvaluationService, "evaluate", ["self", "case"]),
    (Captioner, "summarize_table", ["self", "table_markdown"]),
    (Captioner, "caption_image", ["self", "image"]),
]


@pytest.mark.req("REQ-RAG-10.1.1")
@pytest.mark.parametrize(("cls", "method", "params"), _METHODS)
def test_service_methods(cls: type, method: str, params: list[str]) -> None:
    """[REQ-RAG-10.1.1] 서비스 메서드가 코루틴 함수이고 매개변수 이름이 명세와 같다."""
    func = getattr(cls, method)
    assert inspect.iscoroutinefunction(func)
    assert _params(func) == params


@pytest.mark.req("REQ-RAG-10.1.1")
def test_ready_is_property() -> None:
    """[REQ-RAG-10.1.1] LifecycleService.ready는 property다."""
    assert isinstance(inspect.getattr_static(LifecycleService, "ready"), property)


@pytest.mark.req("REQ-RAG-10.3.1")
def test_service_return_types() -> None:
    """[REQ-RAG-10.3.1] 서비스 메서드의 반환 타입이 명세와 같다."""
    hints = get_type_hints(IndexService.submit)
    assert hints["return"] is IndexAccepted
    assert get_type_hints(IndexService.get_job)["return"] is JobView
    assert get_type_hints(IndexService.index_state)["return"] is IndexStateView
    states = get_type_hints(IndexService.index_states)["return"]
    assert get_origin(states) is list
    assert get_args(states) == (IndexStateView,)
    assert get_type_hints(LifecycleService.health)["return"] is Health
    assert get_type_hints(SearchService.document_chunks)["return"] is DocumentChunks
    assert get_type_hints(EvaluationService.evaluate)["return"] is EvaluationResult


@pytest.mark.req("REQ-RAG-10.1.1")
def test_service_constructors() -> None:
    """[REQ-RAG-10.1.1] 서비스 생성자의 매개변수 이름과 타입이 명세와 같다."""
    expected: dict[type, list[str]] = {
        LifecycleService: [
            "self",
            "model_hub",
            "chunk_store",
            "searcher",
            "indexer",
            "jobs",
            "settings",
        ],
        CaptionService: ["self", "captioner", "readiness"],
        IndexService: ["self", "chunker", "indexer", "jobs", "readiness"],
        SearchService: ["self", "searcher", "readiness"],
        DeleteService: ["self", "indexer", "jobs", "readiness"],
        MetadataService: ["self", "indexer", "jobs", "readiness"],
        EvaluationService: ["self", "evaluator", "readiness"],
    }
    for cls, params in expected.items():
        assert _params(cls.__init__) == params, cls.__name__
    life = get_type_hints(LifecycleService.__init__)
    assert life["model_hub"] is ModelHub
    assert life["chunk_store"] is ChunkStore
    assert life["searcher"] is Searcher
    assert life["indexer"] is Indexer
    assert life["jobs"] is JobQueue
    assert life["settings"] is Settings
    assert get_type_hints(CaptionService.__init__)["captioner"] is Captioner
    index = get_type_hints(IndexService.__init__)
    assert index["chunker"] is Chunker
    assert index["indexer"] is Indexer
    assert index["jobs"] is JobManager
    assert get_type_hints(SearchService.__init__)["searcher"] is Searcher
    assert get_type_hints(DeleteService.__init__)["jobs"] is JobManager
    assert get_type_hints(MetadataService.__init__)["jobs"] is JobQueue
    assert get_type_hints(EvaluationService.__init__)["evaluator"] is Evaluator


@pytest.mark.req("REQ-RAG-10.8.1.1")
def test_job_helpers_surface(settings: Settings) -> None:
    """[REQ-RAG-10.8.1.1] 작업 관리·요약 헬퍼의 표면이 명세와 같고 만들 때 I/O가 없다."""
    JobManager(settings)
    assert not settings.jobs_db_path.exists()
    assert not settings.jobs_db_path.parent.exists()
    names = [
        "start",
        "stop",
        "submit",
        "find_open",
        "fail_queued",
        "wait_running",
        "get_job",
        "index_state",
        "index_states",
        "current_index",
        "forget_document",
    ]
    assert _params(JobManager.__init__) == ["self", "settings"]
    for name in names:
        assert inspect.iscoroutinefunction(getattr(JobManager, name)), name
    assert _params(JobManager.start) == ["self", "recover"]
    assert _params(JobManager.stop) == ["self", "timeout_seconds"]
    assert _params(JobManager.submit) == ["self", "doc_id", "version", "checksum", "run"]
    assert _params(JobManager.find_open) == ["self", "doc_id", "checksum"]
    assert _params(JobManager.fail_queued) == ["self", "doc_id", "code", "message"]
    assert _params(JobManager.wait_running) == ["self", "doc_id"]
    assert _params(JobManager.get_job) == ["self", "job_id"]
    assert _params(JobManager.index_states) == ["self", "doc_ids"]
    assert _params(Captioner.__init__) == ["self", "model_hub"]
    Captioner(cast(ModelHub, FakeHub()))
    location = FailureLocation(("제목",), "t1")
    failure = JobFailure("CODE", "설명", location)
    assert (failure.code, failure.message, failure.location) == ("CODE", "설명", location)
    assert JobFailure("CODE", "설명").location is None
