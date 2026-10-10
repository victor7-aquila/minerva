"""API 토큰 검사(REQ-RAG-9.3.1) 테스트."""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from minerva_rag.api import create_app
from minerva_rag.core import ServerNotReadyError

from .fakes import (
    ENDPOINTS,
    TOKEN,
    Endpoint,
    FakeServices,
    call_raw,
    index_body,
    send,
    send_endpoint,
)

_IDS = [ep.name for ep in ENDPOINTS]


def _assert_unauthorized(response: Response) -> None:
    """401 UNAUTHORIZED 본문인지 확인한다."""
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.req("REQ-RAG-9.3.1")
@pytest.mark.parametrize("ep", ENDPOINTS, ids=_IDS)
def test_missing_token_rejected(client: TestClient, fakes: FakeServices, ep: Endpoint) -> None:
    """[REQ-RAG-9.3.1] 토큰이 없으면 401 UNAUTHORIZED이고 service는 불리지 않는다."""
    response = send_endpoint(client, ep, token=False)

    _assert_unauthorized(response)
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1")
@pytest.mark.parametrize("wrong", ["wrong-token", "", TOKEN[:9]], ids=["other", "empty", "prefix"])
@pytest.mark.parametrize("ep", ENDPOINTS, ids=_IDS)
def test_wrong_token_rejected(
    client: TestClient, fakes: FakeServices, ep: Endpoint, wrong: str
) -> None:
    """[REQ-RAG-9.3.1] 토큰이 다르면(빈 값, 앞부분만 맞는 값 포함) 401이고 service는 안 불린다."""
    response = send_endpoint(client, ep, token=False, headers={"X-Minerva-Token": wrong})

    _assert_unauthorized(response)
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1")
def test_other_auth_header_ignored(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.3.1] Authorization 헤더만으로는 인증되지 않는다."""
    response = send(
        client,
        "POST",
        "/v1/search",
        token=False,
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"query": "q"},
    )

    assert response.status_code == 401
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1")
@pytest.mark.parametrize("ep", ENDPOINTS, ids=_IDS)
def test_valid_token_processed(client: TestClient, fakes: FakeServices, ep: Endpoint) -> None:
    """[REQ-RAG-9.3.1] 맞는 토큰이면 처리되어 성공 상태가 나오고 service가 한 번 불린다."""
    response = send_endpoint(client, ep)

    assert response.status_code == ep.status
    fakes.only_call(ep.fake, ep.call)


@pytest.mark.req("REQ-RAG-9.3.1")
@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("POST", "/v1/index-jobs", {"json": {}}),
        (
            "POST",
            "/v1/search",
            {"content": b"{", "headers": {"content-type": "application/json"}},
        ),
        (
            "POST",
            "/v1/captions/image",
            {
                "content": b"--x--\r\n",
                "headers": {"content-type": "multipart/form-data; boundary=x"},
            },
        ),
    ],
    ids=["empty-index", "broken-json-search", "empty-multipart-image"],
)
def test_token_checked_before_validation(
    client: TestClient, fakes: FakeServices, method: str, path: str, kwargs: dict[str, Any]
) -> None:
    """[REQ-RAG-9.3.1] 토큰 검사가 요청 검증보다 먼저다 — 둘 다 어긋나면 400이 아니라 401이다."""
    response = send(client, method, path, token=False, **kwargs)

    assert response.status_code == 401
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1", "REQ-RAG-9.1.3")
def test_token_checked_before_size(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.3.1] 토큰이 없으면 크기 한도를 넘어도 413이 아니라 401이다."""
    set_limits(markdown=1024, image=1024)

    response = send(
        make_client(),
        "POST",
        "/v1/index-jobs",
        token=False,
        json=index_body(markdown="a" * 1025),
    )
    assert response.status_code == 401

    # ★ Content-Length 사전 검사 경로도 토큰이 먼저다. 5초 안에 응답해야 한다
    raw = call_raw(
        create_app(fakes.services),
        "POST",
        "/v1/index-jobs",
        {"content-type": "application/json", "content-length": "1000000000"},
        [b"x" * 1024] * 3,
    )
    assert raw.status == 401
    assert raw.body["error"]["code"] == "UNAUTHORIZED"
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1", "REQ-RAG-10.1.2")
@pytest.mark.parametrize("ep", ENDPOINTS, ids=_IDS)
def test_token_checked_before_readiness(
    client: TestClient, fakes: FakeServices, ep: Endpoint
) -> None:
    """[REQ-RAG-9.3.1] 준비 전이라도 토큰 검사가 먼저다 — 없으면 401, 있으면 503이다."""
    fakes.fake(ep.fake).raises[ep.call] = ServerNotReadyError()

    without_token = send_endpoint(client, ep, token=False)
    with_token = send_endpoint(client, ep)

    assert without_token.status_code == 401
    assert with_token.status_code == 503
    assert with_token.json()["error"]["code"] == "SERVER_NOT_READY"


@pytest.mark.req("REQ-RAG-9.3.1")
def test_unknown_path_requires_token(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.3.1] 정의되지 않은 경로도 토큰이 없으면 401이다."""
    response = send(client, "GET", "/v1/unknown", token=False)

    assert response.status_code == 401
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1", "REQ-RAG-9.2.1")
@pytest.mark.parametrize(
    ("method", "path"),
    [("POST", "/v1/health"), ("GET", "/v1/health/x")],
    ids=["post-health", "health-subpath"],
)
def test_token_exemption_only_for_get_health(
    client: TestClient, fakes: FakeServices, method: str, path: str
) -> None:
    """[REQ-RAG-9.3.1] 토큰 검사 예외는 GET /v1/health뿐이다 — 다른 메서드·경로는 401이다."""
    response = send(client, method, path, token=False)

    _assert_unauthorized(response)
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.3.1")
def test_token_not_echoed(client: TestClient) -> None:
    """[REQ-RAG-9.3.1] 틀린 토큰 값은 오류 응답에 나오지 않는다."""
    wrong = "WRONG-TOKEN-5e6f"

    response = send(
        client,
        "POST",
        "/v1/search",
        token=False,
        headers={"X-Minerva-Token": wrong},
        json={"query": "q"},
    )

    assert response.status_code == 401
    assert wrong not in response.text
    assert TOKEN not in response.text
