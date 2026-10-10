"""로그(REQ-RAG-11.2.1) 단위 테스트.

★ configure_logging()은 반드시 테스트 함수 안에서 부른다 (처리기가 capsys가 바꾼 stdout에 붙는다).
★ JSON이 한글을 \\uXXXX로 이스케이프할 수 있어, ASCII 고유 문자열과 파싱한 값을 함께 확인한다.
"""

import json
from typing import Any, NamedTuple
from urllib.parse import urlsplit

import pytest

from minerva_rag.core import configure_logging, get_logger

pytestmark = pytest.mark.usefixtures("restore_logging")

SECRET = "SECRET-BODY-7f3a 비밀 본문"
REMOVED = "[removed]"


def _records(capsys: pytest.CaptureFixture[str]) -> tuple[str, list[dict[str, Any]]]:
    """캡처한 출력의 원문과, 줄마다 파싱한 JSON 객체 목록을 돌려준다."""
    # 출력 대상(stdout/stderr)은 명세에 없어 둘을 합쳐 판정한다
    captured = capsys.readouterr()
    out = captured.out + captured.err
    lines = [line for line in out.strip().splitlines() if line.strip()]
    return out, [json.loads(line) for line in lines]


@pytest.mark.req("REQ-RAG-11.2.1")
@pytest.mark.parametrize(
    "key",
    [
        "markdown",
        "text",
        "query",
        "answer_span",
        "table_markdown",
        "summary",
        "caption",
        "title",
        "token",
        "authorization",
    ],
)
def test_forbidden_key_removed(capsys: pytest.CaptureFixture[str], key: str) -> None:
    """[REQ-RAG-11.2.1] 금지 키의 값은 출력에 나오지 않고 "[removed]"로 바뀐다."""
    configure_logging()
    get_logger("tests.core").info("core.test", **{key: SECRET})
    out, records = _records(capsys)
    assert "SECRET-BODY-7f3a" not in out
    assert records[-1][key] == REMOVED
    assert "비밀 본문" not in json.dumps(records, ensure_ascii=False)


@pytest.mark.req("REQ-RAG-11.2.1")
def test_allowed_keys_kept(capsys: pytest.CaptureFixture[str]) -> None:
    """[REQ-RAG-11.2.1] doc_id·글자 수 같은 허용 키의 값은 그대로 나온다."""
    configure_logging()
    get_logger("tests.core").info(
        "core.test", doc_id="doc-1", chunk_id="c-9", chars=1234, text="SECRET-BODY-7f3a"
    )
    out, records = _records(capsys)
    record = records[-1]
    assert record["doc_id"] == "doc-1"
    assert record["chunk_id"] == "c-9"
    assert record["chars"] == 1234
    assert record["text"] == REMOVED
    assert "SECRET-BODY-7f3a" not in out


@pytest.mark.req("REQ-RAG-11.2.1")
def test_non_string_forbidden_value_removed(capsys: pytest.CaptureFixture[str]) -> None:
    """[REQ-RAG-11.2.1] 금지 키는 값의 타입과 상관없이 지운다."""
    configure_logging()
    get_logger("tests.core").info(
        "core.test", query=["SECRET-Q-1"], summary={"x": "SECRET-S-2"}, title=None
    )
    out, records = _records(capsys)
    record = records[-1]
    assert record["query"] == REMOVED
    assert record["summary"] == REMOVED
    assert record["title"] == REMOVED
    assert "SECRET-Q-1" not in out
    assert "SECRET-S-2" not in out


@pytest.mark.req("REQ-RAG-11.2.1")
def test_output_is_json_line(capsys: pytest.CaptureFixture[str]) -> None:
    """[REQ-RAG-11.2.1] 이벤트마다 JSON 한 줄이 나간다."""
    configure_logging()
    log = get_logger("tests.core")
    log.info("core.test", doc_id="d1")
    log.warning("core.warn")
    out, records = _records(capsys)
    assert len(out.strip().splitlines()) == 2
    assert len(records) == 2


@pytest.mark.req("REQ-RAG-11.2.1")
def test_exception_log_redacted(capsys: pytest.CaptureFixture[str]) -> None:
    """[REQ-RAG-11.2.1] log.exception()으로 남겨도 금지 키 값이 지워진다."""
    configure_logging()
    log = get_logger("tests.core")
    try:
        raise ValueError("boom")
    except ValueError:
        log.exception("core.fail", text="SECRET-EXC-7")
    out, records = _records(capsys)
    assert "SECRET-EXC-7" not in out
    assert records[-1]["text"] == REMOVED


class _Pair(NamedTuple):
    """tuple 하위 타입 값을 만들기 위한 테스트용 namedtuple."""

    name: str
    data: dict[str, str]


@pytest.mark.req("REQ-RAG-11.2.1")
def test_tuple_subtype_value_does_not_break_redaction(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """[REQ-RAG-11.2.1] namedtuple·SplitResult 값이 들어 있어도 예외 없이 금지 값이 지워진다."""
    configure_logging()
    get_logger("tests.core").info(
        "core.test",
        pair=_Pair("n", {"text": "SECRET-NT-1"}),
        url=urlsplit("http://h/p?q=1"),
        text="SECRET-TOP-2",
    )
    captured = capsys.readouterr()
    out = captured.out + captured.err
    assert "SECRET-NT-1" not in out
    assert "SECRET-TOP-2" not in out
    record = json.loads(out.strip().splitlines()[-1])
    assert record["text"] == REMOVED
    assert record["pair"][1]["text"] == REMOVED
