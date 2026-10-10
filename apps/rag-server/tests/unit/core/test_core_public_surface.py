"""core 공개 표면 고정 테스트 (contract 역할 미검증 보완).

다른 7개 모듈이 기대는 심볼·시그니처·dataclass 필드를 고정한다.
"""

import dataclasses
import inspect
from datetime import date
from typing import Any, get_type_hints

import pydantic_settings
import pytest

import minerva_rag.core as core
from minerva_rag.core import (
    Chunk,
    ChunkingFailedError,
    ChunkingResult,
    ChunkRecord,
    Edition,
    FailureLocation,
    MinervaError,
    Placeholder,
    Settings,
    SparseVector,
    configure_logging,
    find_placeholders,
    get_logger,
    get_settings,
)

ERROR_CLASS_NAMES = {
    "InvalidRequestError",
    "UnauthorizedError",
    "PayloadTooLargeError",
    "JobNotFoundError",
    "DocumentNotSearchableError",
    "CaptionFailedError",
    "ModelUnavailableError",
    "PromptTooLongError",
    "GlossaryError",
    "ModelLoadError",
    "StoreUnavailableError",
    "VectorDimensionMismatchError",
    "ChunkingFailedError",
    "ServerNotReadyError",
    "ShuttingDownError",
}

EXPECTED_SYMBOLS = {
    "Settings",
    "get_settings",
    "configure_logging",
    "get_logger",
    "MinervaError",
    "JobFailureCode",
    "ChunkKind",
    "Chunk",
    "ChunkingResult",
    "Edition",
    "ChunkRecord",
    "Placeholder",
    "find_placeholders",
    "FailureLocation",
    "SparseVector",
} | ERROR_CLASS_NAMES


def _is_frozen(cls: Any) -> bool:
    """dataclass가 frozen=True인지 돌려준다."""
    return bool(vars(cls)["__dataclass_params__"].frozen)


def _field_names(cls: Any) -> list[str]:
    """dataclass 필드 이름을 선언 순서대로 돌려준다."""
    return [f.name for f in dataclasses.fields(cls)]


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.req("REQ-RAG-11.2.1")
@pytest.mark.req("REQ-RAG-11.3.1")
def test_public_symbols() -> None:
    """[REQ-RAG-11.1.1][REQ-RAG-11.2.1][REQ-RAG-11.3.1] 공개 심볼이 core에서 import된다."""
    missing = {name for name in EXPECTED_SYMBOLS if not hasattr(core, name)}
    assert missing == set()


@pytest.mark.req("REQ-RAG-11.1.1")
def test_settings_surface() -> None:
    """[REQ-RAG-11.1.1] Settings는 BaseSettings이고 get_settings()는 인자 없이 Settings를 준다."""
    assert issubclass(Settings, pydantic_settings.BaseSettings)
    assert list(inspect.signature(get_settings).parameters) == []
    assert get_type_hints(get_settings)["return"] is Settings
    assert callable(get_settings.cache_clear)


@pytest.mark.req("REQ-RAG-11.2.1")
def test_logging_surface() -> None:
    """[REQ-RAG-11.2.1] configure_logging()은 인자·반환이 없고 get_logger()는 name 하나를 받는다."""
    assert list(inspect.signature(configure_logging).parameters) == []
    assert get_type_hints(configure_logging)["return"] is type(None)
    params = inspect.signature(get_logger).parameters
    assert list(params) == ["name"]
    assert get_type_hints(get_logger)["name"] is str


@pytest.mark.req("REQ-RAG-11.3.1")
def test_error_surface() -> None:
    """[REQ-RAG-11.3.1] MinervaError·ChunkingFailedError의 생성자·속성이 명세 시그니처와 같다."""
    base = inspect.signature(MinervaError.__init__).parameters
    assert list(base) == ["self", "message"]
    assert base["message"].default is None
    assert isinstance(MinervaError.message, property)

    chunking = inspect.signature(ChunkingFailedError.__init__).parameters
    assert list(chunking) == ["self", "message", "location"]
    assert chunking["message"].default is None
    assert chunking["location"].kind is inspect.Parameter.KEYWORD_ONLY
    assert chunking["location"].default is None
    assert isinstance(ChunkingFailedError.location, property)


