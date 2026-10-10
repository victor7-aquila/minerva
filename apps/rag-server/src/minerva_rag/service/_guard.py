"""서비스 파일들이 함께 쓰는 준비 상태 확인과 예외 로그다."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Protocol

import structlog

from minerva_rag.core import MinervaError, ServerNotReadyError


class Readiness(Protocol):
    """서비스가 요청을 받을 수 있는지 알려 준다. LifecycleService가 구현한다."""

    @property
    def ready(self) -> bool:
        """준비를 마쳤으면 참이다."""
        ...


@contextmanager
def guarded(
    logger: structlog.stdlib.BoundLogger, operation: str, readiness: Readiness
) -> Iterator[None]:
    """준비 상태를 확인하고, 본문의 예외를 규약대로 남긴 뒤 그대로 낸다."""
    try:
        if not readiness.ready:
            # ★ 아무 단위도 부르기 전에 막는다 (REQ-RAG-10.1.2)
            raise ServerNotReadyError()
        yield
    except MinervaError as exc:
        logger.warning(
            "service.failed", operation=operation, error_type=type(exc).__name__, code=exc.code
        )
        raise
    except Exception as exc:
        logger.exception("service.failed", operation=operation, error_type=type(exc).__name__)
        raise
