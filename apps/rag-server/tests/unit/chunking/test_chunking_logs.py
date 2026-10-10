"""chunking 로그(MODULE.md 「로그」) 테스트.

`structlog.testing.capture_logs()`로 잡는다. 허용 필드 밖의 키와 본문·제목 등이 새지 않는지 본다.
"""

import pytest
from structlog.testing import capture_logs

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import ChunkingResult, Settings

from .fakes import (
    BoundaryResponder,
    FakeModelHub,
    MakeSettings,
    asset_chunks,
    by_headings,
    dropping,
    make_chunker,
    raw_response,
    responder,
    run,
    scripted,
    starting_at,
    text_chunks,
)

FB_DOC = (
    "## 하나\n\n하나 문단 w1.\n\n"
    "## 둘\n\n둘 문단 w2.\n\n[[minerva:table:t1 | 표]]\n\n"
    "## 셋\n\n셋 문단 w3.\n"
)
GAP_DOC = "# 문서\n\n첫 줄 w1.\n빠질줄 w2.\n\n## 절\n\n셋째 줄 w3.\n"
CODE_DOC = "# 설치\n\n설치 w1.\n\n```bash\n# 주석 줄\n\nrun w2\n```\n\n## 끝\n\n끝 문단 w3.\n"

VALIDATION_KEYS = {
    "event",
    "log_level",
    "part",
    "attempt",
    "reason",
    "detail",
    "item",
    "line",
    "line_count",
    "missing",
    "duplicated",
}
FALLBACK_KEYS = {"event", "log_level", "part", "attempts"}
DONE_KEYS = {
    "event",
    "log_level",
    "text_chunks",
    "asset_chunks",
    "split_groups",
    "fallback_used",
    "parts",
}


def _split(
    settings: Settings, boundary: BoundaryResponder, markdown: str = FB_DOC
) -> tuple[ChunkingResult, list[dict[str, object]]]:
    """나누면서 구조화 로그를 함께 잡는다."""
    fake = FakeModelHub(boundary=boundary)
    with capture_logs() as logs:
        result = run(make_chunker(fake, settings).split(markdown, ChunkingMode.SEMANTIC))
    return result, [dict(entry) for entry in logs if str(entry["event"]).startswith("chunking.")]


def _events(logs: list[dict[str, object]], name: str) -> list[dict[str, object]]:
    """이름이 같은 이벤트만 고른다."""
    return [entry for entry in logs if entry["event"] == name]


