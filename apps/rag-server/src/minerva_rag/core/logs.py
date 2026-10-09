"""structlog 구성과 금지 키 제거 처리기 (REQ-RAG-11.2)."""

import logging
import sys
from typing import Any, cast

import structlog
from structlog.typing import EventDict, Processor, WrappedLogger

# ★ 문서 본문·청크 텍스트·질의 원문과 자격 증명은 로그에 남기지 않는다 (AGENTS.md 「보안과 로그」)
_FORBIDDEN_KEYS = frozenset(
    {
        "markdown",
        "text",
        "query",
        "answer_span",
        "table_markdown",
        "summary",
        "caption",
        "title",
        "token",
        "authorization",
    }
)
_REMOVED = "[removed]"


def _is_forbidden(key: object) -> bool:
    """키가 금지 키인지 대소문자 구분 없이 판정한다."""
    return isinstance(key, str) and key.lower() in _FORBIDDEN_KEYS


def _redact_value(value: Any) -> Any:
    """dict·list·tuple 안의 금지 키 값을 지운 새 객체를 돌려준다. 원본은 바꾸지 않는다."""
    if isinstance(value, dict):
        source = cast(dict[Any, Any], value)
        return {
            key: _REMOVED if _is_forbidden(key) else _redact_value(item)
            for key, item in source.items()
        }
    if isinstance(value, (list, tuple)):
        items = cast(list[Any] | tuple[Any, ...], value)
        return type(items)(_redact_value(item) for item in items)
    return value


def _redact_forbidden_keys(
    logger: WrappedLogger, method_name: str, event_dict: EventDict
) -> EventDict:
    """금지 키의 값을 "[removed]"로 바꾼다."""
    return {
        key: _REMOVED if _is_forbidden(key) else _redact_value(value)
        for key, value in event_dict.items()
    }


_SHARED_PROCESSORS: list[Processor] = [
    structlog.contextvars.merge_contextvars,
    structlog.stdlib.add_log_level,
    structlog.stdlib.add_logger_name,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
]


def configure_logging() -> None:
    """structlog를 JSON 출력과 금지 키 제거 처리기로 구성한다."""
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            *_SHARED_PROCESSORS,
            structlog.processors.StackInfoRenderer(),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        # ★ 모듈 맨 위 로거가 구성 전에 만들어져도 나중 구성을 따르게 한다
        cache_logger_on_first_use=False,
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=_SHARED_PROCESSORS,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            # ★ 렌더러 바로 앞 — 이 뒤에 값을 더하는 처리기를 두지 않는다
            _redact_forbidden_keys,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ],
    )
    handler = logging.StreamHandler(sys.stdout)  # ★ 호출 시점의 sys.stdout에 붙인다
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers = [handler]  # ★ 여러 번 불러도 처리기가 겹치지 않게 바꿔 끼운다
    root.setLevel(logging.INFO)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """모듈 이름으로 구조화 로거를 돌려준다."""
    return cast(structlog.stdlib.BoundLogger, structlog.stdlib.get_logger(name))
