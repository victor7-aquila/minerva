# core 모듈 명세 (REQ-RAG-11)

RAG Server의 모든 단위가 기대는 공통 기반이다. 설정, 로깅, 오류 정의, 단위 사이 공유 타입을 한 곳에서 제공해, 단위마다 설정을 다르게 읽거나 오류 코드를 다르게 쓰거나 금지된 데이터를 로그에 남기지 않게 한다. 폴더는 `apps/rag-server/src/minerva_rag/core`다.

## 요약

**핵심 계약**

- 설정은 캐시된 팩토리 `get_settings()` 하나로만 읽고, 모든 "설정한 값"은 환경 변수로 바꿀 수 있다 (`REQ-RAG-11.1.1`)
- 문서 본문, 청크 텍스트, 질의 원문은 로그에 나가지 않는다. 금지 키의 값은 core의 로그 처리기가 지운다 (`REQ-RAG-11.2.1`)
- 경계 밖으로 나가는 오류는 모두 `MinervaError`의 하위 클래스이고, 코드와 내부 정보가 없는 한국어 메시지를 갖는다 (`REQ-RAG-11.3.1`, `REQ-RAG-11.3.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-RAG-11.1` | 설정 | 모든 설정 키를 정의하고, 환경 변수에서 한 번 읽어 캐시한다 |
| `REQ-RAG-11.2` | 로그 | structlog 로거를 만들고, 금지 데이터가 로그에 나가지 않게 한다 |
| `REQ-RAG-11.3` | 오류 응답 | 오류 클래스와 오류 코드, 작업 실패 사유 코드, 한국어 메시지를 정의한다 |

**비범위**

- 오류를 HTTP 상태와 응답 본문으로 바꾸는 일 — api
- 청크 레코드 타입의 필드와 불변 조건 — `INTERFACES.md`의 `IF-RAG-1`. core는 그 타입을 코드로 둘 뿐이다
- 자리표시 형식의 정의 — 루트 `INTERFACES.md`의 `IF-1`. core는 그 형식을 읽는 함수만 둔다

## 구조

### 예상 배치

```text
src/minerva_rag/core/
└── MODULE.md

tests/unit/core/
```

모든 공개 심볼은 `minerva_rag.core` 패키지에서 import한다. 패키지 안의 파일 분할은 구현 재량이다.

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| 환경 변수 | 읽기 | 「설정」의 키 | 이 문서 | `REQ-RAG-11.1.1` |
| structlog | import | 로거, 처리기 | structlog | `REQ-RAG-11.2.1` |

**금지 의존** — core는 다른 단위를 import하지 않는다. 모든 단위가 core에 기대므로(`ARCHITECT.md` 「의존 규칙」) 반대 방향이 생기면 순환한다.

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 설정 | `Settings`, `get_settings()` | 「설정 — REQ-RAG-11.1」, 「설정」 | `REQ-RAG-11.1.1` |
| 로그 | `configure_logging()`, `get_logger()` | 「로그 — REQ-RAG-11.2」 | `REQ-RAG-11.2.1` |
| 오류 응답 | `MinervaError`와 하위 클래스, `JobFailureCode` | 「오류 응답 — REQ-RAG-11.3」, 「예외」 | `REQ-RAG-11.3.1`, `REQ-RAG-11.3.2` |
| 공유 타입 | `ChunkKind`, `Chunk`, `ChunkingResult`, `Edition`, `ChunkRecord` | `IF-RAG-1` | `REQ-RAG-2`, `REQ-RAG-3`, `REQ-RAG-4` |
| 공유 타입 | `Placeholder`, `find_placeholders()` | 「자리표시 읽기」 | `REQ-RAG-2.2`, `REQ-RAG-3.1` |
| 공유 타입 | `FailureLocation` | 「실패 위치」 | `REQ-RAG-7.2.5`, `REQ-RAG-10.3.3` |
| 공유 타입 | `SparseVector` | 「키워드 벡터 타입」 | `REQ-RAG-3.2.2`, `REQ-RAG-4.1.1` |

## 기능 그룹별 요구사항

### 설정 — `REQ-RAG-11.1`

```python
class Settings(BaseSettings):
    """RAG Server의 설정이다. 필드는 「설정」 표의 키와 하나씩 대응한다."""

def get_settings() -> Settings:
    """설정을 처음 한 번 읽어 캐시하고 같은 객체를 돌려준다."""
```

**`REQ-RAG-11.1.1`** 설정한 값의 환경 변수

- 입력·선행 조건: 「설정」 표의 키 이름이 곧 환경 변수 이름이다. 환경 변수가 없으면 기본값을 쓰고, 기본값이 없는 필수 키가 없으면 `get_settings()`가 실패한다
- 처리 계약: 상대 경로 값은 RAG Server 앱 폴더(`apps/rag-server`) 기준으로 푼다. `get_settings()`는 두 번째 호출부터 같은 객체를 돌려준다
- 실패: 필수 키가 없거나 타입이 맞지 않으면 기동하지 않는다. 이유는 키 이름만 담고 값은 담지 않는다
- 충족 기준: 「설정」 표의 각 키를 환경 변수로 주면 그 값이 `Settings`에 들어가고, 주지 않으면 표의 기본값이 들어간다

### 로그 — `REQ-RAG-11.2`

```python
def configure_logging() -> None:
    """structlog를 JSON 출력과 금지 키 제거 처리기로 구성한다."""

def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """모듈 이름으로 구조화 로거를 돌려준다."""
```

**`REQ-RAG-11.2.1`** 금지 데이터 비기록

- 처리 계약: 이벤트의 키가 금지 키(`markdown`, `text`, `query`, `answer_span`, `table_markdown`, `summary`, `caption`, `title`, `token`, `authorization`)면 그 값을 지우고 `"[removed]"`로 바꾼 뒤 내보낸다. 이벤트명은 `모듈.동작` 형식이다(`AGENTS.md`)
- 충족 기준: 금지 키에 문자열을 담아 로그를 남기면 출력에 그 문자열이 없고, `doc_id`·글자 수 같은 허용 키의 값은 그대로 나온다

### 오류 응답 — `REQ-RAG-11.3`

```python
class MinervaError(Exception):
    """경계 밖으로 나가는 오류의 기반이다."""
    code: ClassVar[str]
    default_message: ClassVar[str]
    def __init__(self, message: str | None = None) -> None: ...
    @property
    def message(self) -> str: ...

class JobFailureCode(StrEnum):
    CHUNKING_FAILED = "CHUNKING_FAILED"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    STORE_UNAVAILABLE = "STORE_UNAVAILABLE"
    VECTOR_DIMENSION_MISMATCH = "VECTOR_DIMENSION_MISMATCH"
    DOCUMENT_DELETED = "DOCUMENT_DELETED"
    SERVER_RESTARTED = "SERVER_RESTARTED"
    INTERNAL_ERROR = "INTERNAL_ERROR"
```

하위 클래스와 코드는 「예외」 표가 소유한다. `JobFailureCode`는 service `MODULE.md`의 `JobFailure.code`와 API의 `JobFailure.code`에 들어가는 값의 전체 목록이며, 뜻은 `apps/rag-server/API.md`의 `JobFailure`가 소유한다.

**`REQ-RAG-11.3.1`** 오류 코드와 한국어 메시지

- 처리 계약: 모든 하위 클래스는 `code`와 한국어 `default_message`를 갖는다. `message`를 넘기지 않으면 `default_message`를 쓴다
- 충족 기준: 「예외」 표의 모든 클래스가 비지 않은 `code`와 한글이 든 `default_message`를 갖고, `code` 값은 `API.md` 「오류 코드」 표에 있다

**`REQ-RAG-11.3.2`** 내부 정보 비노출

- 처리 계약: `message`는 스택 트레이스, 쿼리, 파일 경로, 질의 원문을 담지 않는다. 다른 예외를 감쌀 때 그 예외의 문자열을 `message`에 넣지 않는다
- 충족 기준: 모든 하위 클래스의 `default_message`에 경로 구분자·`Traceback`·`SELECT` 같은 내부 표현이 없고, 다른 예외에서 만든 `MinervaError`의 `message`에 원래 예외의 문자열이 들어 있지 않다

### 자리표시 읽기

이 그룹은 REQ를 직접 담당하지 않고, chunking과 indexing이 루트 `IF-1` 형식을 같은 규칙으로 읽게 한다(`REQ-RAG-2.2`, `REQ-RAG-3.1`).

```python
@dataclass(frozen=True)
class Placeholder:
    """색인용 MD 안의 자리표시 하나다."""
    kind: str            # "table" 또는 "image"
    placeholder_id: str
    raw: str             # 원문에 나온 자리표시 문자열 전체
    start: int           # raw가 시작하는 글자 위치
    end: int             # raw가 끝난 다음 글자 위치

def find_placeholders(text: str) -> tuple[Placeholder, ...]:
    """text 안의 자리표시를 나오는 차례대로 돌려준다."""
```

- 처리 계약: 루트 `IF-1`의 형식(`[[minerva:{kind}:{placeholder_id} | {description}]]`)에 맞는 문자열만 자리표시로 읽는다. `raw`는 원문과 한 글자도 다르지 않다
- 충족 기준: 형식에 맞는 자리표시가 든 텍스트에서 모든 자리표시를 차례대로 찾고, `text[start:end] == raw`이며, 형식에 맞지 않는 `[[...]]`는 찾지 않는다

### 실패 위치

이 그룹은 REQ를 직접 담당하지 않고, chunking이 `ChunkingFailedError`에 담은 위치를 service가 작업 실패에 옮기게 한다(`REQ-RAG-7.2.5`, `REQ-RAG-10.3.3`). API의 형식은 `API.md`의 `JobFailure`가 소유한다.

```python
@dataclass(frozen=True)
class FailureLocation:
    """실패가 생긴 문서 안 위치다."""
    heading_path: tuple[str, ...] | None
    placeholder_id: str | None
```

### 키워드 벡터 타입

이 그룹은 REQ를 직접 담당하지 않고, resource가 만든 BM25 키워드 벡터를 indexing과 resource가 같은 타입으로 주고받게 한다(`REQ-RAG-3.2.2`, `REQ-RAG-4.1.1`).

```python
@dataclass(frozen=True)
class SparseVector:
    """BM25 키워드 벡터다."""
    indices: tuple[int, ...]
    values: tuple[float, ...]
```

- 처리 계약: `indices`와 `values`의 길이가 같고, `indices`에 같은 값이 두 번 나오지 않는다
- 충족 기준: 길이가 다르거나 `indices`가 겹치면 만들 때 `ValueError`가 난다

## 실행 계약

### 설정

이 표가 RAG Server 설정 키의 유일한 정의처다. 다른 단위는 키 이름만 가리킨다.

| 키 | 타입 | 기본값·필수 | 검증·제약 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `RAG_QDRANT_URL` | `str` | 필수 | URL | `REQ-RAG-13.1` |
| `RAG_OLLAMA_URL` | `str` | 필수 | URL | `REQ-RAG-12.1` |
| `RAG_BACKEND_EVENTS_URL` | `str` | 필수 | URL. Backend의 `POST /v1/internal/rag-events` 주소 | `REQ-RAG-7.7` |
| `RAG_BACKEND_EVENTS_TOKEN` | `SecretStr` | 필수 | 알림에 담는 토큰. Backend의 알림 토큰과 같은 값 | `REQ-RAG-7.7.5` |
| `RAG_API_TOKEN` | `SecretStr` | 필수 | Backend가 요청에 담아야 하는 토큰 | `REQ-RAG-9.3.1` |
| `RAG_MAX_MARKDOWN_BYTES` | `int` | `10485760` (10MB) | 1 이상. 색인용 MD의 UTF-8 바이트 수 | `REQ-RAG-9.1.3` |
| `RAG_MAX_IMAGE_BYTES` | `int` | `20971520` (20MB) | 1 이상 | `REQ-RAG-9.1.3` |
| `RAG_JOBS_DB_PATH` | `Path` | `../../data/rag-server/jobs.sqlite3` | | `REQ-RAG-7.5.1` |
| `RAG_MODELS_DIR` | `Path` | `../../data/rag-server/models` | 임베딩·재정렬 모델 파일 위치 | `REQ-RAG-12.1.1` |
| `RAG_GLOSSARY_PATH` | `Path` | `config/glossary.yaml` | | `REQ-RAG-5.1` |
| `RAG_CHUNKING_LLM` | `str` | `qwen3:14b` | Ollama 모델 이름 | `REQ-RAG-2.1.1` |
| `RAG_TABLE_LLM` | `str` | `qwen3:14b` | Ollama 모델 이름 | `REQ-RAG-1.1.1` |
| `RAG_CAPTION_VLM` | `str` | `qwen3-vl:8b` | Ollama 모델 이름 | `REQ-RAG-1.2.1` |
| `RAG_EMBEDDING_MODEL` | `str` | `Qwen/Qwen3-Embedding-4B` | sentence-transformers 모델 이름 | `REQ-RAG-3.2.1` |
| `RAG_RERANKER_MODEL` | `str` | `BAAI/bge-reranker-v2-m3` | sentence-transformers 모델 이름 | `REQ-RAG-4.2.1` |
| `RAG_CHUNK_MAX_TOKENS` | `int` | `512` | 1 이상 | `REQ-RAG-2.5.1.1` |
| `RAG_CHUNKING_LLM_MAX_INPUT_TOKENS` | `int` | `8000` | `RAG_CHUNK_MAX_TOKENS`보다 크고, `RAG_LLM_OUTPUT_RESERVE_TOKENS`와 합해 `RAG_LLM_CONTEXT_TOKENS` 이하 | `REQ-RAG-2.5.2.1` |
| `RAG_LLM_CONTEXT_TOKENS` | `int` | `16384` | Ollama 생성 요청마다 지정하는 컨텍스트 크기 | `REQ-RAG-2.5.2.2` |
| `RAG_LLM_OUTPUT_RESERVE_TOKENS` | `int` | `4096` | 컨텍스트 중 출력에 남기는 몫. `RAG_LLM_CONTEXT_TOKENS`보다 작다 | `REQ-RAG-2.5.2.2` |
| `RAG_CHUNKING_RETRIES` | `int` | `2` | 0 이상 | `REQ-RAG-2.3.2` |
| `RAG_SEARCH_DEFAULT_TOP_N` | `int` | `10` | 1 이상 | `REQ-RAG-4.3.2` |
| `RAG_NEIGHBOR_MAX_TOKENS` | `int` | `1024` | 0 이상. 결과 하나의 앞뒤 청크 합계 | `REQ-RAG-4.4.5` |
| `RAG_LATEST_EDITION_WEIGHT` | `float` | `0` | | `REQ-RAG-4.5.5` |
| `RAG_JOB_CONCURRENCY` | `int` | `1` | 1 이상 | `REQ-RAG-7.3.1` |
| `RAG_NOTIFY_RETRIES` | `int` | `5` | 0 이상 | `REQ-RAG-7.7.3` |
| `RAG_SHUTDOWN_TIMEOUT_SECONDS` | `float` | `30` | 0 이상 | `REQ-RAG-10.1.3` |

- 토큰 수는 모두 `RAG_EMBEDDING_MODEL`의 토크나이저로 센다
- `SecretStr` 키는 값이 로그·오류 메시지·`repr`에 나오지 않는다
- 경로 기본값의 `../../data/`는 저장소 루트의 `data/`다(`ARCHITECT.md` 「실행 구조」)

### 예외

| 예외 | 발생 조건 | 코드·상태 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `InvalidRequestError` | 요청 내용이 계약에 맞지 않는다 | `INVALID_REQUEST` | 발생: service. 변환: api | `REQ-RAG-9.1.2` |
| `UnauthorizedError` | API 토큰이 없거나 다르다 | `UNAUTHORIZED` | 발생·변환: api | `REQ-RAG-9.3.1` |
| `PayloadTooLargeError` | 요청이 크기 한도를 넘는다 | `PAYLOAD_TOO_LARGE` | 발생·변환: api | `REQ-RAG-9.1.3` |
| `JobNotFoundError` | 그 ID의 작업이 없다 | `JOB_NOT_FOUND` | 발생: service. 변환: api | `REQ-RAG-7.2.2` |
| `DocumentNotSearchableError` | 정답 문서가 검색되지 않는다 | `DOCUMENT_NOT_SEARCHABLE` | 발생: evaluation. 변환: api | `REQ-RAG-6.3.2` |
| `CaptionFailedError` | 요약·캡션을 만들지 못했다 | `CAPTION_FAILED` | 발생: service. 변환: api | `REQ-RAG-1.1.3`, `REQ-RAG-1.2.3` |
| `ModelUnavailableError` | 모델 서버에 연결할 수 없다 | `MODEL_UNAVAILABLE` | 발생: resource. 변환: api, 작업에서는 service | `REQ-RAG-12.1.2` |
| `PromptTooLongError` | 생성 입력이 컨텍스트에서 출력 몫을 뺀 크기를 넘는다 | 경계 밖으로 나가지 않는다 | 발생: resource. 처리: service(요약·캡션)는 `CaptionFailedError`로, chunking은 `ChunkingFailedError`로 바꾼다 | `REQ-RAG-2.5.2.2` |
| `GlossaryError` | 용어집 파일이 형식에 맞지 않는다 | 경계 밖으로 나가지 않는다 | 발생: search. 처리: 기동 때는 service가 기동을 멈추고, 다시 읽을 때는 search가 직전 용어집을 계속 쓴다 | `REQ-RAG-5.1.1`, `REQ-RAG-5.1.2`, `REQ-RAG-5.1.3` |
| `ModelLoadError` | 설정한 모델을 불러오지 못했다 | 경계 밖으로 나가지 않는다 | 발생: resource. 처리: service가 기동을 멈춘다 | `REQ-RAG-12.1.1` |
| `StoreUnavailableError` | Qdrant에 연결할 수 없다 | `STORE_UNAVAILABLE` | 발생: resource. 변환: api, 작업에서는 service | `REQ-RAG-13.1.1` |
| `VectorDimensionMismatchError` | 저장된 벡터 차원이 임베딩 모델과 다르다 | `VECTOR_DIMENSION_MISMATCH` | 발생: resource. 변환: api, 작업에서는 service | `REQ-RAG-13.1.2` |
| `ChunkingFailedError` | 청킹을 끝내지 못했다. 위치(`FailureLocation`)를 가질 수 있다 | 작업 실패 사유 `CHUNKING_FAILED` | 발생: chunking. 변환: service가 `JobFailure`로 | `REQ-RAG-10.3.3` |
| `ServerNotReadyError` | 준비가 끝나기 전에 요청이 왔다 | `SERVER_NOT_READY` | 발생: service. 변환: api | `REQ-RAG-10.1.2` |
| `ShuttingDownError` | 종료 중에 색인 요청이 왔다 | `SHUTTING_DOWN` | 발생: service. 변환: api | `REQ-RAG-10.1.3` |

HTTP 상태는 `API.md` 「오류 코드」가 소유한다.

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-RAG-11.1.1` | unit | 키마다 환경 변수 반영과 기본값, 필수 키 누락 시 실패와 실패 이유에 값 없음, 캐시 | 환경 변수 (monkeypatch) | `tests/unit/core/` |
| `REQ-RAG-11.2.1` | unit | 금지 키 값 제거, 허용 키 유지 | 로그 출력 캡처 | `tests/unit/core/` |
| `REQ-RAG-11.3.1` | unit | 모든 하위 클래스의 코드·한국어 메시지, 코드가 `API.md` 목록에 있음 | | `tests/unit/core/` |
| `REQ-RAG-11.3.2` | unit | 기본 메시지에 내부 표현 없음, 감싼 예외 문자열 비노출 | | `tests/unit/core/` |
| `REQ-RAG-2.2.1` | unit | `find_placeholders`의 차례·위치·원문 일치, 형식에 맞지 않는 `[[...]]` 무시 (자리표시 읽기) | | `tests/unit/core/` |
| `REQ-RAG-3.2.2` | unit | `SparseVector`의 길이·중복 검증 (키워드 벡터 타입) | | `tests/unit/core/` |
