"""오류 응답 변환: 코드→상태 표, 오류 본문 생성, 전역 예외 처리기 (REQ-RAG-9.1.2, REQ-RAG-11.3)."""

from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from minerva_rag.core import InvalidRequestError, MinervaError, get_logger

log = get_logger(__name__)

# API.md 「오류 코드」 표 그대로다. ★ 표에 없는 코드는 500으로 본다
_STATUS_BY_CODE: dict[str, int] = {
    "INVALID_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "JOB_NOT_FOUND": 404,
    "PAYLOAD_TOO_LARGE": 413,
    "DOCUMENT_NOT_SEARCHABLE": 409,
    "INTERNAL_ERROR": 500,
    "VECTOR_DIMENSION_MISMATCH": 500,
    "CAPTION_FAILED": 502,
    "MODEL_UNAVAILABLE": 503,
    "STORE_UNAVAILABLE": 503,
    "SERVER_NOT_READY": 503,
    "SHUTTING_DOWN": 503,
}


def status_for(code: str) -> int:
    """오류 코드의 HTTP 상태를 돌려준다. 표에 없는 코드는 500이다."""
    return _STATUS_BY_CODE.get(code, 500)


def error_response(code: str, message: str) -> JSONResponse:
    """API.md 공통 오류 본문 `{"error": {"code", "message"}}` 응답을 만든다."""
    return JSONResponse(
        status_code=status_for(code),
        content={"error": {"code": code, "message": message}},
    )


def response_for(exc: MinervaError) -> JSONResponse:
    """MinervaError를 그 코드와 메시지의 오류 응답으로 바꾼다."""
    return error_response(exc.code, exc.message)


def invalid_request_response() -> JSONResponse:
    """기본 문구의 400 INVALID_REQUEST 응답을 만든다."""
    return response_for(InvalidRequestError())


def internal_error_response() -> JSONResponse:
    """기본 문구의 500 INTERNAL_ERROR 응답을 만든다. ★ 예외 문자열을 넣지 않는다."""
    return response_for(MinervaError())


def _field_names(errors: Sequence[Any]) -> list[str]:
    """검증 오류 위치에서 맨 앞 위치 표시(body·path·query)를 뺀 필드 이름 목록을 만든다."""
    names: list[str] = []
    for error in errors:
        loc: tuple[Any, ...] = tuple(error.get("loc", ()))
        # ★ 이름만 모은다. input·msg·ctx는 입력값이 담길 수 있어 읽지 않는다
        names.append(".".join(str(part) for part in loc[1:]))
    return names


async def _on_minerva_error(request: Request, exc: Exception) -> JSONResponse:
    """MinervaError를 코드에 맞는 상태의 오류 응답으로 바꾼다."""
    assert isinstance(exc, MinervaError)
    return response_for(exc)


async def _on_validation_error(request: Request, exc: Exception) -> JSONResponse:
    """요청 검증 오류를 400 INVALID_REQUEST로 바꾼다."""
    assert isinstance(exc, RequestValidationError)
    log.warning("api.request_invalid", path=request.url.path, fields=_field_names(exc.errors()))
    return invalid_request_response()


async def _on_http_exception(request: Request, exc: Exception) -> JSONResponse:
    """라우팅 404·405와 본문 해석 오류 같은 HTTP 예외도 400 INVALID_REQUEST로 바꾼다."""
    log.warning("api.request_invalid", path=request.url.path, fields=[])
    return invalid_request_response()


def register_error_handlers(app: FastAPI) -> None:
    """전역 예외 처리기를 등록한다. 라우트 함수에는 try/except를 두지 않는다."""
    app.add_exception_handler(MinervaError, _on_minerva_error)
    app.add_exception_handler(RequestValidationError, _on_validation_error)
    # ★ 라우터가 내는 404·405는 Starlette의 HTTPException이라 그 기반 클래스로 등록한다
    app.add_exception_handler(StarletteHTTPException, _on_http_exception)
