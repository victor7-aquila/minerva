# api 모듈 명세 (REQ-BE-7)

Backend의 HTTP 공통 규약을 맡는다. 전역 요청 검증, 전역 예외 필터, 페이지 응답 형식, multipart 한도, 앱 조립과 기동을 한 곳에서 정하고, 엔드포인트별 처리는 각 기능 모듈의 컨트롤러가 한다. 폴더는 `apps/backend/src/api`이며, 앱 진입점 `src/main.ts`도 이 모듈이 소유한다.

## 요약

**핵심 계약**

- 형식이 잘못된 요청은 컨트롤러에 닿기 전에 `400 INVALID_REQUEST`로 거부한다. DTO에 없는 필드도 거부한다 (`REQ-BE-7.1.2`)
- 모든 실패 응답은 전역 예외 필터 한 곳에서 `API.md`의 본문과 상태로 바뀐다. 응답에 스택 트레이스, 쿼리, 파일 경로, 원래 예외 문자열이 나가지 않는다 (`REQ-BE-8.3`, `AGENTS.md`)
- 목록 응답은 모두 같은 페이지 형식이다 (`REQ-BE-7.1.3`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-7.1` | 요청 처리 | HTTP 요청을 받고, 형식을 검증하고, 페이지 응답 형식을 정한다 |

**비범위**

- 엔드포인트별 라우팅과 처리 — 각 기능 모듈의 컨트롤러 (`ARCHITECT.md` 「단위 구성」)
- 오류 클래스와 메시지 정의 — common

## 구조

### 예상 배치

```text
src/api/
└── MODULE.md
src/main.ts                  # 앱 진입점. 빌드·실행 명령이 이 경로를 가리킨다

src/api/**/*.spec.ts
test/
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| common | DI·import | `ConfigService`(`PORT`, `UPLOAD_MAX_FILES`, `UPLOAD_MAX_TOTAL_BYTES`, `UPLOAD_MAX_IMAGE_BYTES`, `UPLOAD_MAX_MD_BYTES`), `DomainError`, `PinoLogger` | common `MODULE.md` | `REQ-BE-7.1`, `REQ-BE-8.3` |
| 모든 기능 모듈 | 앱 조립 | NestJS 모듈 | 각 `MODULE.md` | `REQ-BE-7.1.1` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 요청 처리 | `src/main.ts` (부트스트랩), `AppModule` | 「요청 처리 — REQ-BE-7.1」 | `REQ-BE-7.1.1` |
| 요청 처리 | `PageQueryDto`, `Page<T>`, `toPage()` | 같은 절 | `REQ-BE-7.1.3` |
| 요청 처리 | 전역 `ValidationPipe`, `DomainErrorFilter` | 같은 절, `API.md` 「공통 규약」 | `REQ-BE-7.1.2`, `REQ-BE-8.3` |

## 기능 그룹별 요구사항

### 요청 처리 — `REQ-BE-7.1`

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

/** 도메인 오류와 그 밖의 예외를 오류 응답으로 바꾼다. */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {}

/** 앱 모듈이다. 모든 기능 모듈을 조립한다. */
@Module({})
export class AppModule {}
```

**`REQ-BE-7.1.1`** HTTP로 호출

- 처리 계약: `main.ts`가 `AppModule`로 앱을 만들고, 전역 접두사 없이 각 컨트롤러가 `/v1` 경로를 가진다. 전역 파이프·필터·로거를 붙이고 `PORT`에서 듣는다. 파일 업로드는 multipart로 받으며, 파일 수는 `UPLOAD_MAX_FILES`, 파일 하나는 `max(UPLOAD_MAX_MD_BYTES, UPLOAD_MAX_IMAGE_BYTES)`, 요청 전체는 `UPLOAD_MAX_TOTAL_BYTES`를 넘으면 본문을 끝까지 읽지 않고 `PayloadTooLargeError`로 막는다(`REQ-BE-1.1.10`)
- 충족 기준: 앱이 뜨면 `API.md`의 모든 엔드포인트가 응답하고, 파일 수 한도를 넘는 업로드가 `413`이다

**`REQ-BE-7.1.2`** 형식이 잘못된 요청 거부

- 처리 계약: 전역 `ValidationPipe`(`whitelist`, `forbidNonWhitelisted`, `transform`)의 검증 오류를 `InvalidRequestError`로 바꾼다. 메시지는 문제가 된 필드 이름을 한국어 문장으로 담고 입력값은 담지 않는다
- 충족 기준: 필수 필드가 빠지거나 타입이 다르거나 모르는 필드가 있으면 `400`과 `{"error": {"code": "INVALID_REQUEST", ...}}`이고, 메시지에 입력값이 없다

**`REQ-BE-7.1.3`** 목록은 페이지와 전체 개수

- 충족 기준: 모든 목록 엔드포인트의 응답이 `items`, `total`, `page`, `page_size`를 갖고, 페이지 크기 20·50·100 밖은 `400`이다

`DomainErrorFilter`는 `DomainError`를 `API.md` 「오류 코드」의 상태와 `{"error": {"code", "message"}}`로, 그 밖의 예외를 `500 INTERNAL_ERROR`와 일반 메시지로 바꾸고 스택은 애플리케이션 로그에만 남긴다(`REQ-BE-8.3.1`, `REQ-BE-8.3.2`). 그 충족 기준은 common이 소유하고, 아래 테스트 표가 HTTP 경계에서 함께 본다.

## 실행 계약

### 예외

| 예외 | 발생 조건 | 코드 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `InvalidRequestError` | 요청 검증 실패 | `INVALID_REQUEST` `400` | 발생·변환: api | `REQ-BE-7.1.2` |
| `PayloadTooLargeError` | multipart 한도 초과 | `PAYLOAD_TOO_LARGE` `413` | 발생·변환: api | `REQ-BE-1.1.10` |
| `DomainError` 하위 클래스 | 기능 모듈이 던짐 | 그 `code`와 `API.md`의 상태 | 변환: api | `REQ-BE-8.3.1` |
| 그 밖의 예외 | 예상하지 못한 오류 | `INTERNAL_ERROR` `500` | 변환: api | `REQ-BE-8.3.2` |

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `api.request_invalid` | 요청 검증 실패 | warning | `path`, `fields` (필드 이름만) | `REQ-BE-7.1.2` |
| `api.unhandled` | 그 밖의 예외 | error | `path`, `errorName`, 스택 | `REQ-BE-8.3.2` |

요청 본문과 검증 오류의 입력값은 로그에 넣지 않는다.

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-7.1.1` | e2e | 앱 기동과 엔드포인트 응답, multipart 파일 수 한도 `413` | RAG Server (가짜) | `test/` |
| `REQ-BE-7.1.2` | e2e | 필수 누락·타입 오류·모르는 필드 `400`, 메시지에 입력값 없음 | | `test/` |
| `REQ-BE-7.1.2` | unit | 도메인 오류별 상태·본문, 그 밖은 `500`이고 예외 문자열 없음 (`REQ-BE-8.3` 경계) | | `src/api/**/*.spec.ts` |
| `REQ-BE-7.1.3` | e2e | 목록 응답 형식, 페이지 크기 제약 | | `test/` |
