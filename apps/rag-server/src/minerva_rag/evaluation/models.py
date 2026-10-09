"""evaluation 단위의 공개 데이터 타입."""

from dataclasses import dataclass


@dataclass(frozen=True)
class EvaluationCase:
    """골든셋 한 건의 평가 요청이다."""

    query: str
    doc_id: str
    answer_span: str
    edition_only: bool = False
    top_n: int | None = None

    def __post_init__(self) -> None:
        """top_n 범위를 검사한다."""
        if self.top_n is not None and self.top_n < 1:
            raise ValueError("top_n은 1 이상이어야 합니다")
        # ★ answer_span의 "공백을 지운 뒤 비어 있지 않다"는 여기서 검사하지 않는다.
        #   evaluate가 InvalidRequestError로 막는다 (api가 API.md 제약만 거르므로 400이 되어야 한다)


@dataclass(frozen=True)
class EvaluationMetrics:
    """확장 전 또는 후의 평가 지표다."""

    hit_at_1: bool
    hit_at_3: bool
    hit_at_5: bool
    hit_at_n: bool
    rank: int | None
    reciprocal_rank: float
    coverage: float


@dataclass(frozen=True)
class EvaluationResult:
    """평가 한 번의 결과다."""

    n: int
    base: EvaluationMetrics
    expanded: EvaluationMetrics
