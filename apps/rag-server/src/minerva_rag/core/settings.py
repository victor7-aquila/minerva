"""RAG Server의 설정을 환경 변수와 .env에서 읽는다 (REQ-RAG-11.1)."""

import functools
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# core/settings.py → core → minerva_rag → src → apps/rag-server
_APP_DIR = Path(__file__).resolve().parents[3]

# 교차 검증 위반 문장이다. ★ 값을 넣지 않고 키 이름만 담는다
_MSG_INPUT_VS_CHUNK = "RAG_CHUNKING_LLM_MAX_INPUT_TOKENS는 RAG_CHUNK_MAX_TOKENS보다 커야 합니다"
_MSG_INPUT_PLUS_RESERVE = (
    "RAG_CHUNKING_LLM_MAX_INPUT_TOKENS와 RAG_LLM_OUTPUT_RESERVE_TOKENS의 합이 "
    "RAG_LLM_CONTEXT_TOKENS 이하여야 합니다"
)
_MSG_RESERVE_VS_CONTEXT = "RAG_LLM_OUTPUT_RESERVE_TOKENS는 RAG_LLM_CONTEXT_TOKENS보다 작아야 합니다"
_MSG_ENV_ENCODING = (
    "설정을 읽지 못했습니다: .env 파일을 UTF-8로 저장해야 합니다 "
    "(PowerShell 5.1의 기본 저장 방식인 UTF-16·cp949는 읽을 수 없습니다)"
)
_CROSS_MESSAGES = (_MSG_INPUT_VS_CHUNK, _MSG_INPUT_PLUS_RESERVE, _MSG_RESERVE_VS_CONTEXT)


class Settings(BaseSettings):
    """RAG Server의 설정이다. 필드는 「설정」 표의 키와 하나씩 대응한다."""

    model_config = SettingsConfigDict(
        env_prefix="RAG_",
        env_file=_APP_DIR / ".env",  # ★ 환경 변수가 .env보다 우선한다
        env_file_encoding="utf-8",
        env_ignore_empty=True,  # ★ 값을 비운 키는 지정하지 않은 것으로 본다
        extra="ignore",
        frozen=True,  # 캐시해 공유하는 객체라 바꾸지 못하게 한다
        hide_input_in_errors=True,  # ★ 검증 오류에 입력 값이 실리지 않게 한다
        validate_default=True,  # ★ 기본 경로 값에도 앱 폴더 기준 풀기가 돌게 한다
    )

    # 외부 서비스 주소 (필수)
    qdrant_url: str  # Qdrant 주소
    ollama_url: str  # Ollama 주소
    backend_events_url: str  # Backend의 POST /v1/internal/rag-events 주소
    backend_events_token: SecretStr  # 알림에 담는 토큰. Backend의 알림 토큰과 같은 값
    api_token: SecretStr  # Backend가 요청에 담아야 하는 토큰

    # 요청 크기 한도 (바이트)
    max_markdown_bytes: int = Field(default=10_485_760, ge=1)  # 색인용 MD의 UTF-8 바이트 수
    max_image_bytes: int = Field(default=20_971_520, ge=1)  # 이미지 한 장의 바이트 수

    # 경로 (상대 경로는 앱 폴더 기준)
    jobs_db_path: Path = Path("../../data/rag-server/jobs.sqlite3")  # 작업 저장소
    models_dir: Path = Path("../../data/rag-server/models")  # 임베딩·재정렬 모델 파일 위치
    glossary_path: Path = Path("config/glossary.yaml")  # 용어집 파일

    # 모델 이름
    chunking_llm: str = "qwen3:14b"  # 청킹용 Ollama 모델
    table_llm: str = "qwen3:14b"  # 표 요약용 Ollama 모델
    caption_vlm: str = "qwen3-vl:8b"  # 이미지 캡션용 Ollama 모델
    embedding_model: str = "Qwen/Qwen3-Embedding-4B"  # sentence-transformers 임베딩 모델
    reranker_model: str = "BAAI/bge-reranker-v2-m3"  # sentence-transformers 재정렬 모델

    # 청킹·LLM 토큰 (RAG_EMBEDDING_MODEL의 토크나이저로 센다)
    chunk_max_tokens: int = Field(default=512, ge=1)  # 청크 하나의 토큰 상한
    chunking_llm_max_input_tokens: int = 8000  # 청킹 LLM 한 번의 입력 토큰 상한
    llm_context_tokens: int = 16384  # Ollama 생성 요청마다 지정하는 컨텍스트 크기
    llm_output_reserve_tokens: int = 4096  # 컨텍스트 중 출력에 남기는 몫
    chunking_retries: int = Field(default=2, ge=0)  # 청킹 재시도 횟수

    # 검색
    search_default_top_n: int = Field(default=10, ge=1)  # 검색 결과 기본 개수
    neighbor_max_tokens: int = Field(default=1024, ge=0)  # 결과 하나의 앞뒤 청크 합계 토큰
    latest_edition_weight: float = 0.0  # 최신 판 가중치

    # 작업·종료
    job_concurrency: int = Field(default=1, ge=1)  # 동시에 처리하는 색인 작업 수
    notify_retries: int = Field(default=5, ge=0)  # Backend 알림 재시도 횟수
    shutdown_timeout_seconds: float = Field(default=30.0, ge=0)  # 종료 때 작업을 기다리는 시간

    @field_validator("qdrant_url", "ollama_url", "backend_events_url", mode="after")
    @classmethod
    def _check_url(cls, value: str) -> str:
        """http·https 스킴과 호스트가 있는 URL인지 검사한다."""
        parts = urlsplit(value)
        # ★ 메시지에 값을 넣지 않는다
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("URL 형식이 아닙니다")
        return value

    @field_validator("jobs_db_path", "models_dir", "glossary_path", mode="after")
    @classmethod
    def _resolve_path(cls, value: Path) -> Path:
        """상대 경로를 작업 폴더가 아니라 앱 폴더 기준으로 푼다."""
        if value.is_absolute():
            return value
        return (_APP_DIR / value).resolve()

    @model_validator(mode="after")
    def _check_token_limits(self) -> "Settings":
        """토큰 한도 사이의 관계를 검사한다."""
        if self.chunking_llm_max_input_tokens <= self.chunk_max_tokens:
            raise ValueError(_MSG_INPUT_VS_CHUNK)
        if self.llm_output_reserve_tokens >= self.llm_context_tokens:
            raise ValueError(_MSG_RESERVE_VS_CONTEXT)
        if (
            self.chunking_llm_max_input_tokens + self.llm_output_reserve_tokens
            > self.llm_context_tokens
        ):
            raise ValueError(_MSG_INPUT_PLUS_RESERVE)
        return self


