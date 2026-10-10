"""경계 밖으로 나가는 오류와 작업 실패 사유 코드를 정의한다 (REQ-RAG-11.3)."""

from enum import StrEnum
from typing import ClassVar

from .shared import FailureLocation


class MinervaError(Exception):
    """경계 밖으로 나가는 오류의 기반이다."""

    # ★ 다른 예외를 감쌀 때는 `raise XxxError() from exc`로 쓰고 str(exc)를 message에 넣지 않는다.
    #   생성자는 원인 예외를 받지 않는다 — 내부 정보가 응답 메시지로 새지 않게 하기 위해서다
    code: ClassVar[str] = "INTERNAL_ERROR"
    default_message: ClassVar[str] = "서버 내부 오류가 발생했습니다"

    def __init__(self, message: str | None = None) -> None:
        """메시지를 정한다. 주지 않으면 기본 메시지를 쓴다."""
        self._message = message if message else type(self).default_message
        super().__init__(self._message)

    @property
    def message(self) -> str:
        """오류 메시지를 돌려준다."""
        return self._message


class InvalidRequestError(MinervaError):
    """요청 내용이 계약에 맞지 않을 때 낸다."""

    code: ClassVar[str] = "INVALID_REQUEST"
    default_message: ClassVar[str] = "요청 형식이 잘못되었습니다"


class UnauthorizedError(MinervaError):
    """API 토큰이 없거나 다를 때 낸다."""

    code: ClassVar[str] = "UNAUTHORIZED"
    default_message: ClassVar[str] = "API 토큰이 없거나 올바르지 않습니다"


class PayloadTooLargeError(MinervaError):
    """요청이 크기 한도를 넘을 때 낸다."""

    code: ClassVar[str] = "PAYLOAD_TOO_LARGE"
    default_message: ClassVar[str] = "요청이 허용된 크기 한도를 넘었습니다"


class JobNotFoundError(MinervaError):
    """그 ID의 작업이 없을 때 낸다."""

    code: ClassVar[str] = "JOB_NOT_FOUND"
    default_message: ClassVar[str] = "해당 ID의 작업이 없습니다"


class DocumentNotSearchableError(MinervaError):
    """정답 문서가 검색되지 않을 때 낸다."""

    code: ClassVar[str] = "DOCUMENT_NOT_SEARCHABLE"
    default_message: ClassVar[str] = "정답 문서가 검색되지 않는 상태라 평가할 수 없습니다"


class CaptionFailedError(MinervaError):
    """요약·캡션을 만들지 못했을 때 낸다."""

    code: ClassVar[str] = "CAPTION_FAILED"
    default_message: ClassVar[str] = "요약·캡션을 만들지 못했습니다"


class ModelUnavailableError(MinervaError):
    """모델 서버에 연결할 수 없을 때 낸다."""

    code: ClassVar[str] = "MODEL_UNAVAILABLE"
    default_message: ClassVar[str] = "모델 서버에 연결할 수 없습니다"


class PromptTooLongError(MinervaError):
    """생성 입력이 컨텍스트에서 출력 몫을 뺀 크기를 넘을 때 낸다. 경계 밖으로 나가지 않는다."""

    code: ClassVar[str] = "INTERNAL_ERROR"
    default_message: ClassVar[str] = "생성 입력이 모델이 처리할 수 있는 크기를 넘었습니다"


class GlossaryError(MinervaError):
    """용어집 파일이 형식에 맞지 않을 때 낸다. 경계 밖으로 나가지 않는다."""

    code: ClassVar[str] = "INTERNAL_ERROR"
    default_message: ClassVar[str] = "용어집 파일의 형식이 올바르지 않습니다"


class ModelLoadError(MinervaError):
    """설정한 모델을 불러오지 못했을 때 낸다. 경계 밖으로 나가지 않는다."""

    code: ClassVar[str] = "INTERNAL_ERROR"
    default_message: ClassVar[str] = "설정한 모델을 불러오지 못했습니다"


class StoreUnavailableError(MinervaError):
    """Qdrant에 연결할 수 없을 때 낸다."""

    code: ClassVar[str] = "STORE_UNAVAILABLE"
    default_message: ClassVar[str] = "검색 저장소에 연결할 수 없습니다"


class VectorDimensionMismatchError(MinervaError):
    """저장된 벡터 차원이 임베딩 모델과 다를 때 낸다."""

    code: ClassVar[str] = "VECTOR_DIMENSION_MISMATCH"
    default_message: ClassVar[str] = (
        "저장된 벡터의 차원이 임베딩 모델과 다릅니다. 다시 색인해야 합니다"
    )


class ChunkingFailedError(MinervaError):
    """청킹을 끝내지 못했다. 실패 위치를 가질 수 있다."""

    code: ClassVar[str] = "CHUNKING_FAILED"
    default_message: ClassVar[str] = "문서를 청크로 나누지 못했습니다"

    def __init__(
        self, message: str | None = None, *, location: FailureLocation | None = None
    ) -> None:
        """메시지와 실패 위치를 정한다."""
        super().__init__(message)
        self._location = location

    @property
    def location(self) -> FailureLocation | None:
        """실패 위치를 돌려준다."""
        return self._location


class ServerNotReadyError(MinervaError):
    """준비가 끝나기 전에 요청이 왔을 때 낸다."""

    code: ClassVar[str] = "SERVER_NOT_READY"
    default_message: ClassVar[str] = "서버가 아직 준비 중입니다"


class ShuttingDownError(MinervaError):
    """종료 중에 색인 요청이 왔을 때 낸다."""

    code: ClassVar[str] = "SHUTTING_DOWN"
    default_message: ClassVar[str] = "서버가 종료 중이라 새 작업을 받지 않습니다"


class JobFailureCode(StrEnum):
    """작업 실패 사유 코드다."""

    CHUNKING_FAILED = "CHUNKING_FAILED"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    STORE_UNAVAILABLE = "STORE_UNAVAILABLE"
    VECTOR_DIMENSION_MISMATCH = "VECTOR_DIMENSION_MISMATCH"
    DOCUMENT_DELETED = "DOCUMENT_DELETED"
    SERVER_RESTARTED = "SERVER_RESTARTED"
    INTERNAL_ERROR = "INTERNAL_ERROR"
