"""api 공개 표면 고정(REQ-RAG-9.1.1) 테스트. contract 검사 도구가 없어 이 테스트가 대신한다."""

import inspect
import typing

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute

import minerva_rag.api as api
from minerva_rag.api import create_app
from minerva_rag.core import get_settings
from minerva_rag.service import Services

from .fakes import FakeServices

# API.md 「엔드포인트 목록」의 12개다
_API_MD_ROUTES = {
    ("POST", "/v1/captions/table"),
    ("POST", "/v1/captions/image"),
    ("POST", "/v1/index-jobs"),
    ("GET", "/v1/index-jobs/{job_id}"),
    ("DELETE", "/v1/documents/{doc_id}"),
    ("GET", "/v1/documents/{doc_id}/index-state"),
    ("POST", "/v1/documents/index-states"),
    ("PUT", "/v1/documents/{doc_id}/metadata"),
    ("GET", "/v1/documents/{doc_id}/chunks"),
    ("POST", "/v1/search"),
    ("POST", "/v1/evaluations"),
    ("GET", "/v1/health"),
}


@pytest.mark.req("REQ-RAG-9.1.1")
def test_create_app_exported() -> None:
    """[REQ-RAG-9.1.1] minerva_rag.api가 create_app만 내보낸다 (실행 계약)."""
    assert api.__all__ == ["create_app"]
    assert callable(api.create_app)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_create_app_signature() -> None:
    """[REQ-RAG-9.1.1] create_app(services: Services | None = None) -> FastAPI 시그니처다."""
    params = inspect.signature(create_app).parameters
    hints = typing.get_type_hints(create_app)

    assert list(params) == ["services"]
    assert params["services"].default is None
    assert hints["services"] == (Services | None)
    assert hints["return"] is FastAPI


@pytest.mark.req("REQ-RAG-9.1.1")
def test_create_app_returns_fastapi(fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] create_app은 FastAPI 인스턴스를 돌려준다."""
    assert isinstance(create_app(fakes.services), FastAPI)


@pytest.mark.req("REQ-RAG-9.1.1")
def test_api_md_routes_registered(fakes: FakeServices) -> None:
    """[REQ-RAG-9.1.1] 앱 라우트가 API.md의 12개 (메서드, 경로)를 모두 포함한다."""
    app = create_app(fakes.services)

    registered = {
        (method, route.path)
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in (route.methods or ())
    }
    assert registered >= _API_MD_ROUTES


@pytest.mark.req("REQ-RAG-9.1.1")
def test_create_app_builds_services_from_settings(
    monkeypatch: pytest.MonkeyPatch, fakes: FakeServices
) -> None:
    """[REQ-RAG-9.1.1] services를 주지 않으면 get_settings()로 build_services를 한 번 부른다."""
    calls: list[object] = []

    def _recorder(settings: object) -> Services:
        calls.append(settings)
        return fakes.services

    monkeypatch.setattr("minerva_rag.api.app.build_services", _recorder)

    create_app(fakes.services)
    assert calls == []

    create_app()
    assert len(calls) == 1
    assert calls[0] is get_settings()
