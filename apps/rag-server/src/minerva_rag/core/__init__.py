"""minerva RAG Server core 단위."""

from .errors import (
    CaptionFailedError,
    ChunkingFailedError,
    DocumentNotSearchableError,
    GlossaryError,
    InvalidRequestError,
    JobFailureCode,
    JobNotFoundError,
    MinervaError,
    ModelLoadError,
    ModelUnavailableError,
    PayloadTooLargeError,
    PromptTooLongError,
    ServerNotReadyError,
    ShuttingDownError,
    StoreUnavailableError,
    UnauthorizedError,
    VectorDimensionMismatchError,
)
from .logs import configure_logging, get_logger
from .placeholder import Placeholder, find_placeholders
from .settings import Settings, get_settings
from .shared import (
    Chunk,
    ChunkingResult,
    ChunkKind,
    ChunkRecord,
    Edition,
    FailureLocation,
    SparseVector,
)

__all__ = [
    # 설정
    "Settings",
    "get_settings",
    # 로그
    "configure_logging",
    "get_logger",
    # 오류
    "MinervaError",
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
    "JobFailureCode",
    # 공유 타입
    "ChunkKind",
    "Chunk",
    "ChunkingResult",
    "Edition",
    "ChunkRecord",
    "Placeholder",
    "find_placeholders",
    "FailureLocation",
    "SparseVector",
]
