"""core 단위가 소유하는 공유 타입이다 (IF-RAG-1, 실패 위치, 키워드 벡터)."""

from dataclasses import dataclass
from datetime import date
from enum import StrEnum


class ChunkKind(StrEnum):
    """청크의 종류다."""

    TEXT = "text"  # 본문 청크
    ASSET = "asset"  # 표·이미지 청크


@dataclass(frozen=True)
class Chunk:
    """chunking이 만들어 indexing에 넘기는 청크다."""

    chunk_key: str
    kind: ChunkKind
    order: int
    heading_path: tuple[str, ...]
    title: str | None
    summary: str | None
    text: str
    placeholder_ids: tuple[str, ...]
    split_group: str | None
    split_index: int | None
    split_total: int | None


@dataclass(frozen=True)
class ChunkingResult:
    """chunking의 결과다."""

    chunks: tuple[Chunk, ...]
    fallback_used: bool


@dataclass(frozen=True)
class Edition:
    """문서의 판 정보다."""

    label: str
    edition_date: date


@dataclass(frozen=True)
class ChunkRecord:
    """indexing이 resource로 저장하고 search가 읽는 청크 레코드다."""

    chunk_id: str
    doc_id: str
    version: str
    job_id: str
    active: bool
    name: str
    edition: Edition | None
    is_latest_edition: bool
    chunk: Chunk


@dataclass(frozen=True)
class FailureLocation:
    """실패가 생긴 문서 안 위치다."""

    heading_path: tuple[str, ...] | None
    placeholder_id: str | None


@dataclass(frozen=True)
class SparseVector:
    """BM25 키워드 벡터다."""

    indices: tuple[int, ...]
    values: tuple[float, ...]

    def __post_init__(self) -> None:
        """indices와 values의 길이가 같고 indices가 겹치지 않는지 검사한다."""
        if len(self.indices) != len(self.values):
            raise ValueError("indices와 values의 길이가 다릅니다")
        if len(set(self.indices)) != len(self.indices):
            raise ValueError("indices에 같은 값이 두 번 나옵니다")
