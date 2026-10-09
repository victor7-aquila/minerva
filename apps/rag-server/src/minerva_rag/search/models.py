"""검색 요청과 결과의 공개 데이터 타입이다 (REQ-RAG-4.3, REQ-RAG-4.5, REQ-RAG-4.7)."""

from dataclasses import dataclass
from datetime import date
from enum import StrEnum

from minerva_rag.core import ChunkKind, Edition


class EditionScope(StrEnum):
    """검색의 판 범위다."""

    ALL = "all"
    LATEST = "latest"
    SPECIFIC = "specific"


@dataclass(frozen=True)
class EditionRef:
    """이름과 판 표기로 가리킨 판이다."""

    name: str
    label: str


@dataclass(frozen=True)
class SearchQuery:
    """검색 한 번의 요청이다."""

    query: str
    top_n: int | None = None
    doc_ids: tuple[str, ...] | None = None
    edition_scope: EditionScope = EditionScope.ALL
    edition: EditionRef | None = None
    expand_neighbors: bool = False

    def __post_init__(self) -> None:
        """top_n 범위와 SPECIFIC의 edition 유무를 검사한다."""
        if self.top_n is not None and self.top_n < 1:
            raise ValueError("top_n은 1 이상이어야 합니다")
        # ★ SPECIFIC이 아니면 edition은 값을 지우지 않고 쓰지만 않는다
        if self.edition_scope is EditionScope.SPECIFIC and self.edition is None:
            raise ValueError("판을 지정한 검색에는 edition이 필요합니다")


@dataclass(frozen=True)
class ResultChunk:
    """결과에 담는 청크 하나다. 값은 레코드의 같은 이름 필드 그대로다."""

    chunk_id: str
    kind: ChunkKind
    text: str
    placeholder_ids: tuple[str, ...]
    split_index: int | None
    split_total: int | None


@dataclass(frozen=True)
class ResultEdition:
    """결과 문서의 판 정보다."""

    label: str
    edition_date: date
    is_latest: bool


@dataclass(frozen=True)
class SearchHit:
    """검색 결과 하나다."""

    rank: int
    score: float
    doc_id: str
    version: str
    heading_path: tuple[str, ...]
    name: str
    edition: ResultEdition | None
    other_editions_in_results: bool
    chunks: tuple[ResultChunk, ...]
    before: tuple[ResultChunk, ...]
    after: tuple[ResultChunk, ...]


@dataclass(frozen=True)
class DocumentChunk:
    """문서 청크 조회의 청크 하나다. 값은 레코드의 같은 이름 필드 그대로다."""

    chunk_id: str
    order: int
    kind: ChunkKind
    heading_path: tuple[str, ...]
    title: str | None
    summary: str | None
    text: str
    placeholder_ids: tuple[str, ...]
    split_index: int | None
    split_total: int | None


@dataclass(frozen=True)
class DocumentChunks:
    """문서 하나의 지금 검색되는 청크 목록이다."""

    doc_id: str
    version: str | None
    name: str | None
    edition: Edition | None
    chunks: tuple[DocumentChunk, ...]
