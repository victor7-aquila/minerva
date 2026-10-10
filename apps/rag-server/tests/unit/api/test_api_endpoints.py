"""엔드포인트와 service 연결(REQ-RAG-9.1.1) 테스트."""

from datetime import date
from typing import Any, Literal

import pytest
from fastapi.testclient import TestClient

from minerva_rag.chunking import ChunkingMode
from minerva_rag.core import Edition, FailureLocation
from minerva_rag.evaluation import EvaluationCase
from minerva_rag.search import EditionRef, EditionScope, SearchQuery
from minerva_rag.service import (
    IndexAccepted,
    IndexOutcome,
    IndexRequest,
    IndexStateView,
    JobStage,
    JobState,
)

from .fakes import (
    IMAGE_BYTES,
    INDEX_BODY,
    FakeServices,
    document_chunks_full,
    evaluation_result,
    hit_with_edition,
    hit_without_edition,
    index_body,
    job_failure,
    job_view,
    send,
)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_table_caption(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 표 요약 요청이 CaptionService.summarize_table로 간다."""
    response = send(client, "POST", "/v1/captions/table", json={"table_markdown": "| a | b |"})

    assert response.status_code == 200
    assert response.json() == {"summary": "표 요약 문장"}
    assert fakes.only_call("caption", "summarize_table") == ("| a | b |",)


@pytest.mark.req("REQ-RAG-9.1.1")
@pytest.mark.parametrize(
    "part",
    [
        ("figure.svg", IMAGE_BYTES, "text/plain"),
        ("a.png", IMAGE_BYTES, "application/octet-stream"),
        ("noext", IMAGE_BYTES),
    ],
    ids=["svg-text-plain", "png-octet-stream", "no-extension"],
)
def test_image_caption_passes_bytes(
    client: TestClient, fakes: FakeServices, part: tuple[Any, ...]
) -> None:
    """[REQ-RAG-9.1.1] 이미지 바이트는 파트의 Content-Type·파일 이름과 무관하게 그대로 넘어간다."""
    response = send(client, "POST", "/v1/captions/image", files={"image": part})

    assert response.status_code == 200
    assert response.json() == {"caption": "이미지 캡션 문장"}
    assert fakes.only_call("caption", "caption_image") == (IMAGE_BYTES,)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_index_job_full_request(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] API.md 예시 본문이 IndexRequest로 옮겨져 IndexService.submit으로 간다."""
    response = send(client, "POST", "/v1/index-jobs", json=INDEX_BODY)

    assert response.status_code == 202
    assert response.json() == {
        "outcome": "queued",
        "job_id": "job-7f3a",
        "doc_id": "3f2b8c1e-5d4a-4e7b-9c6f-0a1b2c3d4e5f",
        "version": "3",
    }
    (req,) = fakes.only_call("index", "submit")
    assert req == IndexRequest(
        doc_id="3f2b8c1e-5d4a-4e7b-9c6f-0a1b2c3d4e5f",
        version="3",
        markdown="# 설치\n\n[[minerva:table:t1 | 환경 변수 표]]",
        name="IEEE 1609.2.1",
        assets={"t1": "환경 변수별 타입과 기본값을 정리한 표"},
        edition=Edition("2025", date(2025, 1, 31)),
        chunking=ChunkingMode.SEMANTIC,
        force=False,
    )


@pytest.mark.req("REQ-RAG-9.1.1")
def test_index_job_defaults(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 선택 필드를 빼면 기본값을 쓰고, 빈 assets는 빈 매핑이다."""
    response = send(client, "POST", "/v1/index-jobs", json=index_body())

    assert response.status_code == 202
    (req,) = fakes.only_call("index", "submit")
    assert req.edition is None
    assert req.chunking == ChunkingMode.SEMANTIC
    assert req.force is False
    assert dict(req.assets) == {}


@pytest.mark.req("REQ-RAG-9.1.1")
def test_index_job_rule_and_force(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] chunking=rule, force=true가 그대로 넘어간다."""
    response = send(client, "POST", "/v1/index-jobs", json=index_body(chunking="rule", force=True))

    assert response.status_code == 202
    (req,) = fakes.only_call("index", "submit")
    assert req.chunking == ChunkingMode.RULE
    assert req.force is True


@pytest.mark.req("REQ-RAG-9.1.1")
@pytest.mark.parametrize(
    ("outcome", "status"),
    [("queued", 202), ("joined", 202), ("reused", 200)],
)
def test_index_job_status_by_outcome(
    client: TestClient,
    fakes: FakeServices,
    outcome: Literal["queued", "joined", "reused"],
    status: int,
) -> None:
    """[REQ-RAG-9.1.1] 응답 상태는 outcome이 queued·joined면 202, reused면 200이다."""
    fakes.index.returns["submit"] = IndexAccepted(outcome, "job-9", "doc-1", "3")

    response = send(client, "POST", "/v1/index-jobs", json=index_body())

    assert response.status_code == status
    assert response.json() == {
        "outcome": outcome,
        "job_id": "job-9",
        "doc_id": "doc-1",
        "version": "3",
    }


_JOB_CASES: list[Any] = [
    pytest.param(
        job_view(),
        {
            "job_id": "job-1",
            "doc_id": "doc-1",
            "version": "3",
            "state": "queued",
            "stage": None,
            "failure": None,
            "result": None,
        },
        id="queued",
    ),
    pytest.param(
        job_view(state=JobState.RUNNING, stage=JobStage.EMBEDDING),
        {
            "job_id": "job-1",
            "doc_id": "doc-1",
            "version": "3",
            "state": "running",
            "stage": "embedding",
            "failure": None,
            "result": None,
        },
        id="running",
    ),
    pytest.param(
        job_view(
            state=JobState.FAILED,
            failure=job_failure(FailureLocation(("설치", "환경 변수"), "t1")),
        ),
        {
            "job_id": "job-1",
            "doc_id": "doc-1",
            "version": "3",
            "state": "failed",
            "stage": None,
            "failure": {
                "code": "CHUNKING_FAILED",
                "message": "절 분할에 실패했습니다",
                "heading_path": ["설치", "환경 변수"],
                "placeholder_id": "t1",
            },
            "result": None,
        },
        id="failed-with-location",
    ),
    pytest.param(
        job_view(state=JobState.FAILED, failure=job_failure(None)),
        {
            "job_id": "job-1",
            "doc_id": "doc-1",
            "version": "3",
            "state": "failed",
            "stage": None,
            "failure": {
                "code": "CHUNKING_FAILED",
                "message": "절 분할에 실패했습니다",
                "heading_path": None,
                "placeholder_id": None,
            },
            "result": None,
        },
        id="failed-no-location",
    ),
    pytest.param(
        job_view(state=JobState.FAILED, failure=job_failure(FailureLocation(None, "t1"))),
        {
            "job_id": "job-1",
            "doc_id": "doc-1",
            "version": "3",
            "state": "failed",
            "stage": None,
            "failure": {
                "code": "CHUNKING_FAILED",
                "message": "절 분할에 실패했습니다",
                "heading_path": None,
                "placeholder_id": "t1",
            },
            "result": None,
        },
        id="failed-placeholder-only",
    ),
    pytest.param(
        job_view(state=JobState.SUCCEEDED, result=IndexOutcome(3, True)),
        {
            "job_id": "job-1",
            "doc_id": "doc-1",
            "version": "3",
            "state": "succeeded",
            "stage": None,
            "failure": None,
            "result": {"chunk_count": 3, "fallback_used": True},
        },
        id="succeeded",
    ),
]


@pytest.mark.req("REQ-RAG-9.1.1")
@pytest.mark.parametrize(("view", "expected"), _JOB_CASES)
def test_get_job_shapes(
    client: TestClient, fakes: FakeServices, view: Any, expected: dict[str, Any]
) -> None:
    """[REQ-RAG-9.1.1] 작업 상태가 IndexJob 모양으로 나오고, 값이 없는 선택 필드는 null이다."""
    fakes.index.returns["get_job"] = view

    response = send(client, "GET", "/v1/index-jobs/job-1")

    assert response.status_code == 200
    assert response.json() == expected
    assert fakes.only_call("index", "get_job") == ("job-1",)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_delete_document(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 문서 삭제는 204이고 본문이 없다."""
    response = send(client, "DELETE", "/v1/documents/doc-1")

    assert response.status_code == 204
    assert response.content == b""
    assert fakes.only_call("delete", "delete") == ("doc-1",)


@pytest.mark.req("REQ-RAG-9.1.1")
@pytest.mark.parametrize(
    ("view", "expected"),
    [
        pytest.param(
            IndexStateView("doc-1", None, None, None, None),
            {
                "doc_id": "doc-1",
                "searchable_version": None,
                "latest_job_id": None,
                "latest_job_state": None,
                "latest_job_stage": None,
            },
            id="never-indexed",
        ),
        pytest.param(
            IndexStateView("doc-1", "2", "job-2", JobState.RUNNING, JobStage.STORING),
            {
                "doc_id": "doc-1",
                "searchable_version": "2",
                "latest_job_id": "job-2",
                "latest_job_state": "running",
                "latest_job_stage": "storing",
            },
            id="running",
        ),
    ],
)
def test_index_state_shapes(
    client: TestClient, fakes: FakeServices, view: IndexStateView, expected: dict[str, Any]
) -> None:
    """[REQ-RAG-9.1.1] 문서 색인 상태가 다섯 키의 IndexState로 나온다."""
    fakes.index.returns["index_state"] = view

    response = send(client, "GET", "/v1/documents/doc-1/index-state")

    assert response.status_code == 200
    assert response.json() == expected
    assert fakes.only_call("index", "index_state") == ("doc-1",)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_index_states_keeps_order(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 여러 문서 조회는 ID의 순서·중복을 그대로 넘기고 결과 순서도 그대로다."""
    fakes.index.returns["index_states"] = [
        IndexStateView("b", "1", "job-b", JobState.SUCCEEDED, None),
        IndexStateView("a", None, None, None, None),
        IndexStateView("b", "1", "job-b", JobState.SUCCEEDED, None),
    ]

    response = send(client, "POST", "/v1/documents/index-states", json={"doc_ids": ["b", "a", "b"]})

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "doc_id": "b",
                "searchable_version": "1",
                "latest_job_id": "job-b",
                "latest_job_state": "succeeded",
                "latest_job_stage": None,
            },
            {
                "doc_id": "a",
                "searchable_version": None,
                "latest_job_id": None,
                "latest_job_state": None,
                "latest_job_stage": None,
            },
            {
                "doc_id": "b",
                "searchable_version": "1",
                "latest_job_id": "job-b",
                "latest_job_state": "succeeded",
                "latest_job_stage": None,
            },
        ]
    }
    (doc_ids,) = fakes.only_call("index", "index_states")
    assert list(doc_ids) == ["b", "a", "b"]


