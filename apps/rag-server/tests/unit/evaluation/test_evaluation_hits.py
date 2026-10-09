"""evaluation 적중·순위·Hit@k·확장 전후(REQ-RAG-6.2.3~6.2.6) 테스트."""

import pytest

from minerva_rag.core import Settings
from minerva_rag.evaluation import EvaluationMetrics

from ..resource.fakes import run
from .fakes import FIRST, SECOND, SPAN, FakeSearcher, case, filler, hit, make_evaluator

_PLACEHOLDER = "[[minerva:table:t1 | 표 설명]]"


# ── 적중 (REQ-RAG-6.2.3) ──────────────────────────────────────────


@pytest.mark.req("REQ-RAG-6.2.3")
def test_span_inside_one_chunk(settings: Settings) -> None:
    """[REQ-RAG-6.2.3] 정답 구간이 한 청크 안에 통째로 있으면 적중이다."""
    fake = FakeSearcher([hit(1, "xx" + SPAN + "yy")])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank == 1


@pytest.mark.req("REQ-RAG-6.2.3")
def test_span_across_fragments(settings: Settings) -> None:
    """[REQ-RAG-6.2.3] 분할 조각 둘에 걸친 구간은 조각을 합친 결과 하나에서 적중이다."""
    fake = FakeSearcher([hit(1, "xx" + FIRST, SECOND + "yy")])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank == 1
    assert result.expanded.rank == 1


@pytest.mark.req("REQ-RAG-6.2.3")
def test_span_into_before_only_expanded(settings: Settings) -> None:
    """[REQ-RAG-6.2.3] 앞 청크까지 걸친 구간은 확장 후에만 적중이다."""
    fake = FakeSearcher([hit(1, SECOND + "yy", before=["xx" + FIRST])])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank is None
    assert result.expanded.rank == 1


@pytest.mark.req("REQ-RAG-6.2.3")
def test_partial_span_is_not_hit(settings: Settings) -> None:
    """[REQ-RAG-6.2.3] 구간의 일부만 든 결과는 적중이 아니다."""
    fake = FakeSearcher([hit(1, SPAN[:-1])])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank is None
    assert result.expanded.rank is None


@pytest.mark.req("REQ-RAG-6.2.3")
def test_span_split_across_results_not_hit(settings: Settings) -> None:
    """[REQ-RAG-6.2.3] 구간이 결과 둘에 나뉘면 적중이 아니다(결과 하나 안에 통째로 있어야 한다)."""
    fake = FakeSearcher([hit(1, FIRST), hit(2, SECOND)])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank is None
    assert result.expanded.rank is None


@pytest.mark.req("REQ-RAG-6.2.3")
def test_placeholder_kept_in_body(settings: Settings) -> None:
    """[REQ-RAG-6.2.3] 결과 본문의 자리표시는 그대로 비교하므로 사이에 낀 구간은 적중이 아니다."""
    fake = FakeSearcher([hit(1, FIRST + _PLACEHOLDER + SECOND)])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank is None
    assert result.base.coverage == pytest.approx(0.5)


# ── 순위·역순위 (REQ-RAG-6.2.4) ───────────────────────────────────


@pytest.mark.req("REQ-RAG-6.2.4")
def test_rank_three(settings: Settings) -> None:
    """[REQ-RAG-6.2.4] 3위가 처음 적중이면 rank 3, 역순위 1/3이다."""
    fake = FakeSearcher([filler(1), filler(2), hit(3, SPAN), hit(4, SPAN)])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank == 3
    assert result.base.reciprocal_rank == pytest.approx(1 / 3)


@pytest.mark.req("REQ-RAG-6.2.4")
def test_rank_one(settings: Settings) -> None:
    """[REQ-RAG-6.2.4] 1위가 적중이면 rank 1, 역순위 1이다."""
    fake = FakeSearcher([hit(1, SPAN)])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank == 1
    assert result.base.reciprocal_rank == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.4")
def test_no_hit(settings: Settings) -> None:
    """[REQ-RAG-6.2.4] 적중이 없으면 rank는 None, 역순위는 0이다."""
    fake = FakeSearcher([filler(1), filler(2), filler(3)])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank is None
    assert result.base.reciprocal_rank == 0


# ── Hit@1·3·5·N (REQ-RAG-6.2.5) ───────────────────────────────────


