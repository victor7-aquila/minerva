"""로그 이벤트(MODULE.md 「로그」) 테스트."""

from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from structlog.testing import capture_logs

from minerva_rag.api import create_app

from .fakes import (
    AUTH,
    TOKEN,
    FakeServices,
    api_events,
    assert_event,
    call_raw,
    events_named,
    index_body,
    send,
)


@pytest.mark.req("REQ-RAG-9.1.2")
def test_request_invalid_log(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.2] 검증 실패는 경로와 필드 이름만 담은 warning이고 입력값은 로그에 없다."""
    with capture_logs() as logs:
        response = send(client, "POST", "/v1/search", json={"query": "q", "top_n": "MARKER-1a2b"})

    assert response.status_code == 400
    found = assert_event(logs, "api.request_invalid", "warning", {"path", "fields"})
    assert [entry["path"] for entry in found] == ["/v1/search"]
    assert any("top_n" in str(field) for entry in found for field in entry["fields"])
    assert all("MARKER-1a2b" not in str(entry) for entry in logs)


@pytest.mark.req("REQ-RAG-9.3.1")
def test_unauthorized_log(client: TestClient) -> None:
    """[REQ-RAG-9.3.1] 토큰 검사 실패는 경로와 토큰 유무만 담은 warning이고 토큰 값은 없다."""
    wrong = "WRONG-TOKEN-3c4d"

    with capture_logs() as logs:
        send(client, "POST", "/v1/search", token=False, json={"query": "q"})
        send(
            client,
            "POST",
            "/v1/search",
            token=False,
            headers={"X-Minerva-Token": wrong},
            json={"query": "q"},
        )

    found = assert_event(logs, "api.unauthorized", "warning", {"path", "token_present"})
    assert [entry["token_present"] for entry in found] == [False, True]
    assert all(entry["path"] == "/v1/search" for entry in found)
    assert all(wrong not in str(entry) and TOKEN not in str(entry) for entry in logs)


@pytest.mark.req("REQ-RAG-9.1.3")
def test_payload_too_large_log(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] 크기 초과는 경로·바이트 수·한도만 담은 warning이고 본문은 없다."""
    set_limits(markdown=1024, image=1024)
    client = make_client()
    markdown = "MARKER-4d5e".ljust(1025, "a")

    with capture_logs() as logs:
        response = send(client, "POST", "/v1/index-jobs", json=index_body(markdown=markdown))

    assert response.status_code == 413
    found = assert_event(logs, "api.payload_too_large", "warning", {"path", "bytes", "limit"})
    assert [(e["path"], e["limit"]) for e in found] == [("/v1/index-jobs", 1024)]
    # ★ bytes의 의미는 명세가 정하지 않았다. 한도를 넘었다는 성질만 본다
    assert all(isinstance(e["bytes"], int) and e["bytes"] > e["limit"] for e in found)
    assert all("MARKER-4d5e" not in str(entry) for entry in logs)


@pytest.mark.req("REQ-RAG-9.1.3")
def test_payload_too_large_log_on_precheck(
    set_limits: Callable[..., None], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] Content-Length 사전 검사로 거부해도 같은 이벤트·허용 필드를 쓴다."""
    set_limits(markdown=1024, image=1024)
    app = create_app(fakes.services)

    with capture_logs() as logs:
        result = call_raw(
            app,
            "POST",
            "/v1/index-jobs",
            {**AUTH, "content-type": "application/json", "content-length": "1000000000"},
            [b"x" * 1024] * 3,
        )

    assert result.status == 413
    assert_event(logs, "api.payload_too_large", "warning", {"path", "bytes", "limit"})


@pytest.mark.req("REQ-RAG-11.3.2")
def test_unhandled_log(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-11.3.2] 처리하지 못한 예외는 경로와 예외 종류를 담은 error 로그와 스택을 남긴다."""
    fakes.search.raises["search"] = RuntimeError("SECRET-x")

    with capture_logs() as logs:
        response = send(client, "POST", "/v1/search", json={"query": "q"})

    assert response.status_code == 500
    found = assert_event(logs, "api.unhandled", "error", {"path", "error_type"}, stack=True)
    assert [(e["path"], e["error_type"]) for e in found] == [("/v1/search", "RuntimeError")]


@pytest.mark.req("REQ-RAG-9.1.1")
def test_no_body_in_logs(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 정상 요청의 본문(MD, 질의, 정답 구간, 표)은 api 로그에 나오지 않는다."""
    with capture_logs() as logs:
        send(
            client,
            "POST",
            "/v1/index-jobs",
            json=index_body(markdown="MARKER-md01", name="MARKER-name01"),
        )
        send(client, "POST", "/v1/search", json={"query": "MARKER-query01"})
        send(
            client,
            "POST",
            "/v1/evaluations",
            json={"query": "MARKER-query02", "doc_id": "doc-1", "answer_span": "MARKER-span01"},
        )
        send(client, "POST", "/v1/captions/table", json={"table_markdown": "MARKER-table01"})

    assert fakes.total_calls() == 4
    for entry in api_events(logs):
        assert "MARKER" not in str(entry)
    assert events_named(logs, "api.unhandled") == []