@pytest.mark.req("REQ-RAG-9.1.1")
@pytest.mark.parametrize(
    ("edition_body", "edition"),
    [
        ({"label": "2025", "edition_date": "2025-01-31"}, Edition("2025", date(2025, 1, 31))),
        (None, None),
    ],
    ids=["with-edition", "edition-null"],
)
def test_update_metadata(
    client: TestClient, fakes: FakeServices, edition_body: Any, edition: Edition | None
) -> None:
    """[REQ-RAG-9.1.1] 이름·판 정보 변경은 204이고 (doc_id, name, edition)이 넘어간다."""
    response = send(
        client,
        "PUT",
        "/v1/documents/doc-1/metadata",
        json={"name": "새 이름", "edition": edition_body},
    )

    assert response.status_code == 204
    assert response.content == b""
    assert fakes.only_call("metadata", "update") == ("doc-1", "새 이름", edition)


_CHUNK_KEYS = {
    "chunk_id",
    "order",
    "kind",
    "heading_path",
    "title",
    "summary",
    "text",
    "placeholder_ids",
    "split_index",
    "split_total",
}


@pytest.mark.req("REQ-RAG-9.1.1")
def test_document_chunks_shape(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 문서 청크 응답은 version과 items뿐이고, 표 청크의 제목·요약은 null이다."""
    fakes.search.returns["document_chunks"] = document_chunks_full()

    response = send(client, "GET", "/v1/documents/doc-1/chunks")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"version", "items"}
    assert body["version"] == "3"
    assert [set(item) for item in body["items"]] == [_CHUNK_KEYS, _CHUNK_KEYS]
    assert body["items"] == [
        {
            "chunk_id": "c-1",
            "order": 0,
            "kind": "text",
            "heading_path": ["설치"],
            "title": "제목",
            "summary": "요약",
            "text": "본문",
            "placeholder_ids": [],
            "split_index": None,
            "split_total": None,
        },
        {
            "chunk_id": "c-2",
            "order": 1,
            "kind": "asset",
            "heading_path": ["설치"],
            "title": None,
            "summary": None,
            "text": "[[minerva:table:t1 | 표]]",
            "placeholder_ids": ["t1"],
            "split_index": 2,
            "split_total": 2,
        },
    ]
    assert fakes.only_call("search", "document_chunks") == ("doc-1",)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_document_chunks_empty(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 검색되는 버전이 없으면 version은 null, items는 빈 배열이다."""
    response = send(client, "GET", "/v1/documents/doc-1/chunks")

    assert response.status_code == 200
    assert response.json() == {"version": None, "items": []}


@pytest.mark.req("REQ-RAG-9.1.1")
def test_search_full_request(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 검색 요청의 모든 필드가 SearchQuery로 옮겨진다."""
    response = send(
        client,
        "POST",
        "/v1/search",
        json={
            "query": "인증서 갱신 절차",
            "top_n": 1,
            "doc_ids": ["a", "b"],
            "edition_scope": "specific",
            "edition": {"name": "IEEE 1609.2.1", "label": "2025"},
            "expand_neighbors": True,
        },
    )

    assert response.status_code == 200
    (query,) = fakes.only_call("search", "search")
    assert query == SearchQuery(
        "인증서 갱신 절차",
        1,
        ("a", "b"),
        EditionScope.SPECIFIC,
        EditionRef("IEEE 1609.2.1", "2025"),
        True,
    )


@pytest.mark.req("REQ-RAG-9.1.1")
def test_search_defaults(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] query만 주면 나머지는 기본값이다."""
    response = send(client, "POST", "/v1/search", json={"query": "q"})

    assert response.status_code == 200
    (query,) = fakes.only_call("search", "search")
    assert query.query == "q"
    assert query.top_n is None
    assert query.doc_ids is None
    assert query.edition_scope == EditionScope.ALL
    assert query.edition is None
    assert query.expand_neighbors is False


@pytest.mark.req("REQ-RAG-9.1.1")
def test_search_empty_doc_ids_is_not_unrestricted(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 빈 doc_ids는 제한 없음(None)이 아니라 빈 튜플로 넘어간다."""
    response = send(client, "POST", "/v1/search", json={"query": "q", "doc_ids": []})

    assert response.status_code == 200
    (query,) = fakes.only_call("search", "search")
    assert query.doc_ids == ()


@pytest.mark.req("REQ-RAG-9.1.1")
def test_search_result_shape(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 검색 결과가 순서 그대로 SearchResult 모양으로 나온다."""
    fakes.search.returns["search"] = (hit_with_edition(), hit_without_edition())

    response = send(client, "POST", "/v1/search", json={"query": "q"})

    assert response.status_code == 200
    assert response.json() == {
        "results": [
            {
                "rank": 1,
                "score": 0.87,
                "doc_id": "doc-1",
                "version": "3",
                "heading_path": ["인증서", "갱신"],
                "name": "IEEE 1609.2.1",
                "edition": {"label": "2025", "edition_date": "2025-01-31", "is_latest": True},
                "other_editions_in_results": True,
                "chunks": [
                    {
                        "chunk_id": "c-1",
                        "kind": "text",
                        "text": "갱신 절차 [[minerva:table:t1 | 표]]",
                        "placeholder_ids": ["t1"],
                        "split_index": 1,
                        "split_total": 2,
                    },
                    {
                        "chunk_id": "c-2",
                        "kind": "text",
                        "text": "두 번째 조각",
                        "placeholder_ids": [],
                        "split_index": 2,
                        "split_total": 2,
                    },
                ],
                "before": [
                    {
                        "chunk_id": "c-0",
                        "kind": "asset",
                        "text": "표 원문",
                        "placeholder_ids": ["t1"],
                        "split_index": None,
                        "split_total": None,
                    }
                ],
                "after": [
                    {
                        "chunk_id": "c-3",
                        "kind": "text",
                        "text": "뒤 청크",
                        "placeholder_ids": [],
                        "split_index": None,
                        "split_total": None,
                    }
                ],
            },
            {
                "rank": 2,
                "score": 0.5,
                "doc_id": "doc-2",
                "version": "1",
                "heading_path": [],
                "name": "판 없는 문서",
                "edition": None,
                "other_editions_in_results": False,
                "chunks": [
                    {
                        "chunk_id": "c-9",
                        "kind": "asset",
                        "text": "표 요약 문장",
                        "placeholder_ids": ["t2"],
                        "split_index": None,
                        "split_total": None,
                    }
                ],
                "before": [],
                "after": [],
            },
        ]
    }


@pytest.mark.req("REQ-RAG-9.1.1")
def test_search_no_results(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 결과가 없으면 빈 배열이다."""
    response = send(client, "POST", "/v1/search", json={"query": "q"})

    assert response.status_code == 200
    assert response.json() == {"results": []}


@pytest.mark.req("REQ-RAG-9.1.1")
@pytest.mark.parametrize(
    ("body", "case"),
    [
        pytest.param(
            {
                "query": "질의",
                "doc_id": "doc-1",
                "answer_span": "정답 구간",
                "edition_only": True,
                "top_n": 5,
            },
            EvaluationCase("질의", "doc-1", "정답 구간", True, 5),
            id="all-fields",
        ),
        pytest.param(
            {"query": "질의", "doc_id": "doc-1", "answer_span": "정답 구간"},
            EvaluationCase("질의", "doc-1", "정답 구간", False, None),
            id="required-only",
        ),
    ],
)
def test_evaluation_full_and_defaults(
    client: TestClient, fakes: FakeServices, body: dict[str, Any], case: EvaluationCase
) -> None:
    """[REQ-RAG-9.1.1] 평가 요청이 EvaluationCase로 옮겨지고 빠진 선택 필드는 기본값이다."""
    response = send(client, "POST", "/v1/evaluations", json=body)

    assert response.status_code == 200
    assert fakes.only_call("evaluation", "evaluate") == (case,)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_evaluation_result_shape(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 평가 결과가 n, base, expanded와 지표 일곱 키로 나온다."""
    fakes.evaluation.returns["evaluate"] = evaluation_result()

    response = send(
        client,
        "POST",
        "/v1/evaluations",
        json={"query": "질의", "doc_id": "doc-1", "answer_span": "정답 구간"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "n": 5,
        "base": {
            "hit_at_1": False,
            "hit_at_3": False,
            "hit_at_5": False,
            "hit_at_n": False,
            "rank": None,
            "reciprocal_rank": 0.0,
            "coverage": 0.25,
        },
        "expanded": {
            "hit_at_1": False,
            "hit_at_3": True,
            "hit_at_5": True,
            "hit_at_n": True,
            "rank": 2,
            "reciprocal_rank": 0.5,
            "coverage": 1.0,
        },
    }
