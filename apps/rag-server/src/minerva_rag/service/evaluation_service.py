"""평가 서비스: 작업 없이 바로 처리한다 (REQ-RAG-10.7)."""

from minerva_rag.core import get_logger
from minerva_rag.evaluation import EvaluationCase, EvaluationResult, Evaluator

from ._guard import Readiness, guarded

log = get_logger(__name__)


class EvaluationService:
    """평가 요청을 Evaluator에 넘기고 결과를 그대로 돌려준다."""

    def __init__(self, evaluator: Evaluator, readiness: Readiness) -> None:
        """평가기와 준비 상태를 받는다. I/O는 하지 않는다."""
        self._evaluator = evaluator
        self._readiness = readiness

    async def evaluate(self, case: EvaluationCase) -> EvaluationResult:
        """골든셋 한 건을 평가한다."""
        log.info(
            "service.evaluation.evaluate",
            doc_id=case.doc_id,
            query_chars=len(case.query),
            answer_span_chars=len(case.answer_span),
            edition_only=case.edition_only,
            top_n=case.top_n,
        )
        with guarded(log, "evaluation.evaluate", self._readiness):
            return await self._evaluator.evaluate(case)
