# common 모듈 명세 (REQ-BE-8)

Backend의 모든 모듈이 기대는 공통 기반이다. 설정 키 정의와 읽기, 도메인 오류 정의, 문서 상태 이름, 날짜 필터의 도메인 오류 변환을 한 곳에서 제공한다. 로그는 logger 라이브러리(`libs/logger`), 시각 직렬화·KST 날짜 범위와 페이지 규약은 utils 라이브러리(`libs/utils`)가 맡는다. 폴더는 `apps/backend/src/common`이다.

## 요약

**핵심 계약**

- 설정은 `ConfigService`로만 읽고, 모든 "설정한 값"은 환경 변수로 바꿀 수 있다. 키 정의는 이 문서 「설정」 한 곳이다 (`REQ-BE-8.1.1`, `AGENTS.md`)
- 경계 밖으로 나가는 실패는 모두 `DomainError`의 하위 클래스이고, 코드와 내부 정보 없는 한국어 메시지를 갖는다 (`REQ-BE-8.3`)
- 요청의 날짜 필터는 `parseKstDayRange`로 KST 하루로 해석하고, 날짜가 틀리면 `InvalidRequestError`를 낸다. KST 하루 계산은 utils의 `kstDayRange`가 한다 (`REQ-BE-8.4.1`, `REQ-BE-1.3.4`, `REQ-BE-6.2.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-8.1` | 설정 | 모든 설정 키를 정의하고 기동 때 검증한다 |
| `REQ-BE-8.3` | 오류 응답 | 도메인 오류 클래스와 코드, 한국어 메시지를 정의한다 |
| `REQ-BE-8.4` (떠받침) | 날짜 범위 | utils의 KST 날짜 범위 변환을 감싸 날짜 오류를 `InvalidRequestError`로 바꾼다 |

**비범위**

- 도메인 오류를 HTTP 상태와 응답 본문으로 바꾸는 일 — api (`API.md` 「오류 코드」)
- 구조화 로그와 금지 데이터 제거 — logger 라이브러리 (`libs/logger` `MODULE.md`, `REQ-BE-8.2`)
- 시각 직렬화와 KST 날짜 범위 계산, 페이지 규약 정의 — utils 라이브러리 (`libs/utils` `MODULE.md`, `REQ-BE-8.4`, `REQ-BE-7.1.3`)
- 문서 기록(사용자가 보는 로그) — logs (`REQ-BE-6`)

## 구조

### 예상 배치

```text
src/common/
├── index.ts
├── common.module.ts
├── helpers/
│   ├── parse-kst-day-range.ts
│   └── validate-config.ts
├── interfaces/
│   ├── app-config.ts
│   ├── document-state.ts
│   └── domain-errors.ts
└── MODULE.md

src/common/**/*.spec.ts      # 단위 테스트는 대상 파일 옆
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `@nestjs/config` | import | `ConfigModule`, `ConfigService` | NestJS | `REQ-BE-8.1.1` |
| libs/utils | import | `kstDayRange` | utils `MODULE.md` | `REQ-BE-8.4.1` |
| 환경 변수 | 읽기 | 「설정」의 키 | 이 문서 | `REQ-BE-8.1.1` |

**금지 의존** — common은 다른 Backend 모듈을 import하지 않는다. 모든 모듈이 common에 기대므로(`ARCHITECT.md` 「의존 규칙」) 반대 방향이 생기면 순환한다. 라이브러리는 `libs/<이름>/index.ts`로만 import한다.

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 설정 | `CommonModule`(전역), `AppConfig`, `ConfigService<AppConfig, true>` | 「설정 — REQ-BE-8.1」, 「설정」 | `REQ-BE-8.1.1` |
| 오류 응답 | `DomainError`와 하위 클래스, `ErrorCode` | 「오류 응답 — REQ-BE-8.3」, 「예외」 | `REQ-BE-8.3` |
| 날짜 범위 | `parseKstDayRange()` | 「날짜 범위 — REQ-BE-8.4」 | `REQ-BE-8.4.1` |
| 공유 타입 | `ProcessingState`, `SearchState` | 「문서 상태 이름」 | `REQ-BE-1.9`, `REQ-BE-6.1` |

## 기능 그룹별 요구사항

### 설정 — `REQ-BE-8.1`

```typescript
/** 검증을 마친 설정값이다. 키는 「설정」 표와 하나씩 대응한다. */
export interface AppConfig { /* 「설정」 표의 키 */ }

/** 공통 모듈이다. 설정을 전역으로 제공한다. */
@Global() @Module({})
export class CommonModule {}
```

**`REQ-BE-8.1.1`** 설정한 값의 환경 변수

- 처리 계약: 기동할 때 「설정」의 모든 키를 환경 변수에서 읽어 타입과 제약을 검증한다. 환경 변수가 없으면 기본값을 쓴다. 상대 경로는 Backend 앱 폴더(`apps/backend`) 기준으로 푼다. 다른 모듈은 `ConfigService`로만 읽는다
- 실패: 필수 키가 없거나 제약에 맞지 않으면 기동하지 않는다. 이유에는 키 이름만 담고 값은 담지 않는다
- 충족 기준: 「설정」의 각 키를 환경 변수로 주면 그 값이, 주지 않으면 기본값이 `ConfigService`로 읽히고, 필수 키가 빠지면 기동이 실패하며 그 이유에 값이 없다

### 오류 응답 — `REQ-BE-8.3`

```typescript
/** 경계 밖으로 나가는 오류의 기반이다. */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  constructor(message?: string);
}

