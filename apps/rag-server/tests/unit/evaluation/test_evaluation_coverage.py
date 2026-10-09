"""evaluation 포함 비율과 공백 문자(REQ-RAG-6.2.2) 테스트."""

import pytest

from minerva_rag.core import Settings
from minerva_rag.evaluation import EvaluationResult

from ..resource.fakes import run
from .fakes import FIRST, SECOND, SPAN, FakeSearcher, case, filler, hit, make_evaluator

# ★ MODULE.md 「측정」의 공백 문자 25자다 (JavaScript 정규식 \s와 같은 집합)
_JS_WHITESPACE = [
    "\t",
    "\n",
    "\v",
    "\f",
    "\r",
    " ",
    " ",
    " ",
    *(chr(code) for code in range(0x2000, 0x200B)),
    " ",
    " ",
    " ",
    " ",
    "　",
    "﻿",
]
# ★ 공백이 아닌 글자: U+200B, 그리고 Python isspace는 참이지만 JS \s에는 없는 글자
_NOT_WHITESPACE = ["​", "\u0085", "\u001c", "\u001d", "\u001e", "\u001f"]


def _eval(settings: Settings, fake: FakeSearcher, span: str = SPAN) -> EvaluationResult:
    """정답 구간을 정해 평가 한 번을 돌린다."""
    return run(make_evaluator(fake, settings).evaluate(case(answer_span=span)))


def _id(ch: str) -> str:
    """parametrize id를 코드 포인트로 만든다."""
    return f"U+{ord(ch):04X}"


@pytest.mark.req("REQ-RAG-6.2.2")
def test_halves_in_two_results(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 앞 절반이 한 결과 끝, 뒤 절반이 다른 결과 앞에 있으면 1이다."""
    result = _eval(settings, FakeSearcher([hit(1, "xxxx" + FIRST), hit(2, SECOND + "yyyy")]))
    assert result.base.coverage == pytest.approx(1.0)
    assert result.base.rank is None


@pytest.mark.req("REQ-RAG-6.2.2")
def test_no_overlap_is_zero(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 10자 이상 겹치는 결과가 없으면 0이다."""
    result = _eval(settings, FakeSearcher([filler(1), filler(2), filler(3)]))
    assert result.base.coverage == 0


@pytest.mark.req("REQ-RAG-6.2.2")
def test_nine_chars_ignored(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 9자 공통 부분은 우연한 일치로 보고 세지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, "xx" + SPAN[:9] + "yy")]))
    assert result.base.coverage == 0


@pytest.mark.req("REQ-RAG-6.2.2")
def test_ten_chars_counted(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 10자 공통 부분은 센다."""
    result = _eval(settings, FakeSearcher([hit(1, "xx" + SPAN[:10] + "yy")]))
    assert result.base.coverage == pytest.approx(0.5)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_short_pieces_not_summed(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 10자 미만 조각은 결과 여럿에 있어도 세지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, SPAN[:9]), hit(2, SPAN[11:])]))
    assert result.base.coverage == 0


@pytest.mark.req("REQ-RAG-6.2.2")
def test_only_longest_per_result(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 결과 하나에서는 가장 긴 공통 부분만 센다."""
    result = _eval(settings, FakeSearcher([hit(1, SPAN[:12] + "xx" + SPAN[14:])]))
    assert result.base.coverage == pytest.approx(12 / 20)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_overlapping_results_union(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 결과끼리 겹친 글자는 두 번 세지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, SPAN[:15]), hit(2, SPAN[5:])]))
    assert result.base.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_coverage_counts_non_candidates(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 포함 비율은 적중 후보에 한정하지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, SPAN, doc_id="doc-3", name="다른 문서")]))
    assert result.base.coverage == pytest.approx(1.0)
    assert result.base.rank is None


