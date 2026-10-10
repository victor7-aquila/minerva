"""크기 한도 초과 거부(REQ-RAG-9.1.3) 테스트."""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from minerva_rag.api import create_app

from .fakes import (
    AUTH,
    FakeServices,
    call_raw,
    index_body,
    send,
    without,
)

# ★ 한도는 1KiB로 정한다. 본문 전체(JSON·multipart 포장 포함)가 한도의 몇 배가 되지 않아야
#   Content-Length 사전 검사의 문턱값(구현 재량)에 걸리지 않고 정상 경로를 탄다
LIMIT = 1024
_IMAGE = bytes(range(256)) * 4  # 정확히 1024바이트


def _too_large(response: Any) -> None:
    """413 PAYLOAD_TOO_LARGE 본문인지 확인한다."""
    assert response.status_code == 413
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == "PAYLOAD_TOO_LARGE"


@pytest.mark.req("REQ-RAG-9.1.3")
def test_markdown_at_limit_is_accepted(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] 한도와 같은 크기의 markdown은 처리된다."""
    set_limits(markdown=LIMIT, image=LIMIT)
    markdown = "가" * 341 + "a"  # UTF-8 1024바이트, 342자
    assert len(markdown.encode()) == LIMIT

    response = send(make_client(), "POST", "/v1/index-jobs", json=index_body(markdown=markdown))

    assert response.status_code == 202
    fakes.only_call("index", "submit")


@pytest.mark.req("REQ-RAG-9.1.3")
def test_markdown_over_limit_is_rejected(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] 한도보다 1바이트 큰 markdown은 413이고 service는 불리지 않는다."""
    set_limits(markdown=LIMIT, image=LIMIT)
    markdown = "가" * 341 + "ab"
    assert len(markdown.encode()) == LIMIT + 1

    response = send(make_client(), "POST", "/v1/index-jobs", json=index_body(markdown=markdown))

    _too_large(response)
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.1.3")
def test_markdown_limit_counts_utf8_bytes(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] 한도는 글자 수가 아니라 UTF-8 바이트 수로 센다."""
    set_limits(markdown=LIMIT, image=LIMIT)
    markdown = "가" * 342  # 342자이지만 1026바이트
    assert len(markdown) < LIMIT < len(markdown.encode())

    response = send(make_client(), "POST", "/v1/index-jobs", json=index_body(markdown=markdown))

    _too_large(response)
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.1.3")
def test_image_at_limit_is_accepted(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] 한도와 같은 크기의 이미지는 처리된다."""
    set_limits(markdown=LIMIT, image=LIMIT)

    response = send(
        make_client(), "POST", "/v1/captions/image", files={"image": ("a.png", _IMAGE, "image/png")}
    )

    assert response.status_code == 200
    (received,) = fakes.only_call("caption", "caption_image")
    assert len(received) == LIMIT


@pytest.mark.req("REQ-RAG-9.1.3")
def test_image_over_limit_is_rejected(
    set_limits: Callable[..., None], make_client: Callable[[], TestClient], fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.3] 한도보다 1바이트 큰 이미지는 413이고 service는 불리지 않는다."""
    set_limits(markdown=LIMIT, image=LIMIT)

    response = send(
        make_client(),
        "POST",
        "/v1/captions/image",
        files={"image": ("a.png", _IMAGE + b"\x00", "image/png")},
    )

    _too_large(response)
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.1.3")
@pytest.mark.parametrize(
    ("path", "content_type"),
    [
        ("/v1/index-jobs", "application/json"),
        ("/v1/captions/image", "multipart/form-data; boundary=x"),
    ],
    ids=["index", "image"],
)
def test_huge_content_length_rejected_without_reading(
    set_limits: Callable[..., None], fakes: FakeServices, path: str, content_type: str
) -> None:
    """[REQ-RAG-9.1.3] Content-Length가 한도보다 훨씬 크면 본문을 끝까지 읽지 않고 413이다."""
    set_limits(markdown=LIMIT, image=LIMIT)
    app = create_app(fakes.services)

    # ★ receive는 1KiB 조각 세 개를 주고 막힌다. 본문을 끝까지 읽으려 하면 상한 시간에 걸려 실패한다
    result = call_raw(
        app,
        "POST",
        path,
        {**AUTH, "content-type": content_type, "content-length": "1000000000"},
        [b"x" * 1024] * 3,
    )

    assert result.status == 413
    assert result.body["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.1.3", "REQ-RAG-9.1.2")
@pytest.mark.parametrize(
    "make_body",
    [
        lambda big: without(index_body(markdown=big), "name"),
        lambda big: index_body(
            markdown=big,
            assets=[
                {"placeholder_id": "t1", "text": "첫째"},
                {"placeholder_id": "t1", "text": "둘째"},
            ],
        ),
    ],
    ids=["missing-name", "duplicate-placeholder"],
)
def test_validation_checked_before_field_size(
    set_limits: Callable[..., None],
    make_client: Callable[[], TestClient],
    fakes: FakeServices,
    make_body: Callable[[str], dict[str, Any]],
) -> None:
    """[REQ-RAG-9.1.3] 한도를 넘는 markdown이 다른 검증 오류와 겹치면 413이 아니라 400이다."""
    set_limits(markdown=LIMIT, image=LIMIT)
    markdown = "a" * (LIMIT + 1)

    response = send(make_client(), "POST", "/v1/index-jobs", json=make_body(markdown))

    # ★ MODULE.md 검사 순서: 요청 검증(400) → markdown·image 크기(413)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert fakes.total_calls(include_lifecycle=True) == 0
