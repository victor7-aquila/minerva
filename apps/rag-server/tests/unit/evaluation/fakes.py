"""evaluation 단위 테스트의 가짜 Searcher와 만들기 도우미 (대체 경계)."""

from collections.abc import Sequence
from typing import cast

from minerva_rag.core import ChunkKind, Settings
from minerva_rag.evaluation import EvaluationCase, Evaluator
from minerva_rag.search import DocumentChunks, ResultChunk, Searcher, SearchHit, SearchQuery

DOC_ID = "doc-1"
DOC_NAME = "인증 가이드"
SPAN = "ABCDEFGHIJKLMNOPQRST"  # 서로 다른 글자 20자
FIRST = SPAN[:10]
SECOND = SPAN[10:]


class FakeSearcher:
    """evaluation이 쓰는 Searcher 표면만 흉내 내고 호출을 기록한다."""

    def __init__(
        self, hits: Sequence[SearchHit] = (), *, doc: DocumentChunks | None = None
    ) -> None:
        self.hits = tuple(hits)
        self.doc = doc if doc is not None else searchable_doc()
        self.calls: list[str] = []
        self.queries: list[SearchQuery] = []
        self.doc_ids: list[str] = []
        self.search_error: BaseException | None = None
        self.chunks_error: BaseException | None = None

    async def document_chunks(self, doc_id: str) -> DocumentChunks:
        """호출을 기록하고 정해 둔 문서 청크를 돌려준다. 오류가 정해져 있으면 낸다."""
        self.calls.append("document_chunks")
        self.doc_ids.append(doc_id)
        if self.chunks_error is not None:
            raise self.chunks_error
        return self.doc

    async def search(self, q: SearchQuery) -> tuple[SearchHit, ...]:
        """호출을 기록하고 정해 둔 결과를 돌려준다. 오류가 정해져 있으면 낸다."""
        self.calls.append("search")
        self.queries.append(q)
        if self.search_error is not None:
            raise self.search_error
        return self.hits


def make_evaluator(fake: FakeSearcher, settings: Settings) -> Evaluator:
    """가짜 Searcher로 Evaluator를 만든다."""
    return Evaluator(cast(Searcher, fake), settings)


def chunk(text: str, cid: str = "c") -> ResultChunk:
    """본문 청크 하나를 만든다."""
    return ResultChunk(
        chunk_id=cid,
        kind=ChunkKind.TEXT,
        text=text,
        placeholder_ids=(),
        split_index=None,
        split_total=None,
    )


def hit(
    rank: int,
    *texts: str,
    doc_id: str = DOC_ID,
    name: str = DOC_NAME,
    before: Sequence[str] = (),
    after: Sequence[str] = (),
) -> SearchHit:
    """청크 본문들로 검색 결과 하나를 만든다."""
    return SearchHit(
        rank=rank,
        score=1.0 / rank,
        doc_id=doc_id,
        version="v1",
        heading_path=(),
        name=name,
        edition=None,
        other_editions_in_results=False,
        chunks=tuple(chunk(t, f"c{rank}-{i}") for i, t in enumerate(texts)),
        before=tuple(chunk(t, f"b{rank}-{i}") for i, t in enumerate(before)),
        after=tuple(chunk(t, f"a{rank}-{i}") for i, t in enumerate(after)),
    )


def filler(rank: int, *, doc_id: str = DOC_ID, name: str = DOC_NAME) -> SearchHit:
    """정답 구간과 겹치지 않는 본문의 결과를 만든다."""
    return hit(rank, "xxxxxxxxxx", doc_id=doc_id, name=name)


def searchable_doc(doc_id: str = DOC_ID, name: str = DOC_NAME) -> DocumentChunks:
    """검색되는 버전이 있는 문서를 만든다."""
    return DocumentChunks(doc_id=doc_id, version="v1", name=name, edition=None, chunks=())


def unsearchable_doc(doc_id: str = DOC_ID) -> DocumentChunks:
    """검색되는 버전이 없는 문서를 만든다."""
    return DocumentChunks(doc_id=doc_id, version=None, name=None, edition=None, chunks=())


def case(
    *,
    query: str = "인증서 갱신 방법",
    doc_id: str = DOC_ID,
    answer_span: str = SPAN,
    edition_only: bool = False,
    top_n: int | None = 5,
) -> EvaluationCase:
    """평가 입력을 만든다."""
    return EvaluationCase(
        query=query,
        doc_id=doc_id,
        answer_span=answer_span,
        edition_only=edition_only,
        top_n=top_n,
    )
