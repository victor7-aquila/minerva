"""오류(REQ-RAG-11.3.1, REQ-RAG-11.3.2) 단위 테스트."""

import re

import pytest

from minerva_rag.core import (
    CaptionFailedError,
    ChunkingFailedError,
    DocumentNotSearchableError,
    FailureLocation,
    GlossaryError,
    InvalidRequestError,
    JobFailureCode,
    JobNotFoundError,
    MinervaError,
    ModelLoadError,
    ModelUnavailableError,
    PayloadTooLargeError,
    PromptTooLongError,
    ServerNotReadyError,
    ShuttingDownError,
    StoreUnavailableError,
    UnauthorizedError,
    VectorDimensionMismatchError,
)

# 클래스 → 코드 (정본: MODULE.md 「예외」)
EXPECTED_CODES: dict[type[MinervaError], str] = {
    InvalidRequestError: "INVALID_REQUEST",
    UnauthorizedError: "UNAUTHORIZED",
    PayloadTooLargeError: "PAYLOAD_TOO_LARGE",
    JobNotFoundError: "JOB_NOT_FOUND",
    DocumentNotSearchableError: "DOCUMENT_NOT_SEARCHABLE",
    CaptionFailedError: "CAPTION_FAILED",
    ModelUnavailableError: "MODEL_UNAVAILABLE",
    PromptTooLongError: "INTERNAL_ERROR",
    GlossaryError: "INTERNAL_ERROR",
    ModelLoadError: "INTERNAL_ERROR",
    StoreUnavailableError: "STORE_UNAVAILABLE",
    VectorDimensionMismatchError: "VECTOR_DIMENSION_MISMATCH",
    ChunkingFailedError: "CHUNKING_FAILED",
    ServerNotReadyError: "SERVER_NOT_READY",
    ShuttingDownError: "SHUTTING_DOWN",
}

# API.md 「오류 코드」 12개
API_ERROR_CODES = {
    "INVALID_REQUEST",
    "UNAUTHORIZED",
    "JOB_NOT_FOUND",
    "PAYLOAD_TOO_LARGE",
    "DOCUMENT_NOT_SEARCHABLE",
    "INTERNAL_ERROR",
    "VECTOR_DIMENSION_MISMATCH",
    "CAPTION_FAILED",
    "MODEL_UNAVAILABLE",
    "STORE_UNAVAILABLE",
    "SERVER_NOT_READY",
    "SHUTTING_DOWN",
}

# API.md JobFailure 「작업 실패 사유 코드」 7개
JOB_FAILURE_CODES = {
    "CHUNKING_FAILED",
    "MODEL_UNAVAILABLE",
    "STORE_UNAVAILABLE",
    "VECTOR_DIMENSION_MISMATCH",
    "DOCUMENT_DELETED",
    "SERVER_RESTARTED",
    "INTERNAL_ERROR",
}

SUBCLASSES = list(EXPECTED_CODES)
FORBIDDEN_IN_MESSAGE = ["/", "\\", "Traceback"]


def _wrap(cls: type[MinervaError]) -> tuple[MinervaError, ValueError]:
    """다른 예외를 잡아 cls로 감싼 오류와 원래 예외를 돌려준다."""
    original = ValueError("C:\\data\\secret.py SELECT * FROM chunks WHERE q='SECRET-WRAP-8'")
    try:
        try:
            raise original
        except ValueError as e:
            raise cls() from e
    except MinervaError as err:
        return err, original
    raise AssertionError("오류가 나지 않았다")


@pytest.mark.req("REQ-RAG-11.3.1")
def test_exception_classes_complete() -> None:
    """[REQ-RAG-11.3.1] 「예외」 표의 클래스가 모두 존재하고 MinervaError의 하위 클래스다."""
    for cls in SUBCLASSES:
        assert issubclass(cls, MinervaError)
        assert issubclass(cls, Exception)


@pytest.mark.req("REQ-RAG-11.3.1")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_exception_code(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.1] 클래스마다 코드가 표와 같다."""
    assert cls.code == EXPECTED_CODES[cls]


@pytest.mark.req("REQ-RAG-11.3.1")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_code_in_api_spec(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.1] code는 비지 않은 문자열이고 API 오류 코드 또는 JobFailureCode에 있다."""
    allowed = API_ERROR_CODES | {m.value for m in JobFailureCode}
    assert isinstance(cls.code, str)
    assert cls.code != ""
    assert cls.code in allowed


