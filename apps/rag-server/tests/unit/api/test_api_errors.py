"""예외 변환(REQ-RAG-9.1.2, REQ-RAG-11.3.1, REQ-RAG-11.3.2) 테스트."""

import re
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from minerva_rag import core
from minerva_rag.core import (
    CaptionFailedError,
    DocumentNotSearchableError,
    GlossaryError,
    JobNotFoundError,
    MinervaError,
    ModelUnavailableError,
    ServerNotReadyError,
    ShuttingDownError,
    StoreUnavailableError,
    VectorDimensionMismatchError,
)

from .fakes import (
    ENDPOINT_BY_NAME,
    ENDPOINTS,
    Endpoint,
    FakeServices,
    index_body,
    send,
    send_endpoint,
)

_HANGUL = re.compile(r"[가-힣]")

# (예외 클래스, 엔드포인트 이름, 상태, 코드)
_MAPPING = [
    (JobNotFoundError, "get_job", 404, "JOB_NOT_FOUND"),
    (DocumentNotSearchableError, "evaluation", 409, "DOCUMENT_NOT_SEARCHABLE"),
    (CaptionFailedError, "table_caption", 502, "CAPTION_FAILED"),
    (CaptionFailedError, "image_caption", 502, "CAPTION_FAILED"),
    (ModelUnavailableError, "table_caption", 503, "MODEL_UNAVAILABLE"),
    (ModelUnavailableError, "image_caption", 503, "MODEL_UNAVAILABLE"),
    (ModelUnavailableError, "search", 503, "MODEL_UNAVAILABLE"),
    (ModelUnavailableError, "evaluation", 503, "MODEL_UNAVAILABLE"),
    (StoreUnavailableError, "search", 503, "STORE_UNAVAILABLE"),
    (StoreUnavailableError, "evaluation", 503, "STORE_UNAVAILABLE"),
    (VectorDimensionMismatchError, "search", 500, "VECTOR_DIMENSION_MISMATCH"),
    (ShuttingDownError, "index_job", 503, "SHUTTING_DOWN"),
    (GlossaryError, "search", 500, "INTERNAL_ERROR"),
]


def _arm(fakes: FakeServices, ep: Endpoint, exc: BaseException) -> None:
    """엔드포인트가 부르는 가짜 메서드가 예외를 내게 한다."""
    fakes.fake(ep.fake).raises[ep.call] = exc


@pytest.mark.req("REQ-RAG-9.1.2", "REQ-RAG-11.3.1")
@pytest.mark.parametrize(
    ("exc_type", "endpoint", "status", "code"),
    _MAPPING,
    ids=[f"{m[0].__name__}-{m[1]}" for m in _MAPPING],
)
def test_minerva_error_status_and_code(
    client: TestClient,
    fakes: FakeServices,
    exc_type: type[MinervaError],
    endpoint: str,
    status: int,
    code: str,
) -> None:
    """[REQ-RAG-9.1.2] MinervaError는 그 클래스의 코드와 API.md의 상태로 바뀌고 message를 옮긴다."""
    exc = exc_type()
    _arm(fakes, ENDPOINT_BY_NAME[endpoint], exc)

    response = send_endpoint(client, ENDPOINT_BY_NAME[endpoint])

    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"error": {"code": code, "message": exc.message}}


def _all_error_types() -> list[type[MinervaError]]:
    """core가 공개로 내보낸 MinervaError 하위 클래스를 모은다 (core MODULE.md 「예외」 표).

    ★ 다른 단위의 비공개(`_`) 하위 클래스는 생성자 인자가 달라 대상이 아니다.
    """
    found: list[type[MinervaError]] = []
    for name in core.__all__:
        obj = getattr(core, name)
        if isinstance(obj, type) and issubclass(obj, MinervaError) and obj is not MinervaError:
            found.append(obj)
    return found


# API.md 「오류 코드」 표의 코드 → 상태다 (리터럴)
_API_MD_STATUS = {
    "INVALID_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "JOB_NOT_FOUND": 404,
    "PAYLOAD_TOO_LARGE": 413,
    "DOCUMENT_NOT_SEARCHABLE": 409,
    "INTERNAL_ERROR": 500,
    "VECTOR_DIMENSION_MISMATCH": 500,
    "CAPTION_FAILED": 502,
    "MODEL_UNAVAILABLE": 503,
    "STORE_UNAVAILABLE": 503,
    "SERVER_NOT_READY": 503,
    "SHUTTING_DOWN": 503,
}


