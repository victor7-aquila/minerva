"""설정(REQ-RAG-11.1.1) 단위 테스트."""

import os
import traceback
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr

from minerva_rag.core import Settings, get_settings

APP_DIR = Path(__file__).resolve().parents[3]  # tests/unit/core → apps/rag-server

REQUIRED_KEYS = [
    "RAG_QDRANT_URL",
    "RAG_OLLAMA_URL",
    "RAG_BACKEND_EVENTS_URL",
    "RAG_BACKEND_EVENTS_TOKEN",
    "RAG_API_TOKEN",
]

_JOBS_DEFAULT = APP_DIR / "../../data/rag-server/jobs.sqlite3"
_MODELS_DEFAULT = APP_DIR / "../../data/rag-server/models"
_GLOSSARY_DEFAULT = APP_DIR / "config/glossary.yaml"

# 기본값이 있는 21개 키: (키, 필드, 기본값)
DEFAULT_CASES: list[tuple[str, str, Any]] = [
    ("RAG_MAX_MARKDOWN_BYTES", "max_markdown_bytes", 10485760),
    ("RAG_MAX_IMAGE_BYTES", "max_image_bytes", 20971520),
    ("RAG_JOBS_DB_PATH", "jobs_db_path", _JOBS_DEFAULT),
    ("RAG_MODELS_DIR", "models_dir", _MODELS_DEFAULT),
    ("RAG_GLOSSARY_PATH", "glossary_path", _GLOSSARY_DEFAULT),
    ("RAG_CHUNKING_LLM", "chunking_llm", "qwen3:14b"),
    ("RAG_TABLE_LLM", "table_llm", "qwen3:14b"),
    ("RAG_CAPTION_VLM", "caption_vlm", "qwen3-vl:8b"),
    ("RAG_EMBEDDING_MODEL", "embedding_model", "Qwen/Qwen3-Embedding-4B"),
    ("RAG_RERANKER_MODEL", "reranker_model", "BAAI/bge-reranker-v2-m3"),
    ("RAG_CHUNK_MAX_TOKENS", "chunk_max_tokens", 512),
    ("RAG_CHUNKING_LLM_MAX_INPUT_TOKENS", "chunking_llm_max_input_tokens", 8000),
    ("RAG_LLM_CONTEXT_TOKENS", "llm_context_tokens", 16384),
    ("RAG_LLM_OUTPUT_RESERVE_TOKENS", "llm_output_reserve_tokens", 4096),
    ("RAG_CHUNKING_RETRIES", "chunking_retries", 2),
    ("RAG_SEARCH_DEFAULT_TOP_N", "search_default_top_n", 10),
    ("RAG_NEIGHBOR_MAX_TOKENS", "neighbor_max_tokens", 1024),
    ("RAG_LATEST_EDITION_WEIGHT", "latest_edition_weight", 0.0),
    ("RAG_JOB_CONCURRENCY", "job_concurrency", 1),
    ("RAG_NOTIFY_RETRIES", "notify_retries", 5),
    ("RAG_SHUTDOWN_TIMEOUT_SECONDS", "shutdown_timeout_seconds", 30.0),
]

