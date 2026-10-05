# logger 라이브러리 명세 (REQ-BE-8.2)

Backend의 애플리케이션 로그를 구성하는 라이브러리다. 구조화 로그와 금지 데이터 제거를 nestjs-pino 로거 설정 한 곳에서 정하고, 그 로거 모듈을 전역으로 등록한다. 업무와 무관한 기반 기능이라 `src`와 다른 라이브러리를 import하지 않는다. 폴더는 `apps/backend/libs/logger`다.

## 요약

**핵심 계약**

- 문서 본문, 청크 텍스트, 질의 원문, 토큰은 로그에 나가지 않는다. 금지 경로는 로거 설정이 지운다 (`REQ-BE-8.2.1`)
- `src`는 이 라이브러리를 `libs/logger/index.ts`로만 import한다 (`ARCHITECT.md` 「의존 규칙」)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-8.2` | 로그 | nestjs-pino 로거를 구성하고 금지 데이터를 지운다 |

**비범위**

- 문서 기록(사용자가 보는 로그) — logs (`REQ-BE-6`)
- 로거 모듈을 앱에 넣고 로거를 붙이는 일 — api (`AppModule`, `src/main.ts`)

## 구조

### 예상 배치

```text
libs/logger/
├── index.ts
├── logger.module.ts
├── helpers/
│   └── logger-options.ts
├── interfaces/
│   └── log-constants.ts
└── MODULE.md

libs/logger/**/*.spec.ts      # 단위 테스트는 대상 파일 옆
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| nestjs-pino | import | `LoggerModule`, `PinoLogger` | nestjs-pino | `REQ-BE-8.2.1` |
| pino, pino-http | import | 요청 직렬화, `redact`·`formatters`·`hooks` 옵션 | pino | `REQ-BE-8.2.1` |

**금지 의존** — logger는 `src`와 다른 라이브러리를 import하지 않는다. 모든 `src` 모듈이 logger를 쓸 수 있으므로(`ARCHITECT.md` 「의존 규칙」) 반대 방향이 생기면 순환한다.

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 로그 | `AppLoggerModule`(전역), `PinoLogger` (nestjs-pino), `REDACTED_LOG_PATHS` | 「로그 — REQ-BE-8.2」 | `REQ-BE-8.2.1` |
| 로그 | `createLoggerParams()`, `createPinoHttpOptions()`, `scrubForbiddenKeys()` | 「로그 — REQ-BE-8.2」 | `REQ-BE-8.2.1` |

## 기능 그룹별 요구사항

### 로그 — `REQ-BE-8.2`

```typescript
/** 로거 모듈이다. 금지 키를 지우는 nestjs-pino 로거를 전역으로 제공한다. */
@Global() @Module({})
export class AppLoggerModule {}

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

## 실행 계약

### 등록

- `AppLoggerModule`은 api의 `AppModule`이 `CommonModule` 다음에 한 번 가져온다. 전역 모듈이라 다른 모듈은 따로 import하지 않고 `PinoLogger`를 생성자 주입으로 받는다(`AGENTS.md`)

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-8.2.1` | unit | 금지 키·본문·토큰 헤더 제거, 허용 필드 유지 | 로그 출력 캡처 | `libs/logger/**/*.spec.ts` |
