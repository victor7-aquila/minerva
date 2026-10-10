"""api 단위 테스트의 공통 픽스처."""

import contextlib
import os
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

from minerva_rag.api import create_app
from minerva_rag.core import Settings, get_settings

from .fakes import TOKEN, ExitCall, FakeServices

# 필수 키 5개의 테스트용 값이다. 호스트 `*.test`는 실제로 연결되지 않는다
REQUIRED_ENV = {
    "RAG_QDRANT_URL": "http://qdrant.test:6333",
    "RAG_OLLAMA_URL": "http://ollama.test:11434",
    "RAG_BACKEND_EVENTS_URL": "http://backend.test/v1/internal/rag-events",
    "RAG_BACKEND_EVENTS_TOKEN": "events-token-for-test",
    "RAG_API_TOKEN": TOKEN,
}


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """RAG_ 환경 변수와 .env가 끼어들지 않게 하고 필수 키를 채운다."""
    for key in [k for k in os.environ if k.upper().startswith("RAG_")]:
        monkeypatch.delenv(key)
    # ★ apps/rag-server/.env가 있어도 읽지 않는다
    model_config = cast(dict[str, Any], Settings.model_config)
    monkeypatch.setitem(model_config, "env_file", None)
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def exit_calls(monkeypatch: pytest.MonkeyPatch) -> list[ExitCall]:
    """프로세스를 끝내는 모든 경로를 기록만 하는 가짜로 바꾼다.

    ★ 안전장치다. 이 픽스처가 없으면 기동 실패 테스트가 pytest 프로세스를 끝낸다.
    구현이 어느 경로로 끝내든 pytest가 끝나지 않게 세 겹으로 막는다.
    1. `minerva_rag.api.app._exit_process` (IMPL_PLAN이 고정한 이름, 없어도 오류 없이 넘어간다)
    2. `os._exit` (구현이 종료 함수를 거치지 않고 직접 부를 때)
    3. `sys.exit` (같은 이유)
    ★ 이 모듈이 import되기 전에 함수 참조를 붙잡아 둔 구현(`from os import _exit`)은 막지 못한다.
    """
    calls: list[ExitCall] = []

    def _make(via: str) -> Callable[..., None]:
        def _recorder(*args: Any, **kwargs: Any) -> None:
            calls.append(ExitCall(via, args, kwargs))

        return _recorder

    monkeypatch.setattr(os, "_exit", _make("os._exit"))
    monkeypatch.setattr(sys, "exit", _make("sys.exit"))
    # 모듈 이름이 달라도 위의 두 겹이 막는다
    with contextlib.suppress(ModuleNotFoundError):
        monkeypatch.setattr(
            "minerva_rag.api.app._exit_process", _make("_exit_process"), raising=False
        )
    return calls


@pytest.fixture
def set_limits(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    """색인 markdown·캡션 image의 크기 한도를 바꾸는 함수를 돌려준다.

    ★ 앱을 만들기 전에 불러야 한다. 앱이 만들어질 때 설정을 읽는다.
    """

    def _set(markdown: int | None = None, image: int | None = None) -> None:
        if markdown is not None:
            monkeypatch.setenv("RAG_MAX_MARKDOWN_BYTES", str(markdown))
        if image is not None:
            monkeypatch.setenv("RAG_MAX_IMAGE_BYTES", str(image))
        get_settings.cache_clear()

    return _set


@pytest.fixture
def fakes() -> FakeServices:
    """새 가짜 서비스 묶음이다."""
    return FakeServices()


@pytest.fixture
def make_client(fakes: FakeServices) -> Callable[[], TestClient]:
    """지금의 설정으로 앱을 만들고 lifespan 없는 테스트 클라이언트를 돌려주는 함수다."""

    def _make() -> TestClient:
        return TestClient(create_app(fakes.services), raise_server_exceptions=False)

    return _make


@pytest.fixture
def client(make_client: Callable[[], TestClient]) -> TestClient:
    """lifespan 없이(`with`를 쓰지 않고) 요청을 보내는 테스트 클라이언트다."""
    return make_client()