# 전체 26개 키: (키, 필드, 입력, 기대, 기대 타입)
ENV_CASES: list[tuple[str, str, str, Any, type]] = [
    ("RAG_QDRANT_URL", "qdrant_url", "http://qdrant:6333", "http://qdrant:6333", str),
    ("RAG_OLLAMA_URL", "ollama_url", "http://ollama:11434", "http://ollama:11434", str),
    (
        "RAG_BACKEND_EVENTS_URL",
        "backend_events_url",
        "https://be.example/v1/internal/rag-events",
        "https://be.example/v1/internal/rag-events",
        str,
    ),
    ("RAG_BACKEND_EVENTS_TOKEN", "backend_events_token", "tok-a", "tok-a", SecretStr),
    ("RAG_API_TOKEN", "api_token", "tok-b", "tok-b", SecretStr),
    ("RAG_MAX_MARKDOWN_BYTES", "max_markdown_bytes", "2048", 2048, int),
    ("RAG_MAX_IMAGE_BYTES", "max_image_bytes", "4096", 4096, int),
    (
        "RAG_JOBS_DB_PATH",
        "jobs_db_path",
        "var/jobs.db",
        APP_DIR / "var/jobs.db",
        Path,
    ),
    ("RAG_MODELS_DIR", "models_dir", "models-x", APP_DIR / "models-x", Path),
    (
        "RAG_GLOSSARY_PATH",
        "glossary_path",
        "config/other.yaml",
        APP_DIR / "config/other.yaml",
        Path,
    ),
    ("RAG_CHUNKING_LLM", "chunking_llm", "llama3:8b", "llama3:8b", str),
    ("RAG_TABLE_LLM", "table_llm", "llama3:8b", "llama3:8b", str),
    ("RAG_CAPTION_VLM", "caption_vlm", "llava:7b", "llava:7b", str),
    ("RAG_EMBEDDING_MODEL", "embedding_model", "BAAI/bge-m3", "BAAI/bge-m3", str),
    (
        "RAG_RERANKER_MODEL",
        "reranker_model",
        "BAAI/bge-reranker-base",
        "BAAI/bge-reranker-base",
        str,
    ),
    ("RAG_CHUNK_MAX_TOKENS", "chunk_max_tokens", "256", 256, int),
    ("RAG_CHUNKING_LLM_MAX_INPUT_TOKENS", "chunking_llm_max_input_tokens", "6000", 6000, int),
    ("RAG_LLM_CONTEXT_TOKENS", "llm_context_tokens", "32768", 32768, int),
    ("RAG_LLM_OUTPUT_RESERVE_TOKENS", "llm_output_reserve_tokens", "2048", 2048, int),
    ("RAG_CHUNKING_RETRIES", "chunking_retries", "0", 0, int),
    ("RAG_SEARCH_DEFAULT_TOP_N", "search_default_top_n", "5", 5, int),
    ("RAG_NEIGHBOR_MAX_TOKENS", "neighbor_max_tokens", "0", 0, int),
    ("RAG_LATEST_EDITION_WEIGHT", "latest_edition_weight", "0.25", 0.25, float),
    ("RAG_JOB_CONCURRENCY", "job_concurrency", "2", 2, int),
    ("RAG_NOTIFY_RETRIES", "notify_retries", "0", 0, int),
    ("RAG_SHUTDOWN_TIMEOUT_SECONDS", "shutdown_timeout_seconds", "12.5", 12.5, float),
]

ALL_KEYS = {case[0] for case in ENV_CASES}


def _same_path(actual: object, expected: Path) -> bool:
    """절대 경로이면서 정규화(`..` 접기, 대소문자) 뒤 expected와 같은지 돌려준다."""

    def norm(path: object) -> str:
        return os.path.normcase(os.path.normpath(str(path)))

    return isinstance(actual, Path) and actual.is_absolute() and norm(actual) == norm(expected)


def _load_error() -> RuntimeError:
    """get_settings()를 불러 RuntimeError를 받아 돌려준다. 안 나면 실패한다."""
    with pytest.raises(RuntimeError) as info:
        get_settings()
    return info.value