@pytest.mark.req("REQ-RAG-11.3.1")
def test_chunking_failed_code_is_job_failure() -> None:
    """[REQ-RAG-11.3.1] ChunkingFailedError의 코드는 작업 실패 사유 코드다."""
    assert ChunkingFailedError.code in {m.value for m in JobFailureCode}


@pytest.mark.req("REQ-RAG-11.3.1")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_default_message_korean(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.1] default_message는 비지 않았고 한글을 포함한다."""
    assert cls.default_message != ""
    assert re.search(r"[가-힣]", cls.default_message)


@pytest.mark.req("REQ-RAG-11.3.1")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_message_defaults(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.1] message를 넘기지 않으면 default_message를 쓴다."""
    assert cls().message == cls.default_message
    assert str(cls()) == cls.default_message


@pytest.mark.req("REQ-RAG-11.3.1")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_message_override(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.1] message를 넘기면 그 문자열이 message와 str에 쓰인다."""
    text = "임베딩 모델 bge를 불러오지 못했습니다"
    assert cls(text).message == text
    assert str(cls(text)) == text


@pytest.mark.req("REQ-RAG-11.3.1")
def test_job_failure_codes() -> None:
    """[REQ-RAG-11.3.1] JobFailureCode는 API.md 7개 코드와 같고 이름과 값이 같은 StrEnum이다."""
    assert {m.value for m in JobFailureCode} == JOB_FAILURE_CODES
    assert all(m.value == m.name for m in JobFailureCode)
    assert isinstance(JobFailureCode.CHUNKING_FAILED, str)
    assert JobFailureCode("INTERNAL_ERROR") is JobFailureCode.INTERNAL_ERROR


@pytest.mark.req("REQ-RAG-11.3.1")
def test_chunking_failed_location() -> None:
    """[REQ-RAG-11.3.1] ChunkingFailedError는 실패 위치를 message와 따로 보존한다."""
    assert ChunkingFailedError().location is None
    loc = FailureLocation(heading_path=("설치", "Docker"), placeholder_id="t1")
    by_default = ChunkingFailedError(location=loc)
    assert by_default.location == loc
    assert by_default.message == ChunkingFailedError.default_message
    both = ChunkingFailedError("분할 응답을 해석하지 못했습니다", location=loc)
    assert both.message == "분할 응답을 해석하지 못했습니다"
    assert both.location == loc


@pytest.mark.req("REQ-RAG-11.3.1")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_raise_and_catch_as_base(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.1] 모든 하위 클래스는 MinervaError로 잡히고 code를 읽을 수 있다."""
    with pytest.raises(MinervaError) as info:
        raise cls()
    assert info.value.code == EXPECTED_CODES[cls]


@pytest.mark.req("REQ-RAG-11.3.2")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_default_message_no_internal_detail(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.2] default_message에 경로·트레이스백·SQL 같은 내부 표현이 없다."""
    message = cls.default_message
    for token in FORBIDDEN_IN_MESSAGE:
        assert token not in message
    assert "select" not in message.lower()


@pytest.mark.req("REQ-RAG-11.3.2")
@pytest.mark.parametrize("cls", SUBCLASSES)
def test_wrapped_exception_text_hidden(cls: type[MinervaError]) -> None:
    """[REQ-RAG-11.3.2] 다른 예외를 감싸도 그 문자열이 message에 들어가지 않는다."""
    err, original = _wrap(cls)
    assert original.args  # 원래 예외에는 비밀 문자열이 들어 있다
    for text in (err.message, str(err)):
        assert "SECRET-WRAP-8" not in text
        assert "SELECT" not in text
        assert "secret.py" not in text
    assert err.message == cls.default_message


@pytest.mark.req("REQ-RAG-11.3.2")
def test_wrapped_with_location_hidden() -> None:
    """[REQ-RAG-11.3.2] 위치를 가진 ChunkingFailedError도 감싼 예외 문자열을 담지 않는다."""
    original = ValueError("C:\\data\\secret.py SELECT * FROM chunks WHERE q='SECRET-WRAP-8'")
    try:
        try:
            raise original
        except ValueError as e:
            raise ChunkingFailedError(location=FailureLocation(("설치",), None)) from e
    except ChunkingFailedError as err:
        assert "SECRET-WRAP-8" not in err.message
        assert "SELECT" not in err.message
        assert "secret.py" not in str(err)
        assert err.message == ChunkingFailedError.default_message