@pytest.mark.req("REQ-RAG-2.3.1")
def test_validation_failed_log(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.3.1] 자리표시가 빠지면 chunking.validation_failed가 허용 필드로만 한 번 남는다."""
    settings = make_settings(retries=1)

    _, logs = _split(settings, scripted(dropping("[[minerva:"), by_headings))

    (entry,) = _events(logs, "chunking.validation_failed")
    assert entry["log_level"] == "warning"
    assert set(entry) <= VALIDATION_KEYS
    assert entry["reason"] in {"boundary", "placeholder"}
    # ★ 개수 필드는 reason이 placeholder인 이벤트에서만 단언한다. 자리표시 줄은 항상 한 줄이라
    # 줄이 빠지면 경계 검증이 먼저 걸려 boundary만 남는 구현도 명세 안이다
    if entry["reason"] == "placeholder":
        assert entry["missing"] == 1
        assert entry["duplicated"] == 0


@pytest.mark.req("REQ-RAG-2.3.1")
@pytest.mark.parametrize(
    ("bad", "markdown", "detail"),
    [
        (dropping("빠질줄"), GAP_DOC, "uncovered"),
        (starting_at(lambda line: line.startswith("# 주석")), CODE_DOC, "code_block"),
        (responder(lambda lines: [(1, 4), (3, len(lines))]), GAP_DOC, "order"),
    ],
    ids=["body-line-missing", "code-block-boundary", "overlap"],
)
def test_boundary_reason_log(
    make_settings: MakeSettings, bad: BoundaryResponder, markdown: str, detail: str
) -> None:
    """[REQ-RAG-2.3.1] 자리표시와 무관한 경계 검증 실패는 reason boundary와 걸린 규칙을 남긴다."""
    settings = make_settings(retries=1)

    _, logs = _split(settings, scripted(bad, by_headings), markdown)

    (entry,) = _events(logs, "chunking.validation_failed")
    assert entry["reason"] == "boundary"
    assert entry["detail"] == detail
    assert isinstance(entry["line"], int)
    assert entry["line_count"] == len(markdown.split("\n"))
    assert set(entry) <= VALIDATION_KEYS


@pytest.mark.req("REQ-RAG-2.3.1")
@pytest.mark.parametrize(
    ("response", "detail", "item", "line"),
    [
        ("이건 JSON이 아니다", "not_json", None, None),
        ('{"chunks": []}', "no_chunks", None, None),
        ('{"chunks": [1]}', "bad_item", 1, None),
        (
            '{"chunks": [{"start_line": 1, "end_line": 99, "title": "t", "summary": "s"}]}',
            "line_out_of_range",
            1,
            99,
        ),
        (
            '{"chunks": [{"start_line": 1, "end_line": 3, "title": " ", "summary": "s"}]}',
            "empty_title",
            1,
            1,
        ),
        (
            '{"chunks": [{"start_line": 1, "end_line": 3, "title": "t", "summary": ""}]}',
            "empty_summary",
            1,
            1,
        ),
    ],
    ids=["not-json", "no-chunks", "bad-item", "out-of-range", "empty-title", "empty-summary"],
)
def test_unparseable_reason_log(
    make_settings: MakeSettings, response: str, detail: str, item: int | None, line: int | None
) -> None:
    """[REQ-RAG-2.3.1] 해석할 수 없는 응답은 reason unparseable과 걸린 규칙·위치를 남긴다."""
    settings = make_settings(retries=1)
    markdown = "# 설치\n\n본문 w1.\n"

    _, logs = _split(settings, scripted(raw_response(response), by_headings), markdown)

    (entry,) = _events(logs, "chunking.validation_failed")
    assert entry["log_level"] == "warning"
    assert set(entry) <= VALIDATION_KEYS
    assert entry["reason"] == "unparseable"
    assert (entry["detail"], entry["item"], entry["line"]) == (detail, item, line)
    assert entry["line_count"] == 4
    assert "본문" not in str(entry)


@pytest.mark.req("REQ-RAG-2.3.1")
def test_duplicated_count_log(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.3.1] 자리표시 줄을 두 범위가 겹쳐 덮으면 duplicated 개수가 남는다."""
    settings = make_settings(retries=1)
    overlapping = responder(lambda lines: [(1, 9), (9, len(lines))])

    _, logs = _split(settings, scripted(overlapping, by_headings))

    (entry,) = _events(logs, "chunking.validation_failed")
    assert entry["reason"] in {"boundary", "placeholder"}
    # ★ 위와 같은 이유로 reason이 placeholder일 때만 개수를 본다
    if entry["reason"] == "placeholder":
        assert entry["duplicated"] == 1
        assert entry["missing"] == 0


@pytest.mark.req("REQ-RAG-2.3.2")
def test_fallback_log(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.3.2] 대체 분할로 넘어가면 chunking.fallback이 한 번 남는다."""
    settings = make_settings(retries=1)

    _, logs = _split(settings, dropping("[[minerva:"))

    assert len(_events(logs, "chunking.validation_failed")) == 2
    (entry,) = _events(logs, "chunking.fallback")
    assert entry["log_level"] == "warning"
    assert set(entry) <= FALLBACK_KEYS
    assert entry["attempts"] == 2


@pytest.mark.req("REQ-RAG-2.1.1")
@pytest.mark.parametrize("fails", [False, True], ids=["valid", "fallback"])
def test_done_log(make_settings: MakeSettings, fails: bool) -> None:
    """[REQ-RAG-2.1.1] split이 끝나면 chunking.done이 결과와 맞는 개수로 한 번 남는다."""
    settings = make_settings(retries=1)

    result, logs = _split(settings, dropping("[[minerva:") if fails else by_headings)

    (entry,) = _events(logs, "chunking.done")
    texts = text_chunks(result)
    assert entry["log_level"] == "info"
    assert set(entry) <= DONE_KEYS
    assert entry["text_chunks"] == len(texts)
    assert entry["asset_chunks"] == len(asset_chunks(result))
    assert entry["split_groups"] == len({c.split_group for c in texts if c.split_group})
    assert entry["fallback_used"] == result.fallback_used


@pytest.mark.req("REQ-RAG-2.1.1")
def test_logs_carry_no_content(make_settings: MakeSettings) -> None:
    """[REQ-RAG-2.1.1] 로그에 본문·헤딩 텍스트·제목·자리표시 ID가 들어 있지 않다."""
    settings = make_settings(retries=1)
    collected: list[dict[str, object]] = []
    for boundary in (
        by_headings,
        scripted(dropping("[[minerva:"), by_headings),
        dropping("[[minerva:"),
    ):
        collected.extend(_split(settings, boundary)[1])

    assert collected
    forbidden = ["하나", "둘", "셋", "문단", "경계 제목", "규칙 제목", "t1", "[[minerva:"]
    for entry in collected:
        for key, value in entry.items():
            for word in forbidden:
                assert word not in str(value), (key, word)
