"""FastAPI 앱 팩토리와 수명주기 연결 (REQ-RAG-9.1, REQ-RAG-10.1, REQ-RAG-12.1.1)."""

import asyncio
import contextlib
import os
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI

from minerva_rag.core import configure_logging, get_logger, get_settings
from minerva_rag.service import LifecycleService, Services, build_services

from .errors import register_error_handlers
from .guard import GuardMiddleware
from .routes import register_routes

log = get_logger(__name__)


def _exit_process(code: int) -> None:
    """로그를 내보낸 뒤 프로세스를 즉시 끝낸다."""
    # ★ os._exit는 stdio 버퍼를 비우지 않으므로 먼저 flush한다
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.flush()
    os._exit(code)


async def _run_startup(lifecycle: LifecycleService) -> None:
    """기동을 실행한다. 실패하면 오류를 남기고 프로세스를 끝낸다."""
    try:
        await lifecycle.startup()
    except Exception as exc:  # ★ CancelledError(BaseException)는 기동 실패가 아니라 잡지 않는다
        log.error("api.startup_failed", error_type=type(exc).__name__)
        _exit_process(1)  # ★ 모듈 전역 이름으로 부른다 (테스트가 바꿔 끼운다)


def _make_lifespan(
    lifecycle: LifecycleService,
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    """service의 기동·종료를 FastAPI 수명주기에 연결하는 lifespan을 만든다."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """시작하면 기동을 백그라운드로 돌리고, 끝나면 shutdown을 기다린다."""
        # ★ 참조를 들고 있어야 태스크가 GC로 사라지지 않는다
        startup = asyncio.create_task(_run_startup(lifecycle))
        try:
            yield
        finally:
            # 기동이 끝나지 않았으면 취소하고 끝나기를 기다린 뒤 종료한다
            if not startup.done():
                startup.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await startup
            await lifecycle.shutdown()

    return lifespan


def create_app(services: Services | None = None) -> FastAPI:
    """FastAPI 앱을 만든다. services를 주지 않으면 설정으로 조립한다."""
    settings = get_settings()
    # ★ 로그 구성은 여기서만 한다. lifespan에서 다시 구성하면 테스트의 로그 수집이 깨진다
    configure_logging()
    # ★ 호출할 때 모듈 전역 이름으로 찾는다 (테스트가 바꿔 끼운다)
    services = services if services is not None else build_services(settings)

    app = FastAPI(
        lifespan=_make_lifespan(services.lifecycle),
        # API.md에 없는 문서 엔드포인트와 슬래시 리디렉션(307)은 만들지 않는다
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    register_error_handlers(app)
    register_routes(app, services, settings)
    # ★ 미들웨어는 마지막에 등록한다 — 토큰·크기 검사가 본문을 읽기 전에 돌아야 한다
    app.add_middleware(
        GuardMiddleware,
        token=settings.api_token.get_secret_value(),
        max_markdown_bytes=settings.max_markdown_bytes,
        max_image_bytes=settings.max_image_bytes,
    )
    return app