def _flags(m: EvaluationMetrics) -> tuple[bool, bool, bool, bool]:
    """Hit@k 네 값을 묶어 돌려준다."""
    return (m.hit_at_1, m.hit_at_3, m.hit_at_5, m.hit_at_n)


@pytest.mark.req("REQ-RAG-6.2.5")
def test_first_hit_at_four(settings: Settings) -> None:
    """[REQ-RAG-6.2.5] 처음 적중이 4위면 Hit@1·3은 거짓, Hit@5·N은 참이다."""
    fake = FakeSearcher([filler(1), filler(2), filler(3), hit(4, SPAN), filler(5)])
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=5)))
    assert _flags(result.base) == (False, False, True, True)


@pytest.mark.req("REQ-RAG-6.2.5")
def test_n_three_no_hit(settings: Settings) -> None:
    """[REQ-RAG-6.2.5] N이 3이고 적중이 없으면 넷 다 거짓이다."""
    fake = FakeSearcher([filler(1), filler(2), filler(3)])
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=3)))
    assert _flags(result.base) == (False, False, False, False)


@pytest.mark.req("REQ-RAG-6.2.5")
def test_hit_at_one_implies_all(settings: Settings) -> None:
    """[REQ-RAG-6.2.5] 1위가 적중이면 넷 다 참이다."""
    fake = FakeSearcher([hit(1, SPAN)] + [filler(i) for i in range(2, 6)])
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=5)))
    assert _flags(result.base) == (True, True, True, True)


@pytest.mark.req("REQ-RAG-6.2.5")
def test_n_beyond_five(settings: Settings) -> None:
    """[REQ-RAG-6.2.5] N이 10이고 7위가 처음 적중이면 Hit@N만 참이다."""
    hits = [filler(i) for i in range(1, 7)] + [hit(7, SPAN)] + [filler(i) for i in range(8, 11)]
    result = run(make_evaluator(FakeSearcher(hits), settings).evaluate(case(top_n=10)))
    assert _flags(result.base) == (False, False, False, True)


@pytest.mark.req("REQ-RAG-6.2.5")
def test_k_larger_than_results(settings: Settings) -> None:
    """[REQ-RAG-6.2.5] k가 결과 수보다 크면 결과 전부를 본다."""
    fake = FakeSearcher([filler(1), hit(2, SPAN)])
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=2)))
    assert _flags(result.base) == (False, True, True, True)


@pytest.mark.req("REQ-RAG-6.2.5")
@pytest.mark.parametrize(
    ("first_rank", "top_n", "expected"),
    [
        (3, 5, (False, True, True, True)),
        (5, 5, (False, False, True, True)),
        (6, 10, (False, False, False, True)),
    ],
    ids=["rank3_n5", "rank5_n5", "rank6_n10"],
)
def test_hit_at_k_boundaries(
    settings: Settings, first_rank: int, top_n: int, expected: tuple[bool, bool, bool, bool]
) -> None:
    """[REQ-RAG-6.2.5] 처음 적중이 k 경계(3·5·6위)면 Hit 넷을 확장 전·후 모두 정확히 낸다."""
    hits = [hit(i, SPAN) if i == first_rank else filler(i) for i in range(1, top_n + 1)]
    result = run(make_evaluator(FakeSearcher(hits), settings).evaluate(case(top_n=top_n)))
    assert result.base.rank == first_rank
    assert _flags(result.base) == expected
    assert _flags(result.expanded) == expected


# ── 결과 0건 (REQ-RAG-6.2.4, 6.2.5) ───────────────────────────────


@pytest.mark.req("REQ-RAG-6.2.4")
@pytest.mark.req("REQ-RAG-6.2.5")
def test_zero_results(settings: Settings) -> None:
    """[REQ-RAG-6.2.4][REQ-RAG-6.2.5] 결과 0건이면 순위 없음, 역순위 0, Hit 거짓, 비율 0이다."""
    result = run(make_evaluator(FakeSearcher(), settings).evaluate(case()))
    for m in (result.base, result.expanded):
        assert m.rank is None
        assert m.reciprocal_rank == 0
        assert _flags(m) == (False, False, False, False)
        assert m.coverage == 0


# ── 짧은 구간의 순위 (REQ-RAG-6.2.2, 6.2.3) ────────────────────────