@pytest.mark.req("REQ-RAG-11.1.1")
def test_settings_fields_match_keys() -> None:
    """[REQ-RAG-11.1.1] Settings 필드는 「설정」 표의 26개 키와 하나씩 대응한다."""
    keys = {"RAG_" + name.upper() for name in Settings.model_fields}
    assert keys - ALL_KEYS == set()  # 여분 키 없음
    assert ALL_KEYS - keys == set()  # 빠진 키 없음


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize(("key", "field", "default"), DEFAULT_CASES)
def test_default_values(required_env: dict[str, str], key: str, field: str, default: Any) -> None:
    """[REQ-RAG-11.1.1] 환경 변수를 주지 않으면 표의 기본값이 들어간다 (경로는 절대 경로)."""
    value = getattr(get_settings(), field)
    if isinstance(default, Path):
        assert _same_path(value, default), key
    else:
        assert value == default, key
        if isinstance(default, float):
            assert isinstance(value, float), key


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize(("key", "field", "raw", "expected", "kind"), ENV_CASES)
def test_env_overrides(
    required_env: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    key: str,
    field: str,
    raw: str,
    expected: Any,
    kind: type,
) -> None:
    """[REQ-RAG-11.1.1] 키를 환경 변수로 주면 그 값이 올바른 타입으로 Settings에 들어간다."""
    monkeypatch.setenv(key, raw)
    value = getattr(get_settings(), field)
    assert isinstance(value, kind)
    if isinstance(value, SecretStr):
        assert value.get_secret_value() == expected
    elif isinstance(expected, Path):
        assert _same_path(value, expected)
    else:
        assert value == expected


