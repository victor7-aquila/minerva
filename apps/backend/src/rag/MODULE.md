# rag 모듈 명세 (REQ-BE-10)

RAG Server HTTP API(`apps/rag-server/API.md`)를 부르는 Backend의 유일한 클라이언트다. 주소·토큰·시간 제한을 한 곳에서 지키고, 연결 실패와 RAG Server의 오류 응답을 Backend가 다루는 오류로 바꾼다. 폴더는 `apps/backend/src/rag`다.

## 요약

**핵심 계약**

- RAG Server 호출은 이 모듈만 한다. 모든 호출에 API 토큰 헤더와 시간 제한이 붙는다 (`REQ-BE-10.1.1`, `REQ-BE-10.1.3`, `REQ-BE-10.1.4`, `ARCHITECT.md` 「의존 규칙」)
- 응답하지 않음·시간 초과·`503`은 모두 `RagUnavailableError`다. 그 밖의 오류 응답은 RAG Server의 오류 코드를 담은 `RagRequestError`로 넘겨, 부른 모듈이 코드로 판단한다 (`REQ-BE-10.1.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-10.1` | RAG Server 호출 | RAG Server API를 타입이 붙은 메서드로 제공하고, 주소·토큰·시간 제한·오류 변환을 지킨다 |

**비범위**

- 호출 결과로 문서 상태를 바꾸거나 다시 시도하는 일 — 부른 모듈(documents, assets, indexing, search, evaluation)
- RAG Server가 보내는 작업 상태 알림 받기 — indexing (`REQ-BE-3.2`)

## 구조

### 예상 배치

```text
src/rag/
└── MODULE.md

src/rag/**/*.spec.ts
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| RAG Server | HTTP | 모든 엔드포인트, `X-Minerva-Token` | `apps/rag-server/API.md` | `REQ-BE-10.1` |
| common | DI | `ConfigService`(`RAG_SERVER_URL`, `RAG_SERVER_API_TOKEN`, `RAG_TIMEOUT_MS`, `RAG_CAPTION_TIMEOUT_MS`), `PinoLogger`, `RagUnavailableError` | common `MODULE.md` | `REQ-BE-10.1` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| RAG Server 호출 | `RagModule`, `RagClient`, `RagRequestError` | 「RAG Server 호출 — REQ-BE-10.1」 | `REQ-BE-10.1` |
| RAG Server 호출 | `RagIndexJobAccepted`, `RagIndexJob`, `RagIndexState`, `RagDocumentChunks`, `RagSearchResult`, `RagEvaluationResult` 등 응답 타입 | `apps/rag-server/API.md` 「공용 모델」 | `REQ-BE-10.1` |

응답 타입은 `apps/rag-server/API.md`의 공용 모델을 TypeScript로 옮긴 것이며, 필드 이름은 camelCase로 바꾼다. 필드의 뜻은 그 문서가 소유한다.

## 기능 그룹별 요구사항

### RAG Server 호출 — `REQ-BE-10.1`

```typescript
/** RAG Server가 4xx·5xx(503 제외)로 응답했다. code는 RAG Server의 오류 코드다. */
export class RagRequestError extends Error {
  readonly status: number;
  readonly code: string;
}

/** RAG Server API 클라이언트다. */
@Injectable()
export class RagClient {
  summarizeTable(tableMarkdown: string): Promise<string>;
  captionImage(image: Buffer, fileName: string): Promise<string>;
  submitIndexJob(req: RagIndexRequest): Promise<RagIndexJobAccepted>;
  getIndexJob(jobId: string): Promise<RagIndexJob>;
  deleteDocument(docId: string): Promise<void>;
  getIndexState(docId: string): Promise<RagIndexState>;
  getIndexStates(docIds: readonly string[]): Promise<RagIndexState[]>;
  updateMetadata(docId: string, name: string, edition: RagEdition | null): Promise<void>;
  getDocumentChunks(docId: string): Promise<RagDocumentChunks>;
  search(req: RagSearchRequest): Promise<RagSearchResult[]>;
  evaluate(req: RagEvaluationRequest): Promise<RagEvaluationResult>;
}
```

- 메서드 하나가 `apps/rag-server/API.md`의 엔드포인트 하나다. 상태 확인은 Backend가 부르지 않으므로 메서드가 없다
- `getIndexStates`는 `doc_ids`를 100개씩 나눠 부르고 결과를 받은 순서대로 이어 돌려준다(`apps/rag-server/API.md`의 1~100개 제약)

**`REQ-BE-10.1.1`** 설정한 주소로 호출

- 충족 기준: 모든 메서드가 `RAG_SERVER_URL`을 앞에 붙인 `API.md`의 경로·메서드로 요청한다

**`REQ-BE-10.1.2`** 응답하지 않거나 준비 중이면 오류

- 처리 계약: 연결 실패, 시간 초과, `503` 응답은 `RagUnavailableError`로 바꾼다. 그 밖의 `4xx`·`5xx`는 응답 본문의 `error.code`로 `RagRequestError`를 낸다. 이 모듈은 다시 시도하지 않는다
- 충족 기준: 연결 거부·시간 초과·`503 SERVER_NOT_READY`에서 `RagUnavailableError`가, `409 DOCUMENT_NOT_SEARCHABLE`에서 `code`가 그 값인 `RagRequestError`가 난다

**`REQ-BE-10.1.3`** 호출마다 시간 제한

- 처리 계약: `summarizeTable`·`captionImage`는 `RAG_CAPTION_TIMEOUT_MS`, 나머지는 `RAG_TIMEOUT_MS`를 시간 제한으로 둔다
- 충족 기준: 제한보다 늦게 답하는 가짜 서버에서 각 메서드가 그 제한에서 `RagUnavailableError`를 낸다

**`REQ-BE-10.1.4`** API 토큰을 담아 호출

- 충족 기준: 모든 요청의 `X-Minerva-Token` 헤더가 `RAG_SERVER_API_TOKEN`과 같다

## 실행 계약

### 설정

정의는 common 「설정」이 소유한다. 이 모듈이 읽는 키: `RAG_SERVER_URL`, `RAG_SERVER_API_TOKEN`, `RAG_TIMEOUT_MS`, `RAG_CAPTION_TIMEOUT_MS`.

### 예외

| 예외 | 발생 조건 | 코드 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `RagUnavailableError` | 연결 실패, 시간 초과, `503` | `RAG_UNAVAILABLE` | 발생: rag. 부른 모듈이 그대로 전파하거나 상태로 바꾼다 | `REQ-BE-10.1.2` |
| `RagRequestError` | 그 밖의 오류 응답 | 경계 밖으로 그대로 나가지 않는다 | 발생: rag. 부른 모듈이 `code`로 판단한다 | `REQ-BE-10.1.2` |

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `rag.call_failed` | 호출 실패 | warning | `operation`, `status`, `code`, `elapsedMs` | `REQ-BE-10.1.2` |

요청 본문(색인용 MD, 질의, 정답 구간, 표 Markdown)과 토큰은 로그에 넣지 않는다.

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-10.1.1` | unit | 메서드별 경로·메서드·본문 | RAG Server (가짜 HTTP) | `src/rag/**/*.spec.ts` |
| `REQ-BE-10.1.2` | unit | 연결 거부·시간 초과·503은 `RagUnavailableError`, 그 밖은 `RagRequestError`와 코드 | RAG Server (가짜 HTTP) | `src/rag/**/*.spec.ts` |
| `REQ-BE-10.1.3` | unit | 요약·캡션과 나머지의 시간 제한 | RAG Server (가짜 HTTP, 지연) | `src/rag/**/*.spec.ts` |
| `REQ-BE-10.1.4` | unit | 모든 요청의 토큰 헤더 | RAG Server (가짜 HTTP) | `src/rag/**/*.spec.ts` |
