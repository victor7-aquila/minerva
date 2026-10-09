"""평가 한 번의 흐름 (REQ-RAG-6)."""

import asyncio
import time
from collections.abc import Callable

from minerva_rag.core import (
    DocumentNotSearchableError,
    InvalidRequestError,
    Settings,
    get_logger,
)
from minerva_rag.search import EditionScope, Searcher, SearchHit, SearchQuery

from .metrics import measure_both, strip_whitespace
from .models import EvaluationCase, EvaluationResult

log = get_logger(__name__)


def _candidate_rule(case: EvaluationCase, answer_name: str | None) -> Callable[[SearchHit], bool]:
    """판 지정 여부에 따른 적중 후보 판정 함수를 돌려준다."""
    if case.edition_only:
        return lambda h: h.doc_id == case.doc_id
    return lambda h: answer_name is not None and h.name == answer_name


class Evaluator:
    """골든셋 한 건으로 검색 품질 지표를 계산한다."""

    def __init__(self, searcher: Searcher, settings: Settings) -> None:
        """search와 설정을 받는다. I/O는 하지 않는다."""
        self._searcher = searcher
        self._settings = settings

    async def evaluate(self, case: EvaluationCase) -> EvaluationResult:
        """정답 문서를 확인하고 검색 한 번의 결과로 확장 전·후 지표를 계산한다."""
        started = time.perf_counter()
        span = strip_whitespace(case.answer_span)
        # ★ 검색 전에 막는다. 비면 포함 비율이 0으로 나누기가 된다
        if not span:
            raise InvalidRequestError("정답 원문 구간이 비어 있습니다")
        n = case.top_n if case.top_n is not None else self._settings.search_default_top_n
        doc = await self._searcher.document_chunks(case.doc_id)
        if doc.version is None:
            raise DocumentNotSearchableError()
        hits = await self._searcher.search(
            SearchQuery(
                case.query,
                top_n=n,
                edition_scope=EditionScope.ALL,
                expand_neighbors=True,
            )
        )
        rule = _candidate_rule(case, doc.name)
        # ★ CPU 작업이라 이벤트 루프 밖에서 돌린다
        base, expanded = await asyncio.to_thread(measure_both, hits, span, rule, n)
        log.info(
            "evaluation.done",
            doc_id=case.doc_id,
            n=n,
            base_rank=base.rank,
            expanded_rank=expanded.rank,
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )
        return EvaluationResult(n=n, base=base, expanded=expanded)