@pytest.mark.req("REQ-RAG-6.2.2")
@pytest.mark.req("REQ-RAG-6.2.3")
def test_short_span_rank(settings: Settings) -> None:
    """[REQ-RAG-6.2.2][REQ-RAG-6.2.3] 10자 미만 구간은 통째로 든 결과만 적중이다."""
    fake = FakeSearcher([hit(1, "xxABCDyy"), hit(2, "xxABCDEyy")])
    result = run(make_evaluator(fake, settings).evaluate(case(answer_span="ABCDE")))
    assert result.base.rank == 2
    assert result.base.reciprocal_rank == pytest.approx(0.5)
    only_part = run(
        make_evaluator(FakeSearcher([hit(1, "xxABCDyy")]), settings).evaluate(
            case(answer_span="ABCDE")
        )
    )
    assert only_part.base.rank is None


# ── 확장 전·후 순위가 다른 조합 (REQ-RAG-6.2.6) ────────────────────


@pytest.mark.req("REQ-RAG-6.2.6")
def test_base_and_expanded_ranks_differ(settings: Settings) -> None:
    """[REQ-RAG-6.2.6] 1위는 확장 후에만, 2위는 확장 전부터 적중이면 base 2위, expanded 1위다."""
    fake = FakeSearcher([hit(1, "xxxxxxxxxx", after=[SPAN]), hit(2, SPAN)])
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=5)))
    assert result.base.rank == 2
    assert result.expanded.rank == 1
    assert result.base.reciprocal_rank == pytest.approx(0.5)
    assert result.expanded.reciprocal_rank == pytest.approx(1.0)
    assert _flags(result.base) == (False, True, True, True)
    assert _flags(result.expanded) == (True, True, True, True)


@pytest.mark.req("REQ-RAG-6.2.6")
def test_expanded_metrics_from_expanded_body(settings: Settings) -> None:
    """[REQ-RAG-6.2.6] 확장 후 3위에서야 적중하면 expanded의 Hit@k와 역순위도 그 순위를 따른다."""
    fake = FakeSearcher(
        [filler(1), filler(2), hit(3, "xxxxxxxxxx", before=[SPAN]), filler(4), filler(5)]
    )
    result = run(make_evaluator(fake, settings).evaluate(case(top_n=5)))
    assert result.base.rank is None
    assert result.expanded.rank == 3
    assert result.expanded.reciprocal_rank == pytest.approx(1 / 3)
    assert _flags(result.expanded) == (False, True, True, True)
    assert _flags(result.base) == (False, False, False, False)


# ── 확장 전·후 (REQ-RAG-6.2.6) ────────────────────────────────────


@pytest.mark.req("REQ-RAG-6.2.6")
def test_neighbors_only_hit_expanded(settings: Settings) -> None:
    """[REQ-RAG-6.2.6] 앞뒤 청크에만 구간이 있으면 base는 놓침, expanded는 적중이다."""
    fake = FakeSearcher([hit(1, "xxxxxxxxxx", after=[SPAN])])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.base.rank is None
    assert result.expanded.rank == 1
    assert result.base.coverage == 0
    assert result.expanded.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.6")
def test_expanded_body_order(settings: Settings) -> None:
    """[REQ-RAG-6.2.6] 확장 후 본문은 before, chunks 순이라 순서가 뒤집힌 구간은 적중이 아니다."""
    fake = FakeSearcher([hit(1, FIRST, before=[SECOND])])
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.expanded.rank is None


@pytest.mark.req("REQ-RAG-6.2.6")
def test_before_chunks_after_order(settings: Settings) -> None:
    """[REQ-RAG-6.2.6] before, chunks, after 순으로 이은 본문에서 구간이 적중한다."""
    fake = FakeSearcher(
        [hit(1, SPAN[7:14], before=["xx" + SPAN[:7]], after=[SPAN[14:] + "yy"])],
    )
    result = run(make_evaluator(fake, settings).evaluate(case()))
    assert result.expanded.rank == 1
    assert result.base.rank is None


@pytest.mark.req("REQ-RAG-6.2.6")
def test_result_returns_both(settings: Settings) -> None:
    """[REQ-RAG-6.2.6] 결과는 확장 전·후 지표를 모두 담는다."""
    result = run(make_evaluator(FakeSearcher([filler(1)]), settings).evaluate(case()))
    assert isinstance(result.base, EvaluationMetrics)
    assert isinstance(result.expanded, EvaluationMetrics)
