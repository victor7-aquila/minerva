"""resource 단위 테스트의 공통 픽스처."""

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest

from minerva_rag.core import Settings, get_settings

from .fakes import FakeModels, FakeOllama, install_fake_models, install_fake_ollama

# 필수 키 5개의 테스트용 값이다. 호스트 `*.test`는 실제로 연결되지 않는다
REQUIRED_ENV = {
    "RAG_QDRANT_URL": "http://qdrant.test:6333",
    "RAG_OLLAMA_URL": "http://ollama.test:11434",
    "RAG_BACKEND_EVENTS_URL": "http://backend.test/v1/internal/rag-events",
    "RAG_BACKEND_EVENTS_TOKEN": "events-token-for-test",
    "RAG_API_TOKEN": "api-token-for-test",
}


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """개발자 셸의 RAG_ 환경 변수와 .env가 끼어들지 않게 하고 필수 키를 채운다."""
    for key in [k for k in os.environ if k.upper().startswith("RAG_")]:
        monkeypatch.delenv(key)
    # ★ apps/rag-server/.env가 있어도 읽지 않는다
    model_config = cast(dict[str, Any], Settings.model_config)
    monkeypatch.setitem(model_config, "env_file", None)
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    # ★ prepare가 모델 폴더를 만들 수 있으므로 저장소의 data/를 건드리지 않게 한다
    monkeypatch.setenv("RAG_MODELS_DIR", str(tmp_path / "models"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def settings() -> Settings:
    """격리된 환경의 설정을 돌려준다."""
    return get_settings()


@pytest.fixture
def fake_ollama(monkeypatch: pytest.MonkeyPatch) -> FakeOllama:
    """기본 모델 두 개를 가진 가짜 Ollama를 Ollama 클라이언트 팩토리에 끼운다."""
    fake = FakeOllama(models={"qwen3:14b", "qwen3-vl:8b"}, mode="ok", response_text="응답")
    install_fake_ollama(monkeypatch, fake)
    return fake


@pytest.fixture
def fake_models(monkeypatch: pytest.MonkeyPatch) -> FakeModels:
    """임베딩·재정렬 가짜를 로더에 끼운다."""
    models = FakeModels()
    install_fake_models(monkeypatch, models)
    return models