@pytest.mark.req("REQ-RAG-2")
@pytest.mark.req("REQ-RAG-3")
def test_if_rag_1_fields() -> None:
    """[REQ-RAG-2][REQ-RAG-3] IF-RAG-1 타입의 필드 이름·순서·타입이 계약과 같고 frozen이다."""
    chunk_hints = get_type_hints(Chunk)
    assert _field_names(Chunk) == [
        "chunk_key",
        "kind",
        "order",
        "heading_path",
        "title",
        "summary",
        "text",
        "placeholder_ids",
        "split_group",
        "split_index",
        "split_total",
    ]
    assert chunk_hints["heading_path"] == tuple[str, ...]
    assert chunk_hints["title"] == (str | None)
    assert chunk_hints["summary"] == (str | None)
    assert chunk_hints["placeholder_ids"] == tuple[str, ...]
    assert chunk_hints["split_group"] == (str | None)
    assert chunk_hints["split_index"] == (int | None)
    assert chunk_hints["split_total"] == (int | None)
    assert chunk_hints["order"] is int

    assert _field_names(ChunkingResult) == ["chunks", "fallback_used"]
    result_hints = get_type_hints(ChunkingResult)
    assert result_hints["chunks"] == tuple[Chunk, ...]
    assert result_hints["fallback_used"] is bool

    assert _field_names(Edition) == ["label", "edition_date"]
    assert get_type_hints(Edition)["edition_date"] is date

    assert _field_names(ChunkRecord) == [
        "chunk_id",
        "doc_id",
        "version",
        "job_id",
        "active",
        "name",
        "edition",
        "is_latest_edition",
        "chunk",
    ]
    record_hints = get_type_hints(ChunkRecord)
    assert record_hints["edition"] == (Edition | None)
    assert record_hints["chunk"] is Chunk
    assert record_hints["active"] is bool

    for cls in (Chunk, ChunkingResult, Edition, ChunkRecord):
        assert _is_frozen(cls), cls.__name__


@pytest.mark.req("REQ-RAG-2.2.1")
def test_placeholder_surface() -> None:
    """[REQ-RAG-2.2.1] Placeholder 필드와 find_placeholders 시그니처가 명세와 같다."""
    assert _field_names(Placeholder) == ["kind", "placeholder_id", "raw", "start", "end"]
    hints = get_type_hints(Placeholder)
    assert [hints[name] for name in _field_names(Placeholder)] == [str, str, str, int, int]
    assert _is_frozen(Placeholder)
    assert list(inspect.signature(find_placeholders).parameters) == ["text"]
    assert get_type_hints(find_placeholders)["text"] is str


@pytest.mark.req("REQ-RAG-10.8.2.5")
def test_failure_location_surface() -> None:
    """[REQ-RAG-10.8.2.5] FailureLocation의 필드 타입이 명세와 같고 frozen이다."""
    assert _field_names(FailureLocation) == ["heading_path", "placeholder_id"]
    hints = get_type_hints(FailureLocation)
    assert hints["heading_path"] == (tuple[str, ...] | None)
    assert hints["placeholder_id"] == (str | None)
    assert _is_frozen(FailureLocation)


@pytest.mark.req("REQ-RAG-3.2.2")
def test_sparse_vector_surface() -> None:
    """[REQ-RAG-3.2.2] SparseVector의 필드 타입이 명세와 같고 frozen이다."""
    assert _field_names(SparseVector) == ["indices", "values"]
    hints = get_type_hints(SparseVector)
    assert hints["indices"] == tuple[int, ...]
    assert hints["values"] == tuple[float, ...]
    assert _is_frozen(SparseVector)
