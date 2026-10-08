# common 모듈 명세 (REQ-BE-8)

Backend의 모든 모듈이 기대는 공통 기반이다. 설정 키 정의와 읽기, 애플리케이션 로그 구성, 도메인 오류 정의, 시각 직렬화와 KST 날짜 범위, 목록 엔드포인트의 페이지 규약, 문서 상태 이름을 한 곳에서 제공한다. 폴더는 `apps/backend/src/common`이다.

## 요약

**핵심 계약**

- 설정은 `ConfigService`로만 읽고, 모든 "설정한 값"은 환경 변수로 바꿀 수 있다. 키 정의는 이 문서 「설정」 한 곳이다 (`REQ-BE-8.1.1`, `AGENTS.md`)
- 문서 본문, 청크 텍스트, 질의 원문, 토큰은 애플리케이션 로그에 나가지 않는다. 금지 경로는 로거 설정이 지운다 (`REQ-BE-8.2.1`)
- 경계 밖으로 나가는 실패는 모두 `DomainError`의 하위 클래스이고, 코드와 내부 정보 없는 한국어 메시지를 갖는다 (`REQ-BE-8.3`)
- 시각은 UTC ISO 8601로 주고받고, 날짜 필터는 KST 하루로 해석한다. 두 변환은 이 모듈의 함수로만 한다. 요청의 날짜 필터는 `parseKstDayRange`를 거쳐, 날짜가 틀리면 `InvalidRequestError`를 낸다 (`REQ-BE-8.4.1`, `REQ-BE-1.3.4`, `REQ-BE-6.2.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-8.1` | 설정 | 모든 설정 키를 정의하고 기동 때 검증한다 |
| `REQ-BE-8.2` | 로그 | nestjs-pino 로거를 구성해 전역으로 제공하고 금지 데이터를 지운다 |
| `REQ-BE-8.3` | 오류 응답 | 도메인 오류 클래스와 코드, 한국어 메시지를 정의한다 |
| `REQ-BE-8.4` | 시각 | 시각 직렬화와 KST 날짜 범위 변환, 날짜 오류의 도메인 오류 변환을 제공한다 |
| `REQ-BE-7.1.3` (떠받침) | 페이지 규약 | 목록 요청 DTO와 페이지 응답 형식을 정의한다 |

**비범위**

- 도메인 오류를 HTTP 상태와 응답 본문으로 바꾸는 일 — api (`API.md` 「오류 코드」)
- 로거를 앱에 붙이는 일(`src/main.ts`) — api
- 목록 응답 형식의 충족 기준 — api (`REQ-BE-7.1.3`)
- 문서 기록(사용자가 보는 로그) — logs (`REQ-BE-6`)

## 구조

### 예상 배치

```text
src/common/
├── index.ts
├── common.module.ts
├── helpers/
│   ├── logger-options.ts
│   ├── page.ts
│   ├── parse-kst-day-range.ts
│   ├── time.ts
│   └── validate-config.ts
├── interfaces/
│   ├── app-config.ts
│   ├── document-state.ts
│   ├── domain-errors.ts
│   ├── log-constants.ts
│   ├── page-query.dto.ts
│   └── page.ts
└── MODULE.md

src/common/**/*.spec.ts      # 단위 테스트는 대상 파일 옆
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `@nestjs/config` | import | `ConfigModule`, `ConfigService` | NestJS | `REQ-BE-8.1.1` |
| nestjs-pino | import | `LoggerModule`, `PinoLogger` | nestjs-pino | `REQ-BE-8.2.1` |
| pino, pino-http | import | 요청 직렬화, `redact`·`formatters`·`hooks` 옵션 | pino | `REQ-BE-8.2.1` |
| class-validator, class-transformer | import | 검증 데코레이터, `@Type` | 각 라이브러리 | `REQ-BE-7.1.3` |
| 환경 변수 | 읽기 | 「설정」의 키 | 이 문서 | `REQ-BE-8.1.1` |

**금지 의존** — common은 다른 Backend 모듈을 import하지 않는다. 모든 모듈이 common에 기대므로(`ARCHITECT.md` 「의존 규칙」) 반대 방향이 생기면 순환한다.

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 설정 | `CommonModule`(전역), `AppConfig`, `ConfigService<AppConfig, true>` | 「설정 — REQ-BE-8.1」, 「설정」 | `REQ-BE-8.1.1` |
| 로그 | `CommonModule`(전역), `PinoLogger` (nestjs-pino), `REDACTED_LOG_PATHS`, `createLoggerParams()`, `createPinoHttpOptions()`, `scrubForbiddenKeys()` | 「로그 — REQ-BE-8.2」, 「로거 등록」 | `REQ-BE-8.2.1` |
| 오류 응답 | `DomainError`와 하위 클래스, `ErrorCode` | 「오류 응답 — REQ-BE-8.3」, 「예외」 | `REQ-BE-8.3` |
| 시각 | `toIsoUtc()`, `kstDayRange()`, `parseKstDayRange()` | 「시각 — REQ-BE-8.4」 | `REQ-BE-8.4.1` |
| 페이지 규약 | `PageQueryDto`, `Page<T>`, `toPage()` | 「페이지 규약」 | `REQ-BE-7.1.3` |
| 공유 타입 | `ProcessingState`, `SearchState` | 「문서 상태 이름」 | `REQ-BE-1.9`, `REQ-BE-6.1` |

## 기능 그룹별 요구사항

### 설정 — `REQ-BE-8.1`

```typescript
/** 검증을 마친 설정값이다. 키는 「설정」 표와 하나씩 대응한다. */
export interface AppConfig { /* 「설정」 표의 키 */ }

/** 공통 모듈이다. 설정과 로거를 전역으로 제공한다. */
@Global() @Module({})
export class CommonModule {}
```

**`REQ-BE-8.1.1`** 설정한 값의 환경 변수

- 처리 계약: 기동할 때 「설정」의 모든 키를 환경 변수에서 읽어 타입과 제약을 검증한다. 환경 변수가 없으면 기본값을 쓴다. 상대 경로는 Backend 앱 폴더(`apps/backend`) 기준으로 푼다. 다른 모듈은 `ConfigService`로만 읽는다
- 실패: 필수 키가 없거나 제약에 맞지 않으면 기동하지 않는다. 이유에는 키 이름만 담고 값은 담지 않는다
- 충족 기준: 「설정」의 각 키를 환경 변수로 주면 그 값이, 주지 않으면 기본값이 `ConfigService`로 읽히고, 필수 키가 빠지면 기동이 실패하며 그 이유에 값이 없다

### 로그 — `REQ-BE-8.2`

```typescript
/** 로그에서 값을 지우는 경로다. */
export const REDACTED_LOG_PATHS: readonly string[];

/** nestjs-pino LoggerModule 설정을 만든다. 출력 대상을 주면 그곳에 쓴다. */
export function createLoggerParams(destination?: DestinationStream): Params;

/** 금지 데이터를 지우는 pino-http 옵션을 만든다. */
export function createPinoHttpOptions(): Options;

/** 객체를 끝까지 훑어 금지 키의 값을 지운 복사본을 만든다. */
export function scrubForbiddenKeys(value: unknown): unknown;
```

**`REQ-BE-8.2.1`** 금지 데이터 비기록

- 처리 계약: 로거는 JSON 구조화 출력이며, 필드 이름이 금지 키(`markdown`, `text`, `query`, `answerSpan`, `answer_span`, `tableMarkdown`, `hint`, `summary`, `caption`, `title`, `token`)인 값과 요청의 본문·`x-minerva-token` 헤더를 `"[removed]"`로 바꿔 내보낸다. 이벤트명은 `모듈.동작` 형식이다(`AGENTS.md`)
- 충족 기준: 금지 키와 요청 본문·토큰 헤더에 담은 문자열이 출력에 없고, `docId`·글자 수 같은 허용 필드는 그대로 나온다

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
- 충족 기준: 「예외」 표의 모든 도메인 오류 클래스가 `API.md` 목록의 `code`와 한글이 든 기본 메시지를 갖는다

**`REQ-BE-8.3.2`** 내부 정보 비노출

- 처리 계약: 메시지에 스택 트레이스, 쿼리, 파일 경로, 문서 본문, 질의 원문을 넣지 않는다. 다른 오류를 감쌀 때 그 오류의 문자열을 메시지에 넣지 않는다
- 충족 기준: 모든 기본 메시지에 경로 구분자·`Error:`·쿼리 표현이 없고, 다른 오류에서 만든 `DomainError`의 메시지에 원래 오류 문자열이 없다

### 시각 — `REQ-BE-8.4`

```typescript
/** Date를 UTC ISO 8601 문자열로 바꾼다. */
export function toIsoUtc(at: Date): string;

/** KST 날짜 문자열(YYYY-MM-DD) 하루를 UTC 시각 범위 [start, end)로 바꾼다. 날짜가 틀리면 RangeError를 던진다. */
export function kstDayRange(day: string): { start: Date; end: Date };

/** KST 날짜 문자열 하루를 UTC 시각 범위로 바꾼다. 날짜가 틀리면 InvalidRequestError를 던진다. */
export function parseKstDayRange(day: string): { start: Date; end: Date };
```

**`REQ-BE-8.4.1`** 시간대가 붙은 ISO 8601

- 처리 계약: 응답의 모든 시각은 `toIsoUtc`로 만든 `Z` 끝 문자열이다. 날짜 필터는 KST 00:00부터 다음 날 00:00까지로 바꾼다. 요청의 날짜 필터는 `parseKstDayRange`로 바꾸며, 이 함수는 `kstDayRange`의 `RangeError`만 `InvalidRequestError`로 바꾼다
- 실패: 날짜 형식이 아니거나 달력에 없는 날짜면 `kstDayRange`는 `RangeError`를, `parseKstDayRange`는 `InvalidRequestError`를 낸다. 어느 메시지에도 입력값을 넣지 않는다
- 충족 기준: `toIsoUtc`가 `Z`로 끝나는 문자열을 만들고, `kstDayRange('2026-10-04')`와 `parseKstDayRange('2026-10-04')`가 `2026-10-03T15:00:00Z`부터 `2026-10-04T15:00:00Z` 전까지이며, 날짜 형식이 아니거나 달력에 없는 날짜면 `kstDayRange`는 `RangeError`, `parseKstDayRange`는 `InvalidRequestError`(HTTP `400 INVALID_REQUEST`)이고 두 메시지에 입력값이 없다

### 페이지 규약

이 그룹은 `REQ-BE-7.1.3`을 떠받친다. 목록 엔드포인트를 가진 documents·logs·evaluation이 api를 import하지 않고 같은 페이지 형식을 쓰게 한다(`ARCHITECT.md` 「의존 규칙」). 충족 기준은 api `MODULE.md`의 `REQ-BE-7.1.3`이 소유한다.

```typescript
/** 페이지 요청이다. 목록 DTO가 이어받는다. */
export class PageQueryDto {
  page?: number;      // 1 이상, 기본 1
  page_size?: 20 | 50 | 100;  // 기본 20
  order?: 'asc' | 'desc';     // 기본 desc
}

/** 페이지 응답이다. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

/** 목록과 전체 개수로 페이지 응답을 만든다. */
export function toPage<T>(items: T[], total: number, query: PageQueryDto): Page<T>;
```

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
| `INDEX_SCHEDULE_CRON` | `string` | `0 0 * * *` (매일 00:00) | cron 표현식. 한국 표준시(KST, `Asia/Seoul`)로 해석한다 | `REQ-BE-1.10.1` |
| `RECONCILE_INTERVAL_MS` | `number` | `60000` | 1 이상 | `REQ-BE-3.3.1` |
| `RAG_RETRY_INTERVAL_MS` | `number` | `60000` | 1 이상. 청크 삭제·이름·판 정보 변경 재요청 주기 | `REQ-BE-1.8.4`, `REQ-BE-3.4.2` |
| `LOG_RETENTION_DAYS` | `number` | `90` | 1 이상 | `REQ-BE-6.3.1` |
| `UPLOAD_MAX_MD_BYTES` | `number` | `10485760` (10MB) | 1 이상 | `REQ-BE-1.1.10` |
| `UPLOAD_MAX_IMAGE_BYTES` | `number` | `20971520` (20MB) | 1 이상 | `REQ-BE-1.1.10` |
| `UPLOAD_MAX_FILES` | `number` | `200` | 1 이상 | `REQ-BE-1.1.10` |
| `UPLOAD_MAX_TOTAL_BYTES` | `number` | `209715200` (200MB) | 1 이상 | `REQ-BE-1.1.10` |

경로 기본값의 `../../data/`는 저장소 루트의 `data/`다(`ARCHITECT.md` 「실행 구조」).

### 로거 등록

- `CommonModule`이 nestjs-pino `LoggerModule`을 `createLoggerParams()`로 한 번 가져와 내보낸다. 전역 모듈이라 다른 모듈은 따로 import하지 않고 `PinoLogger`를 생성자 주입으로 받는다(`AGENTS.md`). api의 `AppModule`은 `CommonModule`을 맨 먼저 가져온다

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
| `DocumentLockedError` | 처리 중인 문서를 바꾸려 한다(색인 대기열에 있는 문서의 편집·내용 다시 올리기는 받는다). 색인 대기열에 있는 문서를 재색인하려 한다. 처리 상태가 실패가 아닌 문서를 색인 대기로 바꾸려 한다. 교체된 문서를 바꾸거나 색인 대기로 바꾸려 한다 | `DOCUMENT_LOCKED` | 발생: documents | `REQ-BE-1.5.5`, `REQ-BE-1.5.6`, `REQ-BE-1.10.6` |
| `DocumentNotSearchableError` | 검색 가능이 아닌 문서를 정답 문서로 고른다 | `DOCUMENT_NOT_SEARCHABLE` | 발생: evaluation | `REQ-BE-5.1.2` |
| `AnswerSpanNotFoundError` | 정답 구간이 색인용 MD에 없다 | `ANSWER_SPAN_NOT_FOUND` | 발생: evaluation | `REQ-BE-5.1.5` |
| `EvaluationInProgressError` | 평가 중인 골든셋이 있다 | `EVALUATION_IN_PROGRESS` | 발생: evaluation | `REQ-BE-5.2.5` |
| `RagUnavailableError` | RAG Server가 응답하지 않거나 준비 중이다 | `RAG_UNAVAILABLE` | 발생: rag | `REQ-BE-10.1.2` |
| `RangeError` | `kstDayRange`에 날짜 형식이 아니거나 달력에 없는 날짜가 들어온다 | 도메인 오류가 아니다 | 발생: common(`kstDayRange`). 변환: common(`parseKstDayRange` → `InvalidRequestError`) | `REQ-BE-8.4.1` |

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-8.1.1` | unit | 키별 환경 변수 반영과 기본값, 필수 키 누락 시 기동 실패와 이유에 값 없음 | 환경 변수 | `src/common/**/*.spec.ts` |
| `REQ-BE-8.2.1` | unit | 금지 키·본문·토큰 헤더 제거, 허용 필드 유지 | 로그 출력 캡처 | `src/common/**/*.spec.ts` |
| `REQ-BE-8.3.1` | unit | 모든 오류의 코드·한국어 메시지, 코드가 `API.md` 목록에 있음 | | `src/common/**/*.spec.ts` |
| `REQ-BE-8.3.2` | unit | 기본 메시지에 내부 표현 없음, 감싼 오류 문자열 비노출 | | `src/common/**/*.spec.ts` |
| `REQ-BE-8.4.1` | unit | UTC 문자열, KST 하루 범위, 잘못된 날짜의 `RangeError`와 `InvalidRequestError`, 메시지에 입력값 없음 | | `src/common/**/*.spec.ts` |
| `REQ-BE-7.1.3` | unit | `PageQueryDto` 기본값·제약, `toPage()`의 응답 형식 | | `src/common/**/*.spec.ts` |
