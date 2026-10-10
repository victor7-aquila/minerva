"""evaluation 단위 테스트의 공통 픽스처."""

import os
from collections.abc import Callable, Iterator
from typing import Any, cast

import pytest

from minerva_rag.core import Settings, get_settings

# 필수 키 5개의 테스트용 값이다. 호스트 `*.test`는 실제로 연결되지 않는다
REQUIRED_ENV = {
    "RAG_QDRANT_URL": "http://qdrant.test:6333",
    "RAG_OLLAMA_URL": "http://ollama.test:11434",
    "RAG_BACKEND_EVENTS_URL": "http://backend.test/v1/internal/rag-events",
    "RAG_BACKEND_EVENTS_TOKEN": "events-token-for-test",
    "RAG_API_TOKEN": "api-token-for-test",
}


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
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


@pytest.fixture
def settings() -> Settings:
    """격리된 환경의 기본 설정을 돌려준다."""
    return get_settings()


@pytest.fixture
def make_settings(monkeypatch: pytest.MonkeyPatch) -> Callable[..., Settings]:
    """기본 N을 바꾼 설정을 만드는 함수를 돌려준다."""

    def _make(top_n: int | None = None) -> Settings:
        # ★ 설정 클래스를 직접 만들지 않고 환경 변수와 get_settings()로 얻는다
        if top_n is not None:
            monkeypatch.setenv("RAG_SEARCH_DEFAULT_TOP_N", str(top_n))
        get_settings.cache_clear()
        return get_settings()

    return _make
