"""core 단위 테스트의 공통 픽스처."""

import logging
import os
from collections.abc import Iterator
from typing import Any, cast

import pytest
import structlog

from minerva_rag.core import Settings, get_settings

# 필수 키 5개의 테스트용 값이다
REQUIRED_ENV = {
    "RAG_QDRANT_URL": "http://localhost:6333",
    "RAG_OLLAMA_URL": "http://localhost:11434",
    "RAG_BACKEND_EVENTS_URL": "http://localhost:3000/v1/internal/rag-events",
    "RAG_BACKEND_EVENTS_TOKEN": "events-token-for-test",
    "RAG_API_TOKEN": "api-token-for-test",
}


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """개발자 셸의 RAG_ 환경 변수와 앱 폴더의 .env가 테스트에 끼어들지 않게 한다."""
    # ★ 대소문자를 가리지 않고 RAG_로 시작하는 키를 모두 지운다
    for key in [k for k in os.environ if k.upper().startswith("RAG_")]:
        monkeypatch.delenv(key)
    # ★ apps/rag-server/.env가 있어도 읽지 않는다
    model_config = cast(dict[str, Any], Settings.model_config)
    monkeypatch.setitem(model_config, "env_file", None)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def required_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """필수 키 5개를 환경 변수로 채우고 그 값을 돌려준다."""
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    return dict(REQUIRED_ENV)


@pytest.fixture
def restore_logging() -> Iterator[None]:
    """루트 로거 상태와 structlog 구성을 테스트 뒤에 되돌린다."""
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    yield
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)
    structlog.reset_defaults()
