"""지표 계산 순수 함수 (REQ-RAG-6.1.3, REQ-RAG-6.2.2 ~ REQ-RAG-6.2.6)."""

from collections.abc import Callable, Sequence

from minerva_rag.search import SearchHit

from .models import EvaluationMetrics

# ★ JavaScript 정규식 \s와 같은 글자 집합이다 (Backend REQ-BE-5.1.5와 같아야 한다).
#   Python str.isspace·re의 \s는 U+001C~U+001F·U+0085를 더 넣고 U+FEFF를 빼므로 쓰지 않는다.
#   U+200B는 공백이 아니다
_WHITESPACE = "".join(
    chr(code)
    for code in (
        *range(0x09, 0x0E),  # 탭, 줄바꿈, 수직탭, 폼피드, 캐리지리턴
        0x20,
        0xA0,
        0x1680,
        *range(0x2000, 0x200B),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
        0xFEFF,
    )
)
_STRIP_TABLE = str.maketrans("", "", _WHITESPACE)

# ★ 10자 미만의 공통 부분은 우연한 일치로 보고 세지 않는다 (REQ-RAG-6.2.2)
_MIN_OVERLAP = 10
_HIT_KS = (1, 3, 5)


def strip_whitespace(text: str) -> str:
    """공백 문자를 모두 지운다."""
    return text.translate(_STRIP_TABLE)


def base_body(hit: SearchHit) -> str:
    """확장 전 본문(chunks)을 공백을 지워 잇는다."""
    return "".join(strip_whitespace(c.text) for c in hit.chunks)


def expanded_body(hit: SearchHit) -> str:
    """확장 후 본문(before, chunks, after 순)을 공백을 지워 잇는다."""
    return "".join(strip_whitespace(c.text) for c in (*hit.before, *hit.chunks, *hit.after))


def _build_automaton(body: str) -> tuple[list[int], list[int], list[dict[str, int]]]:
    """body의 접미사 자동자를 만들어 (link, length, next)를 돌려준다."""
    link = [-1]
    length = [0]
    nxt: list[dict[str, int]] = [{}]
    last = 0
    for ch in body:
        cur = len(nxt)
        nxt.append({})
        length.append(length[last] + 1)
        link.append(0)
        p = last
        while p != -1 and ch not in nxt[p]:
            nxt[p][ch] = cur
            p = link[p]
        if p != -1:
            q = nxt[p][ch]
            if length[p] + 1 == length[q]:
                link[cur] = q
            else:
                clone = len(nxt)
                nxt.append(nxt[q].copy())
                length.append(length[p] + 1)
                link.append(link[q])
                while p != -1 and nxt[p].get(ch) == q:
                    nxt[p][ch] = clone
                    p = link[p]
                link[q] = clone
                link[cur] = clone
        last = cur
    return link, length, nxt


def longest_common(span: str, body: str) -> tuple[int, int]:
    """span과 body의 가장 긴 공통 부분 문자열의 (span 안 시작 위치, 길이)를 돌려준다."""
    if not span or not body:
        return 0, 0
    if span in body:
        return 0, len(span)
    link, length, nxt = _build_automaton(body)
    v = 0
    cur = 0
    best = 0
    best_end = -1
    for i, ch in enumerate(span):
        while v and ch not in nxt[v]:
            v = link[v]
            cur = length[v]
        if ch in nxt[v]:
            v = nxt[v][ch]
            cur += 1
        else:
            v = 0
            cur = 0
        # ★ 같은 길이면 앞 자리를 지킨다
        if cur > best:
            best = cur
            best_end = i
    if best == 0:
        return 0, 0
    return best_end - best + 1, best


def _first_hit_rank(
    bodies: Sequence[tuple[SearchHit, str]], span: str, is_candidate: Callable[[SearchHit], bool]
) -> int | None:
    """적중 후보 중 본문에 정답 구간이 통째로 든 첫 결과의 rank를 돌려준다."""
    for hit, body in bodies:
        if is_candidate(hit) and span in body:
            return hit.rank
    return None


def _coverage(bodies: Sequence[tuple[SearchHit, str]], span: str) -> float:
    """모든 결과에서 덮인 정답 구간 글자의 비율을 돌려준다."""
    covered = bytearray(len(span))
    threshold = min(_MIN_OVERLAP, len(span))
    for _, body in bodies:
        start, size = longest_common(span, body)
        if size >= threshold:
            covered[start : start + size] = b"\x01" * size
    return sum(covered) / len(span)


def measure(
    hits: Sequence[SearchHit],
    span: str,
    is_candidate: Callable[[SearchHit], bool],
    body_of: Callable[[SearchHit], str],
    n: int,
) -> EvaluationMetrics:
    """결과 목록과 본문 구성 방식으로 지표 하나를 계산한다."""
    bodies = [(hit, body_of(hit)) for hit in hits]
    rank = _first_hit_rank(bodies, span, is_candidate)
    ks = (*_HIT_KS, n)
    flags = [rank is not None and rank <= k for k in ks]
    return EvaluationMetrics(
        hit_at_1=flags[0],
        hit_at_3=flags[1],
        hit_at_5=flags[2],
        hit_at_n=flags[3],
        rank=rank,
        reciprocal_rank=0.0 if rank is None else 1 / rank,
        coverage=_coverage(bodies, span),
    )


def measure_both(
    hits: Sequence[SearchHit], span: str, is_candidate: Callable[[SearchHit], bool], n: int
) -> tuple[EvaluationMetrics, EvaluationMetrics]:
    """확장 전·후 지표를 함께 계산한다."""
    return (
        measure(hits, span, is_candidate, base_body, n),
        measure(hits, span, is_candidate, expanded_body, n),
    )