@pytest.mark.req("REQ-RAG-6.2.2")
def test_short_span_needs_whole(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 정답 구간이 10자 미만이면 구간 전체가 들어 있을 때만 센다."""
    part = _eval(settings, FakeSearcher([hit(1, "xxABCDyy")]), span="ABCDE")
    whole = _eval(settings, FakeSearcher([hit(1, "xxABCDEyy")]), span="ABCDE")
    assert part.base.coverage == 0
    assert whole.base.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_coverage_expanded_uses_neighbors(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 확장 후 포함 비율은 앞뒤 청크까지 본다."""
    result = _eval(settings, FakeSearcher([hit(1, FIRST, after=[SECOND])]))
    assert result.base.coverage == pytest.approx(0.5)
    assert result.expanded.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.2")
@pytest.mark.parametrize(
    "texts",
    [["xxxxxxxxxx"], [SPAN], [FIRST, SECOND], [SPAN[:15], SPAN[5:]], [SPAN[:9]], [SPAN[:12]]],
)
def test_coverage_in_unit_range(settings: Settings, texts: list[str]) -> None:
    """[REQ-RAG-6.2.2] 포함 비율은 0 이상 1 이하다."""
    hits = [hit(i, t) for i, t in enumerate(texts, start=1)]
    result = _eval(settings, FakeSearcher(hits))
    assert 0 <= result.base.coverage <= 1
    assert 0 <= result.expanded.coverage <= 1


# ── 공백 문자 ─────────────────────────────────────────────────────


@pytest.mark.req("REQ-RAG-6.2.2")
def test_newline_position_same_value(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 줄바꿈 위치만 다른 결과도 같은 값이고 공백이 든 구간도 1이다."""
    spaced = _eval(
        settings,
        FakeSearcher([hit(1, "ABCDEFGHIJ\nKLMNOPQRST")]),
        span="ABCDE FGHIJ\nKLMNO\tPQRST",
    )
    plain = _eval(settings, FakeSearcher([hit(1, SPAN)]))
    # ★ 데이터 타입의 동치 비교는 명세에 없으므로 필드 단위로 비교한다
    assert spaced.base.hit_at_1 == plain.base.hit_at_1
    assert spaced.base.hit_at_n == plain.base.hit_at_n
    assert spaced.base.reciprocal_rank == pytest.approx(plain.base.reciprocal_rank)
    assert spaced.base.coverage == pytest.approx(plain.base.coverage)
    assert spaced.base.rank == 1
    assert spaced.base.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_nbsp_instead_of_space(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 띄어쓰기 대신 U+00A0이 든 결과도 같은 값이다."""
    result = _eval(
        settings,
        FakeSearcher([hit(1, "ABCDE FGHIJ KLMNOPQRST")]),
        span="ABCDE FGHIJ KLMNOPQRST",
    )
    assert result.base.rank == 1
    assert result.base.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.2")
@pytest.mark.parametrize("ch", _JS_WHITESPACE, ids=_id)
def test_js_whitespace_chars_ignored(settings: Settings, ch: str) -> None:
    """[REQ-RAG-6.2.2] JavaScript \\s 집합의 25자는 지우고 비교한다."""
    result = _eval(settings, FakeSearcher([hit(1, FIRST + ch + SECOND)]))
    assert result.base.rank == 1
    assert result.base.coverage == pytest.approx(1.0)


@pytest.mark.req("REQ-RAG-6.2.2")
@pytest.mark.parametrize("ch", _NOT_WHITESPACE, ids=_id)
def test_non_whitespace_chars_kept(settings: Settings, ch: str) -> None:
    """[REQ-RAG-6.2.2] 공백이 아닌 글자는 지우지 않으므로 통째 포함이 아니다."""
    result = _eval(settings, FakeSearcher([hit(1, FIRST + ch + SECOND)]))
    assert result.base.rank is None
    assert result.base.coverage == pytest.approx(0.5)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_whitespace_not_in_denominator(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 공백 문자는 포함 비율의 분모에 들지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, "xxABCDEFGHIJyy")]), span="AB CD EF GH IJ")
    assert result.base.coverage == pytest.approx(1.0)


# ── 10자 기준과 구간 판정은 공백 제거 뒤에 센다 (REQ-RAG-6.2.2) ──────


@pytest.mark.req("REQ-RAG-6.2.2")
def test_ten_char_threshold_after_stripping(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 원문 10자라도 공백을 지운 뒤 9자인 공통 부분은 세지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, "ABCDE FGHI")]))
    assert result.base.coverage == 0
    assert result.base.rank is None


@pytest.mark.req("REQ-RAG-6.2.2")
def test_short_span_judged_after_stripping(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 공백을 지운 뒤 9자인 구간은 짧은 구간이라 통째 포함일 때 센다."""
    whole = _eval(settings, FakeSearcher([hit(1, "xxABCDEFGHIyy")]), span="AB CD EF GH I")
    part = _eval(settings, FakeSearcher([hit(1, "xxABCDEFGHyy")]), span="AB CD EF GH I")
    assert whole.base.coverage == pytest.approx(1.0)
    assert whole.base.rank == 1
    assert part.base.coverage == 0
    assert part.base.rank is None


@pytest.mark.req("REQ-RAG-6.2.2")
def test_ten_chars_after_stripping_counted(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 원문 11자라도 공백을 지운 뒤 10자인 공통 부분은 센다."""
    result = _eval(settings, FakeSearcher([hit(1, "xxABCDE FGHIJxx")]), span=SPAN)
    assert result.base.coverage == pytest.approx(0.5)


# ── 코드 포인트 단위 (REQ-RAG-6.2.2) ──────────────────────────────

_EMOJI = "".join(chr(0x1F600 + i) for i in range(10))  # 비BMP 10자 (UTF-16이면 20단위)


@pytest.mark.req("REQ-RAG-6.2.2")
def test_non_bmp_counted_by_code_point(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 비BMP 문자 9자 공통 부분은 코드 포인트 9자이므로 세지 않는다."""
    result = _eval(settings, FakeSearcher([hit(1, "xx" + _EMOJI[:9] + "yy")]), span=_EMOJI)
    assert result.base.coverage == 0
    assert result.base.rank is None


@pytest.mark.req("REQ-RAG-6.2.2")
def test_non_bmp_ten_code_points_counted(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 비BMP 문자 10자 통째 포함은 포함 비율 1, 적중이다."""
    result = _eval(settings, FakeSearcher([hit(1, "xx" + _EMOJI + "yy")]), span=_EMOJI)
    assert result.base.coverage == pytest.approx(1.0)
    assert result.base.rank == 1


@pytest.mark.req("REQ-RAG-6.2.2")
def test_non_bmp_denominator_by_code_point(settings: Settings) -> None:
    """[REQ-RAG-6.2.2] 비BMP 문자가 든 정답 구간의 분모도 코드 포인트 수로 센다."""
    span = _EMOJI + SPAN[:10]  # 코드 포인트 20자
    result = _eval(settings, FakeSearcher([hit(1, _EMOJI)]), span=span)
    assert result.base.coverage == pytest.approx(0.5)


@pytest.mark.req("REQ-RAG-6.1.1")
@pytest.mark.parametrize("ch", _NOT_WHITESPACE, ids=_id)
def test_single_non_whitespace_span_accepted(settings: Settings, ch: str) -> None:
    """[REQ-RAG-6.1.1] 공백이 아닌 글자 하나뿐인 구간은 거부하지 않고 평가한다."""
    fake = FakeSearcher([hit(1, "xx" + ch + "yy")])
    result = _eval(settings, fake, span=ch)
    assert fake.calls == ["document_chunks", "search"]
    assert result.base.rank == 1
    assert result.base.coverage == pytest.approx(1.0)
