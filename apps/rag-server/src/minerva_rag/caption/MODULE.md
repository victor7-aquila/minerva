# caption 모듈 명세 (REQ-RAG-1)

Backend가 보낸 표(Markdown)의 요약과 이미지의 캡션을 models로 만들어 돌려준다. 결과는 어디에도 저장하지 않으며, Backend가 받아 저장하고 색인 요청에 다시 담아 보낸다. 폴더는 `apps/rag-server/src/minerva_rag/caption`다.

## 요약

**핵심 계약**

- 만든 요약·캡션을 저장하지 않는다. caption은 store·jobs·파일 저장소에 기대지 않는다 (`REQ-RAG-1.1.2`, `REQ-RAG-1.2.2`)
- 만들지 못하면 빈 문자열을 돌려주지 않고 실패를 낸다. Backend가 실패를 보고 임시 설명으로 채운다 (`REQ-RAG-1.1.3`, `REQ-RAG-1.2.3`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-RAG-1.1` | 표 요약 | 표 하나의 내용을 요약한 문장을 만든다 |
| `REQ-RAG-1.2` | 이미지 캡션 | 이미지 하나를 설명하는 캡션을 만든다 |

**비범위**

- 요청을 작업으로 접수하지 않고 바로 응답하는 일 — service (`REQ-RAG-10.2.1`)
- 실패 시 임시 설명으로 채우는 일 — Backend (`REQ-BE-2.3.2`)

## 구조

### 예상 배치

```text
src/minerva_rag/caption/
└── MODULE.md

tests/unit/caption/
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| models | import | `ModelHub.generate`, `LlmRole.TABLE_SUMMARY`, `LlmRole.IMAGE_CAPTION` | models `MODULE.md` | `REQ-RAG-1.1.1`, `REQ-RAG-1.2.1` |
| core | import | `get_logger`, `CaptionFailedError`, `ModelUnavailableError` | core `MODULE.md` | `REQ-RAG-1.1.3`, `REQ-RAG-1.2.3` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 표 요약 | `Captioner.summarize_table` | 「표 요약 — REQ-RAG-1.1」 | `REQ-RAG-1.1` |
| 이미지 캡션 | `Captioner.caption_image` | 「이미지 캡션 — REQ-RAG-1.2」 | `REQ-RAG-1.2` |

## 기능 그룹별 요구사항

```python
class Captioner:
    """표 요약과 이미지 캡션을 만든다."""

    def __init__(self, models: ModelHub) -> None: ...
    async def summarize_table(self, table_markdown: str) -> str: ...
    async def caption_image(self, image: bytes) -> str: ...
```

두 메서드 모두 앞뒤 공백을 뺀 한 문단의 한국어 문장을 돌려준다.

### 표 요약 — `REQ-RAG-1.1`

**`REQ-RAG-1.1.1`** 표 요약 생성

- 처리 계약: `LlmRole.TABLE_SUMMARY`로 생성하며, 반환값은 비어 있지 않다
- 충족 기준: 모델이 문장을 돌려주면 그 문장이 앞뒤 공백 없이 반환된다

**`REQ-RAG-1.1.2`** 표 요약 비저장

- 충족 기준: `summarize_table`을 부른 뒤 store·jobs와 파일 시스템에 쓰기가 일어나지 않는다

**`REQ-RAG-1.1.3`** 표 요약 실패 알림

- 실패: 모델이 빈 응답을 주거나 생성이 실패하면, 또는 표가 커서 models가 `PromptTooLongError`를 내면 `CaptionFailedError`를 낸다. 표를 잘라 요약하지 않는다. Ollama에 연결할 수 없으면 models의 `ModelUnavailableError`를 그대로 낸다
- 충족 기준: 모델 응답이 비었거나 생성 오류가 나거나 `PromptTooLongError`가 나면 `CaptionFailedError`가, 연결 거부면 `ModelUnavailableError`가 난다

### 이미지 캡션 — `REQ-RAG-1.2`

**`REQ-RAG-1.2.1`** 이미지 캡션 생성

- 처리 계약: `LlmRole.IMAGE_CAPTION`으로 `image`를 넘겨 생성하며, 반환값은 비어 있지 않다
- 충족 기준: 모델이 문장을 돌려주면 그 문장이 앞뒤 공백 없이 반환되고, 모델 호출에 받은 이미지 바이트가 그대로 넘어간다

**`REQ-RAG-1.2.2`** 캡션 비저장

- 충족 기준: `caption_image`를 부른 뒤 store·jobs와 파일 시스템에 쓰기가 일어나지 않는다

**`REQ-RAG-1.2.3`** 캡션 실패 알림

- 실패: 모델이 빈 응답을 주거나 생성이 실패하면(이미지를 읽지 못한 경우 포함) `CaptionFailedError`를 낸다. Ollama에 연결할 수 없으면 `ModelUnavailableError`를 그대로 낸다
- 충족 기준: 모델 응답이 비었거나 생성 오류가 나면 `CaptionFailedError`가, 연결 거부면 `ModelUnavailableError`가 난다

## 실행 계약

### 예외

| 예외 | 발생 조건 | 코드·상태 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `CaptionFailedError` | 빈 응답, 생성 오류 | `CAPTION_FAILED` | 발생: caption. 변환: api | `REQ-RAG-1.1.3`, `REQ-RAG-1.2.3` |
| `ModelUnavailableError` | Ollama 연결 실패 | `MODEL_UNAVAILABLE` | 발생: models. 전파: caption | `REQ-RAG-12.1.2` |

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `caption.failed` | `CaptionFailedError`를 낼 때 | warning | `kind`(`table`·`image`), `input_chars` 또는 `image_bytes` | `REQ-RAG-1.1.3`, `REQ-RAG-1.2.3` |

표 Markdown과 생성한 요약·캡션은 문서 내용이므로 로그에 넣지 않는다.

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-RAG-1.1.1` | unit | 역할이 `TABLE_SUMMARY`, 반환값 공백 정리 | models (mock) | `tests/unit/caption/` |
| `REQ-RAG-1.1.2` | unit | 저장 부작용 없음 | models (mock) | `tests/unit/caption/` |
| `REQ-RAG-1.1.3` | unit | 빈 응답·생성 오류 시 `CaptionFailedError`, 연결 거부 시 `ModelUnavailableError` | models (mock) | `tests/unit/caption/` |
| `REQ-RAG-1.2.1` | unit | 역할이 `IMAGE_CAPTION`, 이미지 바이트 전달, 반환값 공백 정리 | models (mock) | `tests/unit/caption/` |
| `REQ-RAG-1.2.2` | unit | 저장 부작용 없음 | models (mock) | `tests/unit/caption/` |
| `REQ-RAG-1.2.3` | unit | 빈 응답·생성 오류 시 `CaptionFailedError`, 연결 거부 시 `ModelUnavailableError` | models (mock) | `tests/unit/caption/` |
