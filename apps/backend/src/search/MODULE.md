# search 모듈 명세 (REQ-BE-4)

AI 에이전트·개발 도구의 검색 요청을 RAG Server에 넘기고, 결과에서 삭제됨·교체됨 문서를 빼고, 자리표시를 원래 표·이미지로 복원해 돌려준다. 답변 문장은 만들지 않는다. 폴더는 `apps/backend/src/search`다.

## 요약

**핵심 계약**

- 결과의 자리표시는 RAG Server가 그 결과에 붙인 버전의 표·이미지로 복원한다. 새 버전 처리 중이어도 검색되는 버전의 표·이미지가 나온다 (`REQ-BE-4.2.1`, `REQ-BE-2.5.3`)
- 삭제됨·교체됨 문서의 결과는 RAG Server에서 지워지기 전이라도 응답에서 뺀다 (`REQ-BE-4.2.2`)
- 답변 문장을 만들지 않는다. 이 모듈은 LLM을 부르지 않는다 (`REQ-BE-4.1.3`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-4.1` | 검색 요청 | 검색 조건을 받아 문서 이름 범위를 문서 ID로 바꿔 RAG Server에 넘긴다 |
| `REQ-BE-4.2` | 결과 복원 | 보이지 않을 문서를 빼고 자리표시를 복원해 결과를 만든다 |

## 구조

### 예상 배치

```text
src/search/
├── index.ts
├── search.module.ts
├── controllers/
│   └── search.controller.ts
├── helpers/
│   └── search-results.ts
├── interfaces/
│   ├── search.dto.ts
│   └── search.types.ts
├── services/
│   └── search.service.ts
└── MODULE.md

src/search/**/*.spec.ts
test/search.e2e-spec.ts
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| documents | DI | `resolveNames`, `visibleDocIds` | documents `MODULE.md` | `REQ-BE-4.1.2`, `REQ-BE-4.2.2` |
| assets | DI | `restore` | assets `MODULE.md` | `REQ-BE-4.2.1` |
| rag | DI | `RagClient.search` | rag `MODULE.md` | `REQ-BE-4.1.2` |
| common | import | `RagUnavailableError` | common `MODULE.md` | `REQ-BE-4` |
| libs/logger | DI | `PinoLogger` (nestjs-pino) | logger `MODULE.md` | `REQ-BE-8.2.1` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 검색 요청, 결과 복원 | `POST /v1/search` | `API.md` | `REQ-BE-4` |

## 기능 그룹별 요구사항

요청·응답 형식(`SearchResult`)은 `API.md`가 소유한다.

### 검색 요청 — `REQ-BE-4.1`

**`REQ-BE-4.1.1`** 검색 조건

- 처리 계약: 질의, 결과 개수(1~50, 빠지면 RAG Server 기본값), 문서 이름 범위, 판 범위, 앞뒤 청크 포함을 받는다. `edition_scope`가 `specific`인데 `edition`이 없으면 `400`이다. `query`가 공백뿐이면 `400`이다. `edition_scope`·`expand_neighbors`가 빠지거나 `null`이면 Backend 기본값(`all`·`false`)을 채워 보내고, `top_n`이 빠지거나 `null`이면 보내지 않는다. `edition`은 `edition_scope`가 `specific`일 때만 보낸다(그 밖에는 형식만 검증한다). `names`의 각 이름과 `edition`의 `name`·`label`은 앞뒤 공백을 뗀 값으로 넘기며, 공백뿐이면 `400`이다
- 충족 기준: 각 조건이 RAG Server 요청의 대응 필드로 넘어가고, `top_n`이 51이면 `400`이다

**`REQ-BE-4.1.2`** 이름 범위를 문서 ID로

- 처리 계약: `names`가 있으면 `resolveNames`로 바꾼 문서 ID를 `doc_ids`로 넘긴다. 바꾼 결과가 비면 RAG Server를 부르지 않고 빈 결과를 준다. `names`가 `null`이면 빠진 것과 같다. `names`가 빈 배열이면 바꾼 결과가 비므로 빈 결과다
- 충족 기준: 판이 둘인 이름을 주면 두 문서 ID가 넘어가고, 없는 이름만 주면 RAG Server 호출 없이 빈 결과다

**`REQ-BE-4.1.3`** 답변 문장 없음

- 충족 기준: 응답이 결과 목록뿐이고, 결과 본문이 RAG Server가 준 청크를 복원한 것뿐이다

### 결과 복원 — `REQ-BE-4.2`

**`REQ-BE-4.2.1`** 자리표시 복원

- 처리 계약: 결과의 `chunks`·`before`·`after` 본문마다 `restore(docId, 결과의 version, text)`를 부른다. `markdown`은 복원한 `chunks` 본문을 순서대로 줄바꿈 하나로 이은 것이고, `before`·`after`는 복원한 본문의 배열이다(`API.md`의 `SearchResult`)
- 충족 기준: 표·이미지 자리표시가 든 결과가 원래 표와 `![캡션](이미지 주소)`로 바뀌어 나오고, 세 조각으로 나뉜 청크의 `markdown`이 세 조각을 순서대로 이은 것이다

**`REQ-BE-4.2.2`** 삭제됨·교체됨 결과 빼기

- 처리 계약: 결과의 문서 ID를 `visibleDocIds`로 걸러 빠진 문서의 결과를 지우고, 남은 결과의 순위를 1부터 다시 매긴다. 순위는 RAG Server의 `rank` 순서로 다시 매긴다. `top_n`은 그대로 넘기므로 뺀 만큼 결과가 적다
- 충족 기준: RAG Server가 교체됨 문서의 결과를 2위로 주면 응답에 없고, 3위였던 결과가 2위가 된다

**`REQ-BE-4.2.3`** 결과 필드

- 처리 계약: `other_editions_in_results`는 RAG Server 값이 참이고, 남은 결과 중 이름이 같고 같은 판이 아닌(판 표기가 다르거나 판 정보가 없는) 다른 결과가 있을 때만 참이다. `is_latest`는 RAG Server 값을 그대로 쓴다 — 삭제됨·교체됨 문서의 청크가 RAG Server에서 지워지기 전에는 그 문서를 센 값일 수 있다
- 충족 기준: 결과마다 순위, 점수, 문서 이름, 판 표기, 최신판 여부, 다른 판 표시, 헤딩 경로가 `API.md`의 `SearchResult` 형식으로 있다

## 실행 계약

### 예외

| 예외 | 발생 조건 | 코드 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `RagUnavailableError` | RAG Server가 응답하지 않거나 준비 중 | `RAG_UNAVAILABLE` | 발생: rag. 전파: search | `REQ-BE-10.1.2` |
| `RagRequestError` | RAG Server가 그 밖의 오류로 응답 | `RAG_UNAVAILABLE` | 발생: rag. search가 `RagUnavailableError`로 바꿔 던진다 | `REQ-BE-10.1.2` |

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `search.done` | 검색 끝 | info | `queryChars`, `names`, `ragResults`, `removed`, `elapsedMs` | `REQ-BE-4` |

`queryChars`는 질의의 글자(코드 포인트) 수, `names`는 요청한 이름 개수(없으면 `null`), `ragResults`는 RAG Server가 준 결과 수(부르지 않았으면 0), `removed`는 뺀 결과 수다. 이름 목록은 넣지 않는다

질의 원문과 결과 본문은 로그에 넣지 않는다.

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-4.1.1` | e2e | 조건 전달, 범위 밖 `top_n`·판 지정 누락 `400` | RAG Server (가짜) | `test/` |
| `REQ-BE-4.1.2` | unit | 이름 → 문서 ID, 빈 결과면 호출 없음 | documents·rag (가짜) | `src/search/**/*.spec.ts` |
| `REQ-BE-4.1.3` | unit | 응답이 복원한 결과뿐 | rag·assets (가짜) | `src/search/**/*.spec.ts` |
| `REQ-BE-4.2.1` | unit | 결과 버전으로 복원 | rag·assets (가짜) | `src/search/**/*.spec.ts` |
| `REQ-BE-4.2.2` | unit | 삭제됨·교체됨 제거와 순위 다시 매김 | documents·rag (가짜) | `src/search/**/*.spec.ts` |
| `REQ-BE-4.2.3` | unit | 결과 필드, 버전 필드 없음 | rag (가짜) | `src/search/**/*.spec.ts` |
