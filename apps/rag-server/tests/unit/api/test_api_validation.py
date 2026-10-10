"""형식이 잘못된 요청 거부(REQ-RAG-9.1.2) 테스트."""

import re
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import InvalidRequestError
from minerva_rag.evaluation import EvaluationCase
from minerva_rag.search import SearchQuery

from .fakes import (
    INDEX_BODY,
    FakeServices,
    index_body,
    send,
    without,
)

_HANGUL = re.compile(r"[가-힣]")
_MULTIPART = {"content-type": "multipart/form-data; boundary=x"}
_SEARCH = "/v1/search"
_EVAL = "/v1/evaluations"
_EVAL_BODY: dict[str, Any] = {"query": "질의", "doc_id": "doc-1", "answer_span": "정답 구간"}
_META = "/v1/documents/doc-1/metadata"


def _case(case_id: str, method: str, path: str, **kwargs: Any) -> Any:
    """(메서드, 경로, 요청 인자)를 읽기 쉬운 ID와 함께 묶는다."""
    return pytest.param(method, path, kwargs, id=case_id)


_REJECTED = [
    # ── 필수 필드 없음 ─────────────────────────────
    _case("missing-table_markdown", "POST", "/v1/captions/table", json={}),
    _case(
        "missing-image-empty-multipart",
        "POST",
        "/v1/captions/image",
        content=b"--x--\r\n",
        headers=_MULTIPART,
    ),
    _case("missing-image-json-body", "POST", "/v1/captions/image", json={}),
    _case(
        "missing-image-wrong-field",
        "POST",
        "/v1/captions/image",
        files={"other": ("a.png", b"abc", "image/png")},
    ),
    *[
        _case(f"index-missing-{key}", "POST", "/v1/index-jobs", json=without(INDEX_BODY, key))
        for key in ("doc_id", "version", "markdown", "assets", "name")
    ],
    _case("index-states-missing-doc_ids", "POST", "/v1/documents/index-states", json={}),
    _case("metadata-missing-name", "PUT", _META, json={"edition": None}),
    _case("metadata-missing-edition-key", "PUT", _META, json={"name": "이름"}),
    _case("search-missing-query", "POST", _SEARCH, json={}),
    *[
        _case(f"evaluation-missing-{key}", "POST", _EVAL, json=without(_EVAL_BODY, key))
        for key in ("query", "doc_id", "answer_span")
    ],
    # ── 타입·형식 불일치 ───────────────────────────
    _case("index-assets-string", "POST", "/v1/index-jobs", json=index_body(assets="t1")),
    _case(
        "index-asset-without-text",
        "POST",
        "/v1/index-jobs",
        json=index_body(assets=[{"placeholder_id": "t1"}]),
    ),
    _case(
        "index-edition-without-date",
        "POST",
        "/v1/index-jobs",
        json=index_body(edition={"label": "2025"}),
    ),
    _case(
        "index-edition-bad-date",
        "POST",
        "/v1/index-jobs",
        json=index_body(edition={"label": "2025", "edition_date": "2025-13-45"}),
    ),
    _case("index-chunking-unknown", "POST", "/v1/index-jobs", json=index_body(chunking="fast")),
    _case("index-force-object", "POST", "/v1/index-jobs", json=index_body(force={"x": 1})),
    _case("search-top_n-string", "POST", _SEARCH, json={"query": "q", "top_n": "many"}),
    _case("search-doc_ids-string", "POST", _SEARCH, json={"query": "q", "doc_ids": "a"}),
    _case("search-scope-unknown", "POST", _SEARCH, json={"query": "q", "edition_scope": "newest"}),
    _case(
        "search-edition-without-label",
        "POST",
        _SEARCH,
        json={"query": "q", "edition_scope": "specific", "edition": {"name": "x"}},
    ),
    _case("evaluation-edition_only-list", "POST", _EVAL, json={**_EVAL_BODY, "edition_only": [1]}),
    _case(
        "table-table_markdown-object",
        "POST",
        "/v1/captions/table",
        json={"table_markdown": {"a": 1}},
    ),
    # ── 범위 ───────────────────────────────────────
    _case("search-top_n-0", "POST", _SEARCH, json={"query": "q", "top_n": 0}),
    _case("search-top_n-minus1", "POST", _SEARCH, json={"query": "q", "top_n": -1}),
    _case("evaluation-top_n-0", "POST", _EVAL, json={**_EVAL_BODY, "top_n": 0}),
    _case("index-states-empty", "POST", "/v1/documents/index-states", json={"doc_ids": []}),
    _case(
        "index-states-101",
        "POST",
        "/v1/documents/index-states",
        json={"doc_ids": [f"d{i}" for i in range(101)]},
    ),
    # ── 조건부 필수 ────────────────────────────────
    _case(
        "search-specific-without-edition",
        "POST",
        _SEARCH,
        json={"query": "q", "edition_scope": "specific"},
    ),
    _case(
        "search-specific-edition-null",
        "POST",
        _SEARCH,
        json={"query": "q", "edition_scope": "specific", "edition": None},
    ),
    # ── 본문 해석 ──────────────────────────────────
    _case(
        "index-broken-json",
        "POST",
        "/v1/index-jobs",
        content=b"{",
        headers={"content-type": "application/json"},
    ),
    # ── 자리표시 중복 ──────────────────────────────
    _case(
        "index-duplicate-placeholder",
        "POST",
        "/v1/index-jobs",
        json=index_body(
            assets=[
                {"placeholder_id": "t1", "text": "첫째"},
                {"placeholder_id": "t1", "text": "둘째"},
            ]
        ),
    ),
]