@pytest.mark.req("REQ-RAG-11.1.1")
def test_relative_path_ignores_cwd(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """[REQ-RAG-11.1.1] 상대 경로는 작업 폴더가 아니라 앱 폴더 기준으로 푼다."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAG_GLOSSARY_PATH", "config/x.yaml")
    assert _same_path(get_settings().glossary_path, APP_DIR / "config/x.yaml")


@pytest.mark.req("REQ-RAG-11.1.1")
def test_absolute_path_kept(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """[REQ-RAG-11.1.1] 절대 경로는 그대로 쓴다."""
    monkeypatch.setenv("RAG_JOBS_DB_PATH", str(tmp_path / "jobs.sqlite3"))
    assert _same_path(get_settings().jobs_db_path, tmp_path / "jobs.sqlite3")


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize("key", REQUIRED_KEYS)
def test_missing_required_key_fails(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    """[REQ-RAG-11.1.1] 필수 키가 없으면 키 이름만 담은 RuntimeError가 나고 연쇄가 없다."""
    monkeypatch.delenv(key)
    error = _load_error()
    assert key in str(error)
    assert error.__cause__ is None
    assert error.__context__ is None


@pytest.mark.req("REQ-RAG-11.1.1")
def test_empty_env_value_is_unset(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-11.1.1] 빈 값은 지정하지 않은 것과 같다 (.env.example이 값을 비워 둔다)."""
    monkeypatch.setenv("RAG_CHUNK_MAX_TOKENS", "")
    assert get_settings().chunk_max_tokens == 512


@pytest.mark.req("REQ-RAG-11.1.1")
def test_empty_required_value_fails(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-11.1.1] 필수 키의 빈 값은 없는 것과 같아 실패한다."""
    monkeypatch.setenv("RAG_API_TOKEN", "")
    assert "RAG_API_TOKEN" in str(_load_error())


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize(
    ("key", "bad", "secret"),
    [
        ("RAG_CHUNK_MAX_TOKENS", "not-int-SECRET-111", "SECRET-111"),
        ("RAG_NOTIFY_RETRIES", "SECRET-222", "SECRET-222"),
        ("RAG_LATEST_EDITION_WEIGHT", "SECRET-333", "SECRET-333"),
    ],
)
def test_failure_hides_values(
    required_env: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    key: str,
    bad: str,
    secret: str,
) -> None:
    """[REQ-RAG-11.1.1] 검증 실패의 메시지·트레이스백에 값이 없고 원래 오류를 연쇄로 달지 않는다."""
    monkeypatch.setenv(key, bad)
    error = _load_error()
    text = str(error)
    full = "".join(traceback.format_exception(error))
    assert key in text
    for hidden in (secret, "api-token-for-test"):
        assert hidden not in text
        assert hidden not in full
    # ★ from None만으로는 __context__가 남으므로 둘 다 확인한다
    assert error.__cause__ is None
    assert error.__context__ is None


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("RAG_MAX_MARKDOWN_BYTES", "0"),
        ("RAG_MAX_IMAGE_BYTES", "0"),
        ("RAG_CHUNK_MAX_TOKENS", "0"),
        ("RAG_CHUNKING_RETRIES", "-1"),
        ("RAG_SEARCH_DEFAULT_TOP_N", "0"),
        ("RAG_NEIGHBOR_MAX_TOKENS", "-1"),
        ("RAG_JOB_CONCURRENCY", "0"),
        ("RAG_NOTIFY_RETRIES", "-1"),
        ("RAG_SHUTDOWN_TIMEOUT_SECONDS", "-0.5"),
    ],
)
def test_range_violation_fails(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch, key: str, value: str
) -> None:
    """[REQ-RAG-11.1.1] 허용 범위를 벗어난 값은 그 키 이름을 담은 RuntimeError로 실패한다."""
    monkeypatch.setenv(key, value)
    assert key in str(_load_error())


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize(
    ("key", "field", "value", "expected"),
    [
        ("RAG_MAX_MARKDOWN_BYTES", "max_markdown_bytes", "1", 1),
        ("RAG_SEARCH_DEFAULT_TOP_N", "search_default_top_n", "1", 1),
        ("RAG_JOB_CONCURRENCY", "job_concurrency", "1", 1),
        ("RAG_CHUNKING_RETRIES", "chunking_retries", "0", 0),
        ("RAG_NEIGHBOR_MAX_TOKENS", "neighbor_max_tokens", "0", 0),
        ("RAG_NOTIFY_RETRIES", "notify_retries", "0", 0),
        ("RAG_SHUTDOWN_TIMEOUT_SECONDS", "shutdown_timeout_seconds", "0", 0.0),
    ],
)
def test_range_boundary_passes(
    required_env: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    key: str,
    field: str,
    value: str,
    expected: Any,
) -> None:
    """[REQ-RAG-11.1.1] 범위 경계값(1 이상·0 이상의 최솟값)은 통과한다."""
    monkeypatch.setenv(key, value)
    assert getattr(get_settings(), field) == expected


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize("key", ["RAG_QDRANT_URL", "RAG_OLLAMA_URL", "RAG_BACKEND_EVENTS_URL"])
@pytest.mark.parametrize("bad", ["not-a-url-SECRET-444", "host name with spaces SECRET-444"])
def test_url_validation(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch, key: str, bad: str
) -> None:
    """[REQ-RAG-11.1.1] URL이 아닌 값이면 키 이름만 담아 실패한다."""
    monkeypatch.setenv(key, bad)
    text = str(_load_error())
    assert key in text
    assert "SECRET-444" not in text


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize(
    ("overrides", "accepted_keys"),
    [
        # 입력 한도가 청크 상한(512) 이하
        (
            {"RAG_CHUNKING_LLM_MAX_INPUT_TOKENS": "512"},
            {"RAG_CHUNKING_LLM_MAX_INPUT_TOKENS", "RAG_CHUNK_MAX_TOKENS"},
        ),
        # 입력 + 출력 몫(4096)이 컨텍스트를 넘는다 (다른 규칙은 어기지 않는다)
        (
            {"RAG_CHUNKING_LLM_MAX_INPUT_TOKENS": "12289"},
            {
                "RAG_CHUNKING_LLM_MAX_INPUT_TOKENS",
                "RAG_LLM_OUTPUT_RESERVE_TOKENS",
                "RAG_LLM_CONTEXT_TOKENS",
            },
        ),
        # 컨텍스트가 줄어 입력(8000) + 출력 몫(4096)이 넘는다 (다른 규칙은 어기지 않는다)
        (
            {"RAG_LLM_CONTEXT_TOKENS": "8000"},
            {
                "RAG_CHUNKING_LLM_MAX_INPUT_TOKENS",
                "RAG_LLM_OUTPUT_RESERVE_TOKENS",
                "RAG_LLM_CONTEXT_TOKENS",
            },
        ),
    ],
)
def test_token_limits_cross_check(
    required_env: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    overrides: dict[str, str],
    accepted_keys: set[str],
) -> None:
    """[REQ-RAG-11.1.1] 토큰 수 키 사이의 관계를 어기면 관련 키 이름 중 하나를 담아 실패한다."""
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    text = str(_load_error())
    assert any(key in text for key in accepted_keys)


@pytest.mark.req("REQ-RAG-11.1.1")
def test_token_limits_boundary_passes(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-11.1.1] 입력 한도 + 출력 몫이 컨텍스트와 같으면 통과한다."""
    monkeypatch.setenv("RAG_CHUNKING_LLM_MAX_INPUT_TOKENS", "12288")  # 12288 + 4096 == 16384
    monkeypatch.setenv("RAG_CHUNK_MAX_TOKENS", "12287")
    settings = get_settings()
    assert settings.chunking_llm_max_input_tokens == 12288
    assert settings.chunk_max_tokens == 12287


@pytest.mark.req("REQ-RAG-11.1.1")
def test_get_settings_cached(required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-11.1.1] get_settings()는 두 번째 호출부터 같은 객체를 돌려준다."""
    first = get_settings()
    monkeypatch.setenv("RAG_CHUNK_MAX_TOKENS", "256")
    second = get_settings()
    assert second is first
    assert second.chunk_max_tokens == 512


@pytest.mark.req("REQ-RAG-11.1.1")
def test_secret_not_in_repr(required_env: dict[str, str]) -> None:
    """[REQ-RAG-11.1.1] SecretStr 키의 값은 repr·str에 나오지 않는다."""
    settings = get_settings()
    for text in (repr(settings), str(settings)):
        assert "events-token-for-test" not in text
        assert "api-token-for-test" not in text


@pytest.mark.req("REQ-RAG-11.1.1")
def test_env_file_read_and_env_wins(
    required_env: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """[REQ-RAG-11.1.1] .env에서도 읽고, 같은 키가 환경 변수에 있으면 환경 변수가 이긴다."""
    # 필수 값은 .env에만 두고 환경 변수에서는 지운다
    for key in required_env:
        monkeypatch.delenv(key)
    lines = [f"{key}={value}" for key, value in required_env.items()]
    lines.append("RAG_CHUNK_MAX_TOKENS=300")
    env_file = tmp_path / ".env"
    env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setitem(Settings.model_config, "env_file", env_file)
    monkeypatch.setenv("RAG_CHUNK_MAX_TOKENS", "400")
    settings = get_settings()
    assert settings.qdrant_url == required_env["RAG_QDRANT_URL"]
    assert settings.api_token.get_secret_value() == required_env["RAG_API_TOKEN"]
    assert settings.chunk_max_tokens == 400


@pytest.mark.req("REQ-RAG-11.1.1")
@pytest.mark.parametrize("encoding", ["utf-16", "cp949"])
def test_env_file_wrong_encoding_fails_cleanly(
    required_env: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    encoding: str,
) -> None:
    """[REQ-RAG-11.1.1] UTF-8이 아닌 .env는 UTF-8 안내의 RuntimeError로 실패하고 원인이 없다."""
    for key in required_env:
        monkeypatch.delenv(key)
    env_file = tmp_path / ".env"
    # 한글 값이 있어 cp949 바이트가 UTF-8로 해석되지 않는다
    lines = [f"{key}={value}" for key, value in required_env.items()] + [
        "RAG_CHUNKING_LLM=한글SECRET-ENC"
    ]
    env_file.write_text("\n".join(lines) + "\n", encoding=encoding)
    monkeypatch.setitem(Settings.model_config, "env_file", env_file)
    error = _load_error()
    text = str(error)
    assert "UTF-8" in text
    assert str(env_file) not in text
    assert "SECRET-ENC" not in text
    assert error.__cause__ is None
    assert error.__context__ is None