def _format_settings_error(exc: ValidationError) -> str:
    """검증 오류를 키 이름과 사유만 담은 한 줄로 만든다. ★ 입력 값은 옮기지 않는다."""
    reasons: dict[str, str] = {}
    for error in exc.errors(include_input=False, include_url=False):
        loc = error["loc"]
        if loc:
            key = "RAG_" + str(loc[0]).upper()
            reason = "값 없음" if error["type"] == "missing" else "형식 또는 범위 오류"
        else:
            # 교차 검증 — 우리가 만든 문장만 옮긴다
            message = str(error["msg"])
            key = next((m for m in _CROSS_MESSAGES if m in message), "토큰 한도 관계 오류")
            reason = "위반"
        reasons.setdefault(key, reason)
    detail = ", ".join(
        key if reason == "위반" else f"{key}({reason})" for key, reason in reasons.items()
    )
    return f"설정을 읽지 못했습니다: {detail}"


@functools.cache
def get_settings() -> Settings:
    """설정을 처음 한 번 읽어 캐시하고 같은 객체를 돌려준다."""
    failure: str | None = None
    try:
        return Settings()  # pyright: ignore[reportCallIssue] — 필수 값은 환경 변수에서 채운다
    except ValidationError as exc:
        failure = _format_settings_error(exc)
    except UnicodeDecodeError:
        # ★ 값·경로·오류 원문을 옮기지 않는다 (PowerShell 5.1이 UTF-16·cp949로 저장한 경우)
        failure = _MSG_ENV_ENCODING
    # ★ except 밖에서 낸다 — 원래 오류(입력 값 포함 가능)가 __context__로 붙지 않게 한다
    raise RuntimeError(failure)