def _assert_invalid(response: Response, fakes: FakeServices) -> None:
    """400 INVALID_REQUEST 본문이고 service가 불리지 않았는지 확인한다."""
    assert response.status_code == 400
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert _HANGUL.search(body["error"]["message"])
    assert fakes.total_calls(include_lifecycle=True) == 0


@pytest.mark.req("REQ-RAG-9.1.2")
@pytest.mark.parametrize(("method", "path", "kwargs"), _REJECTED)
def test_invalid_request_rejected(
    client: TestClient, fakes: FakeServices, method: str, path: str, kwargs: dict[str, Any]
) -> None:
    """[REQ-RAG-9.1.2] 형식이 잘못된 요청은 422가 아니라 400이고 service는 불리지 않는다."""
    _assert_invalid(send(client, method, path, **kwargs), fakes)


@pytest.mark.req("REQ-RAG-9.1.2")
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1/unknown"),
        ("GET", "/v1/search"),
        ("DELETE", "/v1/index-jobs/j1"),
    ],
    ids=["unknown-path", "wrong-method-search", "wrong-method-job"],
)
def test_undefined_route_is_400(
    client: TestClient, fakes: FakeServices, method: str, path: str
) -> None:
    """[REQ-RAG-9.1.2] API.md에 없는 경로·메서드는 404·405가 아니라 400이고 detail 키가 없다."""
    response = send(client, method, path)

    _assert_invalid(response, fakes)
    assert "detail" not in response.json()


@pytest.mark.req("REQ-RAG-9.1.2")
@pytest.mark.parametrize("count", [1, 100])
def test_index_states_boundaries_accepted(
    client: TestClient, fakes: FakeServices, count: int
) -> None:
    """[REQ-RAG-9.1.2] doc_ids 1개와 100개는 정상이다."""
    doc_ids = [f"d{i}" for i in range(count)]

    response = send(client, "POST", "/v1/documents/index-states", json={"doc_ids": doc_ids})

    assert response.status_code == 200
    (received,) = fakes.only_call("index", "index_states")
    assert list(received) == doc_ids


@pytest.mark.req("REQ-RAG-9.1.2")
def test_service_invalid_request_maps_to_400(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.2] service의 InvalidRequestError도 400 INVALID_REQUEST이고 message를 옮긴다."""
    message = "assets에 요약·캡션이 없는 자리표시가 2개 있습니다"
    fakes.index.raises["submit"] = InvalidRequestError(message)

    response = send(client, "POST", "/v1/index-jobs", json=index_body())

    assert response.status_code == 400
    assert response.json() == {"error": {"code": "INVALID_REQUEST", "message": message}}


@pytest.mark.req("REQ-RAG-9.1.2", "REQ-RAG-11.3.2")
def test_validation_error_hides_input(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.2] 검증 오류 응답에 요청에 담긴 입력값이 나오지 않는다."""
    first = send(client, "POST", _SEARCH, json={"query": "q", "top_n": "MARKER-9f3a"})
    second = send(
        client,
        "POST",
        "/v1/index-jobs",
        json=index_body(markdown=12345, name="MARKER-7c1d"),
    )

    assert first.status_code == 400
    assert second.status_code == 400
    assert "MARKER-9f3a" not in first.text
    assert "MARKER-7c1d" not in second.text


@pytest.mark.req("REQ-RAG-9.1.2")
def test_optional_null_means_default(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.2] 요청의 선택 필드가 null이면 빠뜨린 것과 같게 기본값을 쓴다."""
    search = send(
        client,
        "POST",
        _SEARCH,
        json={
            "query": "q",
            "top_n": None,
            "doc_ids": None,
            "edition_scope": None,
            "edition": None,
            "expand_neighbors": None,
        },
    )
    index = send(
        client,
        "POST",
        "/v1/index-jobs",
        json=index_body(edition=None, chunking=None, force=None),
    )
    evaluation = send(
        client, "POST", _EVAL, json={**_EVAL_BODY, "edition_only": None, "top_n": None}
    )

    assert (search.status_code, index.status_code, evaluation.status_code) == (200, 202, 200)
    assert fakes.search.calls == [("search", (SearchQuery("q"),))]
    (req,) = fakes.index.calls[0][1]
    assert req.edition is None
    assert req.chunking == ChunkingMode.SEMANTIC
    assert req.force is False
    assert fakes.evaluation.calls == [("evaluate", (EvaluationCase("질의", "doc-1", "정답 구간"),))]
