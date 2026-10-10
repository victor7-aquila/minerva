"""순수 ASGI 미들웨어: 토큰 검사, Content-Length 사전 검사, 처리하지 못한 예외 경계.

★ 토큰·크기 검사는 본문을 읽기 전에 해야 한다. FastAPI 의존성(`Depends`)은 본문을 먼저 읽고
JSON을 해석하므로 쓰지 않고, `BaseHTTPMiddleware`도 쓰지 않는다 (REQ-RAG-9.3.1, REQ-RAG-9.1.3).
"""

import hmac

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from minerva_rag.core import PayloadTooLargeError, UnauthorizedError, get_logger

from .errors import internal_error_response, response_for

log = get_logger(__name__)

_TOKEN_HEADER = b"x-minerva-token"
_MULTIPART_ALLOWANCE = 1024 * 1024  # 색인·이미지 본문의 포장(머리말) 여유 1MiB
# ★ JSON 이스케이프 최악: 짧은 이스케이프가 없는 제어 문자(U+0000~U+001F)는
#   1바이트가 6바이트(\u00XX)가 된다.
#   그래서 본문은 markdown의 UTF-8 바이트보다 최대 6배 커질 수 있다 (비ASCII 이스케이프는 최대 3배)
_ESCAPE_FACTOR = 6
_HEALTH = ("GET", "/v1/health")


class _BodyTooLargeError(BaseException):
    """chunked 본문이 문턱값을 넘었을 때 읽기를 중단시키는 신호다.

    ★ BaseException이다. FastAPI의 본문 해석이 `except Exception`으로 모든 오류를
      400으로 바꾸므로, Exception이면 이 신호가 400으로 새어 나간다.
    """

    def __init__(self, size: int) -> None:
        """지금까지 읽은 바이트 수를 받는다."""
        super().__init__(size)
        self.size = size


def _header(scope: Scope, name: bytes) -> bytes | None:
    """요청 헤더의 첫 값을 바이트로 돌려준다. 없으면 None이다."""
    for key, value in scope["headers"]:
        if key.lower() == name:
            return value
    return None


def _content_length(scope: Scope) -> int | None:
    """Content-Length를 정수로 돌려준다. 없거나 숫자가 아니면 None이다."""
    raw = _header(scope, b"content-length")
    if raw is None or not raw.isdigit():
        return None
    return int(raw)


class GuardMiddleware:
    """가장 바깥에서 토큰·본문 크기를 검사하고 처리하지 못한 예외를 500으로 바꾼다."""

    def __init__(self, app: ASGIApp, token: str, max_markdown_bytes: int, max_image_bytes: int):
        """다음 앱과 검사에 쓸 토큰·한도를 받는다. 한도는 설정에서 한 번 읽어 넘긴다."""
        self._app = app
        self._token = token.encode("utf-8")
        # ★ 문턱값은 필드 한도(라우트가 정확히 검사한다)보다 넉넉해야
        #   한도와 같은 요청이 사전 검사에 걸리지 않는다 (G6)
        self._thresholds: dict[tuple[str, str], int] = {
            ("POST", "/v1/index-jobs"): _ESCAPE_FACTOR * max_markdown_bytes + _MULTIPART_ALLOWANCE,
            ("POST", "/v1/captions/image"): max_image_bytes + _MULTIPART_ALLOWANCE,
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """HTTP 요청마다 검사 순서(토큰 → Content-Length)를 지키고 나머지는 다음 앱에 넘긴다."""
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        path: str = scope["path"]
        key = (scope["method"], path)

        if key != _HEALTH and not self._token_ok(scope):
            return await self._reject_unauthorized(scope, receive, send, path)

        threshold = self._thresholds.get(key)
        length = _content_length(scope)
        if threshold is not None and length is not None and length > threshold:
            return await self._reject_too_large(scope, receive, send, path, length, threshold)

        # chunked(Content-Length 없음)면 문턱값까지만 읽는다
        counted = threshold is not None and length is None
        await self._run(scope, receive, send, path, threshold if counted else None)

    def _token_ok(self, scope: Scope) -> bool:
        """X-Minerva-Token이 설정한 토큰과 같은지 시간이 일정한 비교로 본다."""
        presented = _header(scope, _TOKEN_HEADER)
        return presented is not None and hmac.compare_digest(presented, self._token)

    async def _reject_unauthorized(
        self, scope: Scope, receive: Receive, send: Send, path: str
    ) -> None:
        """401 UNAUTHORIZED로 거부한다. 토큰 값은 로그·응답에 넣지 않는다."""
        present = _header(scope, _TOKEN_HEADER) is not None
        log.warning("api.unauthorized", path=path, token_present=present)
        await response_for(UnauthorizedError())(scope, receive, send)

    async def _reject_too_large(
        self, scope: Scope, receive: Receive, send: Send, path: str, size: int, limit: int
    ) -> None:
        """413 PAYLOAD_TOO_LARGE로 거부한다."""
        log.warning("api.payload_too_large", path=path, bytes=size, limit=limit)
        await response_for(PayloadTooLargeError())(scope, receive, send)

    async def _run(
        self, scope: Scope, receive: Receive, send: Send, path: str, read_limit: int | None
    ) -> None:
        """다음 앱을 실행한다. 읽기 상한 초과와 처리하지 못한 예외는 응답으로 바꾼다."""
        started = False
        read = 0

        async def guarded_receive() -> Message:
            nonlocal read
            message = await receive()
            if read_limit is not None and message["type"] == "http.request":
                read += len(message.get("body", b""))
                if read > read_limit:
                    raise _BodyTooLargeError(read)
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self._app(scope, guarded_receive, tracking_send)
        except _BodyTooLargeError as signal:
            if started:
                raise
            await self._reject_too_large(scope, receive, send, path, signal.size, read_limit or 0)
        except Exception as exc:
            # ★ 예외 문자열은 응답에도 로그 필드에도 넣지 않는다. 스택은 로그에만 남는다
            log.exception("api.unhandled", path=path, error_type=type(exc).__name__)
            if started:
                raise
            await internal_error_response()(scope, receive, send)