export type ErrorCode =
  | 'INVALID_REQUEST' | 'UNSUPPORTED_FILE' | 'ANSWER_SPAN_NOT_FOUND'
  | 'UNAUTHORIZED' | 'DOCUMENT_NOT_FOUND' | 'ASSET_NOT_FOUND' | 'GOLDEN_SET_NOT_FOUND'
  | 'DOCUMENT_LOCKED' | 'DOCUMENT_NOT_SEARCHABLE' | 'EVALUATION_IN_PROGRESS'
  | 'PAYLOAD_TOO_LARGE' | 'RAG_UNAVAILABLE';
```

`ErrorCode`는 `API.md` 「오류 코드」에서 `INTERNAL_ERROR`·`NOT_FOUND`를 뺀 목록과 같다. 두 코드는 api가 도메인 오류가 아닌 예외를 바꿀 때만 쓴다(api `MODULE.md` 「예외」). 하위 클래스는 「예외」 표가 소유한다.

**`REQ-BE-8.3.1`** 오류 코드와 한국어 메시지

- 처리 계약: 모든 하위 클래스는 `code`와 한국어 기본 메시지를 갖는다. 메시지를 넘기면 그 메시지를 쓴다
- 충족 기준: 「예외」 표의 모든 클래스가 `API.md` 목록의 `code`와 한글이 든 기본 메시지를 갖는다

**`REQ-BE-8.3.2`** 내부 정보 비노출

- 처리 계약: 메시지에 스택 트레이스, 쿼리, 파일 경로, 문서 본문, 질의 원문을 넣지 않는다. 다른 오류를 감쌀 때 그 오류의 문자열을 메시지에 넣지 않는다
- 충족 기준: 모든 기본 메시지에 경로 구분자·`Error:`·쿼리 표현이 없고, 다른 오류에서 만든 `DomainError`의 메시지에 원래 오류 문자열이 없다

### 날짜 범위 — `REQ-BE-8.4`

이 그룹은 `REQ-BE-8.4.1`을 떠받친다. utils 라이브러리는 도메인 오류를 모르므로, 날짜 필터의 오류를 HTTP `400`이 되는 도메인 오류로 바꾸는 일을 이 모듈이 맡는다. 시각 직렬화와 KST 하루 계산의 계약은 utils `MODULE.md` 「시각 — REQ-BE-8.4」가 소유한다.

```typescript
/** KST 날짜 문자열 하루를 UTC 시각 범위로 바꾼다. 날짜가 틀리면 InvalidRequestError를 던진다. */
export function parseKstDayRange(day: string): { start: Date; end: Date };
```

**`REQ-BE-8.4.1`** 시간대가 붙은 ISO 8601

- 처리 계약: 요청의 날짜 필터는 `parseKstDayRange`로 KST 00:00부터 다음 날 00:00까지로 바꾼다. utils의 `kstDayRange`를 부르고, 그 `RangeError`만 `InvalidRequestError`로 바꾼다
- 실패: 날짜 형식이 아니면 `InvalidRequestError`를 낸다. 메시지에 입력값을 넣지 않는다
- 충족 기준: `parseKstDayRange('2026-10-04')`가 `2026-10-03T15:00:00Z`부터 `2026-10-04T15:00:00Z` 전까지이고, 날짜 형식이 아니거나 달력에 없는 날짜면 `InvalidRequestError`(HTTP `400 INVALID_REQUEST`)이며 메시지에 입력값이 없다

### 문서 상태 이름

이 그룹은 REQ를 직접 담당하지 않고, documents와 logs가 같은 상태 이름을 쓰게 한다. 값은 `API.md`의 `processing_state`·`search_state` 값과 같다.

```typescript
export type ProcessingState = 'uploaded' | 'captioning' | 'queued' | 'indexing' | 'completed' | 'failed';
export type SearchState = 'searchable' | 'not_searchable' | 'replaced';
```

## 실행 계약

### 설정

이 표가 Backend 설정 키의 유일한 정의처다. 다른 모듈은 키 이름만 가리킨다.

| 키 | 타입 | 기본값·필수 | 검증·제약 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `PORT` | `number` | `3000` | 1~65535 | `REQ-BE-7.1.1` |
| `MONGODB_URI` | `string` | 필수 | MongoDB 연결 문자열. 비밀 | `REQ-BE-9.1.1` |
| `FILE_STORAGE_DIR` | `string` | `../../data/backend/files` | 이미지 파일 저장 위치 | `REQ-BE-9.1.2` |
| `RAG_SERVER_URL` | `string` | 필수 | URL | `REQ-BE-10.1.1` |
| `RAG_SERVER_API_TOKEN` | `string` | 필수 | 비밀. RAG Server의 `RAG_API_TOKEN`과 같은 값 | `REQ-BE-10.1.4` |
| `RAG_EVENTS_TOKEN` | `string` | 필수 | 비밀. RAG Server의 `RAG_BACKEND_EVENTS_TOKEN`과 같은 값 | `REQ-BE-3.2.5` |
| `RAG_TIMEOUT_MS` | `number` | `30000` | 1 이상 | `REQ-BE-10.1.3` |
| `RAG_CAPTION_TIMEOUT_MS` | `number` | `120000` | 1 이상 | `REQ-BE-10.1.3` |
| `RAG_WAIT_TIMEOUT_MS` | `number` | `600000` | 1 이상. 문서 삭제·이름 변경 호출 | `REQ-BE-10.1.3` |
| `CHUNKING_MODE` | `'semantic' \| 'rule'` | `semantic` | | `REQ-BE-3.1.3` |
| `RECONCILE_INTERVAL_MS` | `number` | `60000` | 1 이상 | `REQ-BE-3.3.1` |
| `RAG_RETRY_INTERVAL_MS` | `number` | `60000` | 1 이상. 청크 삭제·이름·판 정보 변경 재요청 주기 | `REQ-BE-1.8.4`, `REQ-BE-3.4.2` |
| `LOG_RETENTION_DAYS` | `number` | `90` | 1 이상 | `REQ-BE-6.3.1` |
| `UPLOAD_MAX_MD_BYTES` | `number` | `10485760` (10MB) | 1 이상 | `REQ-BE-1.1.10` |
| `UPLOAD_MAX_IMAGE_BYTES` | `number` | `20971520` (20MB) | 1 이상 | `REQ-BE-1.1.10` |
| `UPLOAD_MAX_FILES` | `number` | `200` | 1 이상 | `REQ-BE-1.1.10` |
| `UPLOAD_MAX_TOTAL_BYTES` | `number` | `209715200` (200MB) | 1 이상 | `REQ-BE-1.1.10` |

경로 기본값의 `../../data/`는 저장소 루트의 `data/`다(`ARCHITECT.md` 「실행 구조」).

### 예외

HTTP 상태는 `API.md` 「오류 코드」가 소유한다.

| 예외 | 발생 조건 | 코드 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `InvalidRequestError` | 요청 내용이 계약에 맞지 않는다 | `INVALID_REQUEST` | 발생: 각 모듈·api. 변환: api | `REQ-BE-7.1.2` |
| `UnsupportedFileError` | 받지 않는 형식의 파일 | `UNSUPPORTED_FILE` | 발생: documents | `REQ-BE-1.1.2` |
| `PayloadTooLargeError` | 업로드 한도 초과 | `PAYLOAD_TOO_LARGE` | 발생: documents·api | `REQ-BE-1.1.10` |
| `UnauthorizedError` | 알림 토큰이 없거나 다르다 | `UNAUTHORIZED` | 발생: indexing | `REQ-BE-3.2.5` |
| `DocumentNotFoundError` | 문서가 없거나 삭제됐다 | `DOCUMENT_NOT_FOUND` | 발생: documents | `REQ-BE-1.4` |
| `AssetNotFoundError` | 그 이미지가 없다 | `ASSET_NOT_FOUND` | 발생: assets | `REQ-BE-2.4.1` |
| `GoldenSetNotFoundError` | 골든셋이 없다 | `GOLDEN_SET_NOT_FOUND` | 발생: evaluation | `REQ-BE-5.1.4` |
| `DocumentLockedError` | 처리 중이거나 교체된 문서를 바꾸려 한다 | `DOCUMENT_LOCKED` | 발생: documents | `REQ-BE-1.5.5`, `REQ-BE-1.5.6` |
| `DocumentNotSearchableError` | 검색 가능이 아닌 문서를 정답 문서로 고른다 | `DOCUMENT_NOT_SEARCHABLE` | 발생: evaluation | `REQ-BE-5.1.2` |
| `AnswerSpanNotFoundError` | 정답 구간이 색인용 MD에 없다 | `ANSWER_SPAN_NOT_FOUND` | 발생: evaluation | `REQ-BE-5.1.5` |
| `EvaluationInProgressError` | 평가 중인 골든셋이 있다 | `EVALUATION_IN_PROGRESS` | 발생: evaluation | `REQ-BE-5.2.5` |
| `RagUnavailableError` | RAG Server가 응답하지 않거나 준비 중이다 | `RAG_UNAVAILABLE` | 발생: rag | `REQ-BE-10.1.2` |

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-8.1.1` | unit | 키별 환경 변수 반영과 기본값, 필수 키 누락 시 기동 실패와 이유에 값 없음 | 환경 변수 | `src/common/**/*.spec.ts` |
| `REQ-BE-8.3.1` | unit | 모든 오류의 코드·한국어 메시지, 코드가 `API.md` 목록에 있음 | | `src/common/**/*.spec.ts` |
| `REQ-BE-8.3.2` | unit | 기본 메시지에 내부 표현 없음, 감싼 오류 문자열 비노출 | | `src/common/**/*.spec.ts` |
| `REQ-BE-8.4.1` | unit | `parseKstDayRange`의 KST 하루 범위, 잘못된 날짜의 `InvalidRequestError`와 메시지에 입력값 없음 | | `src/common/**/*.spec.ts` |
