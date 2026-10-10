"""service 단위 테스트의 공통 픽스처."""

import asyncio
import os
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, cast

import httpx
import pytest

from minerva_rag.core import Settings, get_settings

from .fakes import FakeReceiver, SleepRecorder

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
    """RAG_ 환경 변수와 .env가 끼어들지 않게 하고 필수 키·임시 작업 DB·빈 용어집을 채운다."""
    for key in [k for k in os.environ if k.upper().startswith("RAG_")]:
        monkeypatch.delenv(key)
    # ★ apps/rag-server/.env가 있어도 읽지 않는다
    model_config = cast(dict[str, Any], Settings.model_config)
    monkeypatch.setitem(model_config, "env_file", None)
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    # ★ 작업 DB는 아직 없는 폴더 안의 임시 파일이다 — 폴더는 `start`가 만든다
    monkeypatch.setenv("RAG_JOBS_DB_PATH", str(tmp_path / "data" / "jobs.sqlite3"))
    glossary = tmp_path / "glossary.yaml"
    glossary.write_text("terms: []\n", encoding="utf-8")
    monkeypatch.setenv("RAG_GLOSSARY_PATH", str(glossary))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def receiver(monkeypatch: pytest.MonkeyPatch) -> FakeReceiver:
    """Backend 알림 수신자를 가짜로 바꾼다. 실제 네트워크가 나가지 않는다."""
    fake = FakeReceiver()

    # ★ 라이브러리 수준에서 가로챈다 — 구현이 클라이언트를 어떻게 만들든 요청은 가짜 수신자로 간다
    async def _handle(
        _transport: httpx.AsyncHTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        return await fake.handler(request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _handle)
    return fake


@pytest.fixture(autouse=True)
def sleeps(monkeypatch: pytest.MonkeyPatch) -> SleepRecorder:
    """`asyncio.sleep`을 기록만 하는 가짜로 바꾼다. 재전송 대기를 실제로 기다리지 않는다."""
    recorder = SleepRecorder()
    monkeypatch.setattr(asyncio, "sleep", recorder)
    return recorder


@pytest.fixture
def settings() -> Settings:
    """격리된 환경의 기본 설정을 돌려준다."""
    return get_settings()


@pytest.fixture
def make_settings(monkeypatch: pytest.MonkeyPatch) -> Callable[..., Settings]:
    """동시 실행 수·재시도 횟수·종료 대기 시간을 바꾼 설정을 만드는 함수를 돌려준다."""

    def _make(
        *,
        concurrency: int | None = None,
        retries: int | None = None,
        shutdown_timeout: float | None = None,
    ) -> Settings:
        # ★ 설정 클래스를 직접 만들지 않고 환경 변수와 get_settings()로 얻는다
        if concurrency is not None:
            monkeypatch.setenv("RAG_JOB_CONCURRENCY", str(concurrency))
        if retries is not None:
            monkeypatch.setenv("RAG_NOTIFY_RETRIES", str(retries))
        if shutdown_timeout is not None:
            monkeypatch.setenv("RAG_SHUTDOWN_TIMEOUT_SECONDS", str(shutdown_timeout))
        get_settings.cache_clear()
        return get_settings()

    return _make