@pytest.mark.req("REQ-RAG-9.1.2", "REQ-RAG-11.3.1")
@pytest.mark.parametrize("exc_type", _all_error_types(), ids=lambda t: t.__name__)
def test_every_minerva_error_is_converted(
    client: TestClient, fakes: FakeServices, exc_type: type[MinervaError]
) -> None:
    """[REQ-RAG-11.3.1] MinervaError 하위 클래스 전부가 그 code와 message로 바뀐다."""
    exc = exc_type()
    _arm(fakes, ENDPOINT_BY_NAME["search"], exc)

    response = send_endpoint(client, ENDPOINT_BY_NAME["search"])

    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"] == {"code": exc.code, "message": exc.message}
    if exc.code in _API_MD_STATUS:
        assert response.status_code == _API_MD_STATUS[exc.code]
    else:
        # ★ API.md 표에 상태가 없는 코드(CHUNKING_FAILED)는 오류 상태인지만 본다
        assert response.status_code >= 400


class _PrivateGlossaryError(GlossaryError):
    """다른 단위의 비공개 하위 클래스를 흉내 낸다. 생성자가 인자를 더 요구한다."""

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


@pytest.mark.req("REQ-RAG-11.3.1")
def test_private_subclass_converted_by_its_code(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-11.3.1] 경계로 새어 나온 비공개 하위 클래스도 그 code와 message로 바뀐다."""
    exc = _PrivateGlossaryError("용어집 항목이 잘못되었습니다", "내부 사유")
    _arm(fakes, ENDPOINT_BY_NAME["search"], exc)

    response = send_endpoint(client, ENDPOINT_BY_NAME["search"])

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": exc.code, "message": "용어집 항목이 잘못되었습니다"}
    }
    assert "내부 사유" not in response.text


@pytest.mark.req("REQ-RAG-9.1.2", "REQ-RAG-11.3.1")
@pytest.mark.parametrize("ep", ENDPOINTS, ids=[ep.name for ep in ENDPOINTS])
def test_server_not_ready_on_every_endpoint(
    client: TestClient, fakes: FakeServices, ep: Endpoint
) -> None:
    """[REQ-RAG-11.3.1] service가 낸 준비 전 오류는 모든 엔드포인트에서 503 SERVER_NOT_READY다."""
    exc = ServerNotReadyError()
    _arm(fakes, ep, exc)

    response = send_endpoint(client, ep)

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"error": {"code": "SERVER_NOT_READY", "message": exc.message}}


@pytest.mark.req("REQ-RAG-11.3.2")
@pytest.mark.parametrize("endpoint", ["search", "table_caption", "index_job"])
def test_unhandled_error_is_500_without_details(
    client: TestClient, fakes: FakeServices, endpoint: str
) -> None:
    """[REQ-RAG-11.3.2] 예상하지 못한 예외는 500 INTERNAL_ERROR이고 응답에 예외 내용이 없다."""
    secret = "SECRET-a1b2 C:\\data\\doc.md SELECT * FROM jobs"
    _arm(fakes, ENDPOINT_BY_NAME[endpoint], RuntimeError(secret))

    response = send_endpoint(client, ENDPOINT_BY_NAME[endpoint])

    assert response.status_code == 500
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == "INTERNAL_ERROR"
    assert _HANGUL.search(body["error"]["message"])
    for leaked in ("SECRET-a1b2", "doc.md", "SELECT", "Traceback"):
        assert leaked not in response.text


@pytest.mark.req("REQ-RAG-11.3.1")
def test_error_messages_are_korean(
    client: TestClient,
    fakes: FakeServices,
    set_limits: Callable[..., None],
    make_client: Callable[[], TestClient],
) -> None:
    """[REQ-RAG-11.3.1] 400·401·413·404·500 응답의 message는 비어 있지 않은 한국어다."""
    set_limits(markdown=1024)
    small_client = make_client()
    fakes.index.raises["get_job"] = JobNotFoundError()
    fakes.search.raises["search"] = RuntimeError("내부 오류")

    responses = [
        send(small_client, "POST", "/v1/search", json={"query": "q", "top_n": 0}),  # 400
        send(small_client, "POST", "/v1/search", token=False, json={"query": "q"}),  # 401
        send(small_client, "POST", "/v1/index-jobs", json=index_body(markdown="a" * 1025)),  # 413
        send(small_client, "GET", "/v1/index-jobs/x"),  # 404
        send(small_client, "POST", "/v1/search", json={"query": "q"}),  # 500
    ]

    assert [r.status_code for r in responses] == [400, 401, 413, 404, 500]
    for response in responses:
        message = response.json()["error"]["message"]
        assert message
        assert _HANGUL.search(message)
