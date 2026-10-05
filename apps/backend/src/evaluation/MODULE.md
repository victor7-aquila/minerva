# evaluation 모듈 명세 (REQ-BE-5)

골든셋을 저장하고, RAG Server의 평가 API로 골든셋 한 건씩 평가해 기록을 쌓으며, 골든셋 목록과 전체 요약 지표를 준다. 지표 계산은 RAG Server가 하고, 이 모듈은 저장과 요약만 한다. 폴더는 `apps/backend/src/evaluation`다.

## 요약

**핵심 계약**

- 골든셋은 추가와 삭제만 있고 고치지 않는다. 평가 기록은 쌓고, 목록과 요약은 골든셋마다 가장 최근 기록으로 만든다 (`REQ-BE-5.1.3`, `REQ-BE-5.3.2`)
- 평가 중으로 남은 기록이 영원히 남지 않는다. 평가 요청이 끝나면 결과나 평가 실패로 바꾸고, 기동할 때 남은 것은 평가 실패로 바꾼다 (`REQ-BE-5.2.3`, `REQ-BE-5.2.8`)
- 적중·놓침은 연관 청크 확장 후의 Hit@N으로만 정한다 (`REQ-BE-5.2.6`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-5.1` | 골든셋 | 골든셋을 검증해 추가하고, 지우면 기록도 지운다 |
| `REQ-BE-5.2` | 평가 실행 | 골든셋 한 건이나 전체를 RAG Server로 평가해 기록한다 |
| `REQ-BE-5.3` | 조회 | 골든셋 목록과 전체 요약 지표를 준다 |

**비범위**

- 적중·순위·포함 비율의 계산 — RAG Server (`REQ-RAG-6`)

## 구조

### 예상 배치

```text
src/evaluation/
├── index.ts
├── evaluation.module.ts
├── controllers/
│   └── evaluation.controller.ts
├── helpers/
│   ├── answer-span.ts
│   ├── evaluation-outcome.ts
│   ├── evaluation-summary.ts
│   ├── evaluation-views.ts
│   └── golden-set-list.ts
├── interfaces/
│   ├── evaluation.dto.ts
│   └── evaluation.types.ts
├── services/
│   ├── evaluation.service.ts
│   ├── evaluation-crud.service.ts
│   ├── evaluation-tasks.ts
│   └── evaluation-clock.ts
└── MODULE.md

src/evaluation/**/*.spec.ts
test/evaluation.e2e-spec.ts
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| documents | DI | `getRef`, `getEvaluationTarget` | documents `MODULE.md` | `REQ-BE-5.1.2`, `REQ-BE-5.1.5`, `REQ-BE-5.2.7` |
| rag | DI | `RagClient.evaluate`, `RagUnavailableError`, `RagRequestError` | rag `MODULE.md` | `REQ-BE-5.2` |
| storage | DI | `MONGO_DB`(컬렉션 `golden_sets`, `evaluation_records`) | storage `MODULE.md` | `REQ-BE-5` |
| common | DI | 오류 클래스 | common `MODULE.md` | `REQ-BE-5` |
| libs/logger | DI | `PinoLogger` (nestjs-pino) | logger `MODULE.md` | `REQ-BE-8.2.1` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 골든셋 | `POST /v1/golden-sets`, `DELETE /v1/golden-sets/{golden_set_id}` | `API.md` | `REQ-BE-5.1` |
| 평가 실행 | `POST /v1/golden-sets/{golden_set_id}/evaluate`, `POST /v1/golden-sets/evaluate-all` | `API.md` | `REQ-BE-5.2` |
| 조회 | `GET /v1/golden-sets`, `GET /v1/evaluation-summary` | `API.md` | `REQ-BE-5.3` |

## 데이터 계약

### 모델별 필드

**골든셋** (MongoDB `golden_sets`) — 정의: evaluation, 값 생산: evaluation (`REQ-BE-5.1.1`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `goldenSetId` | `string` | 필수 | 고유 |
| `query`, `answerSpan` | `string` | 필수 | 비어 있지 않다. 만든 뒤 바뀌지 않는다 |
| `docId` | `string` | 필수 | 정답 문서 |
| `editionOnly` | `boolean` | 필수 | 참이면 정답 문서에 판 정보가 있었다 |
| `createdAt` | `Date` | 필수 | |

**평가 기록** (MongoDB `evaluation_records`) — 정의: evaluation, 값 생산: evaluation (`REQ-BE-5.2.2`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `recordId` | `string` | 필수 | 고유. Backend가 정한 소문자 UUID |
| `goldenSetId` | `string` | 필수 | |
| `outcome` | `'evaluating' \| 'hit' \| 'miss' \| 'error'` | 필수 | `evaluating`에서 다른 값으로 한 번만 바뀐다 |
| `n` | `number \| null` | 조건부 | `hit`·`miss`면 RAG Server가 준 N |
| `base`, `expanded` | 지표 \| `null` | 조건부 | `hit`·`miss`면 RAG Server 응답 그대로(rag의 `RagEvaluationMetrics` 모양으로 저장하고 응답에서 `EvaluationMetrics`로 바꾼다) |
| `errorMessage` | `string \| null` | 조건부 | `error`면 한국어 사유 |
| `startedAt` | `Date` | 필수 | 앞서 만든 기록보다 늦다(같은 밀리초에 만들어도 1ms 이상 늘린다) |
| `evaluatedAt` | `Date \| null` | 조건부 | `evaluating`이 아니면 값이 있다 |

골든셋의 가장 최근 기록은 그 골든셋 기록 중 `startedAt`이 가장 늦은 기록이다. 응답 형식(`GoldenSet`, `EvaluationRecord`, `EvaluationSummary`)은 `API.md`가 소유한다. `GoldenSet.answer`의 이름·판은 `documents.getRef`로 채우며, 삭제된 문서도 이름·판이 나온다.

## 기능 그룹별 요구사항

### 골든셋 — `REQ-BE-5.1`

**`REQ-BE-5.1.1`** 골든셋 추가

- 처리 계약: `query`·`answer_span`·`doc_id`가 없거나 공백뿐이면 `400 INVALID_REQUEST`다. 그다음 정답 문서가 없거나 삭제됨(`404`), 검색 가능이 아님(`REQ-BE-5.1.2`, `409`), `edition_only`가 참인데 정답 문서에 판 정보가 없음(`400 INVALID_REQUEST`), 정답 구간 없음(`REQ-BE-5.1.5`, `400`) 순서로 보고, 모두 통과하면 `evaluating` 기록과 골든셋을 이 순서로 저장하고 응답한 뒤 평가를 시작한다(`REQ-BE-5.2.1`). `doc_id`의 형식은 따로 검사하지 않는다(형식이 다르면 문서가 없다). `query`·`answer_span`은 다듬지 않고 저장하며, `edition_only`가 빠지거나 `null`이면 `false`다
- 실패: 정답 문서가 없거나 삭제됐으면 `DocumentNotFoundError`, 판 정보 없는 문서에 `edition_only`가 참이면 `InvalidRequestError`
- 충족 기준: 올바른 요청이 `201`과 `latest.outcome: evaluating`을 받고, 없는 문서는 `404`, 판 정보 없는 문서에 `edition_only: true`는 `400`이다

**`REQ-BE-5.1.2`** 검색 가능이 아닌 정답 문서 거부

- 실패: `DocumentNotSearchableError`
- 충족 기준: 검색 안 됨·교체됨 문서를 정답 문서로 주면 `409 DOCUMENT_NOT_SEARCHABLE`이고 골든셋이 생기지 않는다

**`REQ-BE-5.1.5`** 정답 구간이 색인용 MD에 있어야 함

- 처리 계약: `getEvaluationTarget`의 색인용 MD에서 자리표시(루트 `IF-1`)를 모두 지우고 그 자리를 구간이 넘을 수 없는 경계로 둔 뒤, 공백 문자를 모두 지운 정답 구간이 같은 방식으로 공백을 지운 본문의 한 경계 구역 안에 들어 있는지 본다. 자리표시는 루트 `IF-1` 형식(`[[minerva:{kind}:{placeholder_id} | {description}]]`)과 정확히 맞는 문자열이다. 공백 문자는 유니코드 공백(줄바꿈·탭·NBSP 포함)이고, 자리표시 모양 문자열을 깨뜨린 U+200B(`REQ-BE-2.2.2`)는 공백이 아니라 지우지 않는다. 검색되는 버전의 색인용 MD가 없으면 구간이 없는 것으로 본다
- 실패: `AnswerSpanNotFoundError`
- 충족 기준: 줄바꿈 위치만 다른 구간은 받고, 본문에 없는 구간과 표 자리표시의 설명 글자로 된 구간과 자리표시를 가로지르는 구간은 `400 ANSWER_SPAN_NOT_FOUND`다

**`REQ-BE-5.1.3`** 고치지 않음

- 충족 기준: 골든셋을 고치는 엔드포인트가 없다(`PATCH`·`PUT /v1/golden-sets/{id}`가 `404`)

**`REQ-BE-5.1.4`** 지우면 기록도 지움

- 처리 계약: 골든셋을 먼저 지우고 그 기록을 지운다. 진행 중이던 평가는 끝나도 지운 기록을 되살리지 않는다
- 실패: 없는 골든셋이면 `GoldenSetNotFoundError`
- 충족 기준: 지운 뒤 그 골든셋과 기록이 모두 없고, 요약에서 빠진다

### 평가 실행 — `REQ-BE-5.2`

**`REQ-BE-5.2.1`** 추가하면 바로 평가

- 충족 기준: 추가 응답 뒤 RAG Server에 그 골든셋의 평가 요청이 간다

**`REQ-BE-5.2.2`** 지표와 N 기록

- 처리 계약: `RagClient.evaluate`에 질의, 정답 문서 ID, 정답 구간, 판 지정 여부를 보내고(`top_n`은 보내지 않아 RAG Server 기본 개수를 쓴다), 응답의 `n`·`base`·`expanded`를 그대로 기록한다
- 충족 기준: 기록의 `n`·`base`·`expanded`가 RAG Server 응답과 같다

**`REQ-BE-5.2.3`** 평가하지 못하면 평가 실패

- 처리 계약: `RagUnavailableError`는 "RAG Server에 연결할 수 없습니다", `RagRequestError`는 코드 `DOCUMENT_NOT_SEARCHABLE`이면 "정답 문서가 검색되지 않습니다", `VECTOR_DIMENSION_MISMATCH`면 "저장된 벡터와 임베딩 모델의 차원이 달라 평가하지 못했습니다", 그 밖의 4xx면 "RAG Server가 평가 요청을 받지 않았습니다", 그 밖의 5xx면 "RAG Server가 평가 중 오류를 냈습니다", 그 밖의 예외(정답 문서 조회 실패 포함)는 "평가 중 예상하지 못한 오류가 발생했습니다"로 `error` 기록을 남긴다. 사유에 RAG Server의 오류 코드·메시지를 넣지 않는다
- 충족 기준: RAG Server가 닿지 않거나 `409`를 주면 기록이 `error`와 사유를 갖는다

**`REQ-BE-5.2.4`** 한 건·전체 다시 평가

- 처리 계약: 다시 평가할 때마다 새 `evaluating` 기록을 만든다. 평가 중인 골든셋의 한 건 다시 평가도 받는다. 전체 다시 평가는 응답 전에 모든 골든셋의 `evaluating` 기록을 만들고, 응답 뒤 골든셋을 추가 이른 순으로 하나씩 차례로 평가한다. 한 건이 실패해도 다음 건으로 가며, 서버가 종료 중이면 남은 건을 평가하지 않는다(`REQ-BE-5.2.8`이 정리한다)
- 평가 실행 단계: 평가를 시작할 때 그 기록이 아직 `evaluating`인지 확인하고(아니면 RAG Server를 부르지 않고 끝낸다), 이어서 골든셋이 지워졌는지 확인한다. 골든셋이 지워졌으면 RAG Server를 부르지 않고 그 골든셋의 기록을 모두 지운 뒤 `evaluation.orphan_cleaned`만 남기고 끝낸다(`evaluation.done` 없음). 골든셋 삭제와 겹쳐 뒤늦게 만들어진 기록이 남지 않게 하기 위해서다
- 실패: 한 건 다시 평가에서 없는 골든셋이면 `GoldenSetNotFoundError`
- 충족 기준: 한 건 다시 평가가 그 골든셋에 새 기록을, 전체 다시 평가가 모든 골든셋에 새 기록을 하나씩 남긴다

**`REQ-BE-5.2.5`** 평가 중이면 전체 다시 평가 거부

- 처리 계약: 다른 전체 다시 평가 요청이 기록을 만드는 중이어도 거부한다
- 실패: `EvaluationInProgressError`
- 충족 기준: 최근 기록이 `evaluating`인 골든셋이 하나라도 있으면 `409 EVALUATION_IN_PROGRESS`이고 새 기록이 생기지 않는다

**`REQ-BE-5.2.6`** 확장 후 Hit@N으로 적중·놓침

- 충족 기준: `expanded.hit_at_n`이 참이면 `hit`, 거짓이면 `miss`이며, `base`가 놓침이어도 `expanded`가 적중이면 `hit`이다

**`REQ-BE-5.2.7`** 정답 문서가 검색 가능이 아니면 요청 없이 평가 실패

- 처리 계약: 평가 직전에 `getEvaluationTarget`을 보고 검색 가능이 아니거나 삭제됐으면 RAG Server를 부르지 않고 "정답 문서가 검색되지 않습니다"로 `error` 기록을 남긴다
- 충족 기준: 정답 문서가 교체·삭제된 골든셋을 다시 평가하면 RAG Server 호출 없이 `error`와 그 사유다

**`REQ-BE-5.2.8`** 기동 때 남은 평가 중 기록 정리

- 처리 계약: 기동할 때(요청을 받기 전) `evaluating` 기록을 모두 "서버가 다시 시작해 평가하지 못했습니다"로 `error`로 바꾸고 평가 시각을 기동 시각으로 둔다
- 충족 기준: `evaluating` 기록이 남은 채 기동하면 모두 `error`가 되고, 그 뒤 전체 다시 평가가 거부되지 않는다

### 조회 — `REQ-BE-5.3`

**`REQ-BE-5.3.1`** 골든셋 목록

- 처리 계약: 결과(`hit`·`miss`, 빠지면 전체)로 거르고, 결과·정답 순위(`expanded.rank`)·포함 비율(`expanded.coverage`)·평가 시각·추가 시각 중 한 열로 정렬해 페이지로 준다. 정렬 값은 결과(적중 > 놓침, 평가 중·실패는 값 없음), 정답 순위(`expanded.rank`), 포함 비율(`expanded.coverage`), 평가 시각(평가 중은 값 없음), 추가 시각이다. 값이 없는 행은 `order`와 관계없이 맨 뒤에 두고, 같은 값끼리는 추가 늦은 순이다
- 충족 기준: 적중만 거르면 최근 기록이 `hit`인 골든셋만 나오고, 정답 순위로 정렬하면 평가 중 행이 뒤에 온다

**`REQ-BE-5.3.2`** 골든셋마다 최근 결과

- 충족 기준: 기록이 셋인 골든셋의 `latest`가 가장 최근 기록이다

**`REQ-BE-5.3.3`** 요약 지표

- 처리 계약: 골든셋마다 최근 기록 중 `hit`·`miss`인 것만으로 확장 전·후 각각 Hit@1·3·5·N 비율과 MRR(역순위 평균)을 계산한다. `n`과 마지막 평가 시각은 그 기록들 중 평가 시각이 가장 늦은 기록의 값이다. 골든셋 수와 평가 중 건수를 함께 준다. 계산할 기록이 없으면 비율·MRR·`n`은 0이고 마지막 평가 시각은 `null`이다
- 충족 기준: 최근 결과가 적중(순위 1)·놓침·평가 실패인 골든셋 셋이면 `hit_at_1`이 0.5, `mrr`이 0.5이고 평가 실패는 분모에서 빠진다

## 실행 계약

### 예외

| 예외 | 발생 조건 | 코드 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `InvalidRequestError` | 판 정보가 없는 정답 문서에 `edition_only`가 참이다 | `INVALID_REQUEST` | 발생: evaluation | `REQ-BE-5.1.1` |
| `DocumentNotFoundError` | 정답 문서가 없거나 삭제됐다 | `DOCUMENT_NOT_FOUND` | 발생: evaluation | `REQ-BE-5.1.1` |
| `DocumentNotSearchableError` | 정답 문서가 검색 가능이 아니다 | `DOCUMENT_NOT_SEARCHABLE` | 발생: evaluation | `REQ-BE-5.1.2` |
| `AnswerSpanNotFoundError` | 정답 구간이 색인용 MD에 없다 | `ANSWER_SPAN_NOT_FOUND` | 발생: evaluation | `REQ-BE-5.1.5` |
| `GoldenSetNotFoundError` | 골든셋이 없다 | `GOLDEN_SET_NOT_FOUND` | 발생: evaluation | `REQ-BE-5.1.4`, `REQ-BE-5.2.4` |
| `EvaluationInProgressError` | 평가 중인 골든셋이 있다 | `EVALUATION_IN_PROGRESS` | 발생: evaluation | `REQ-BE-5.2.5` |

평가 요청의 실패는 예외로 내보내지 않고 `error` 기록으로 바꾼다(`REQ-BE-5.2.3`).

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `evaluation.done` | 평가 한 건 끝 | info | `goldenSetId`, `outcome`, `rank`, `elapsedMs` | `REQ-BE-5.2` |
| `evaluation.restart_cleanup` | 기동 때 정리 | warning | `count` | `REQ-BE-5.2.8` |
| `evaluation.orphan_cleaned` | 골든셋이 지워진 평가 중 기록을 정리 | info | `goldenSetId`, `removed` | `REQ-BE-5.2.4` |
| `evaluation.task_failed` | 평가 백그라운드 작업 실패(기록 저장 실패 등) | warning | `task`, `goldenSetId`, `errorName` | `REQ-BE-5.2` |

`evaluation.done`은 기록을 실제로 끝냈을 때만 남기고, `rank`는 `expanded.rank`(평가 실패면 `null`)다. `evaluation.restart_cleanup`은 바꾼 기록이 있을 때만 남긴다. `evaluation.orphan_cleaned`는 `removed`가 지운 기록 건수이며 정리 분기를 탈 때마다 남긴다. 질의와 정답 구간은 로그에 넣지 않는다.

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-5.1.1` | e2e | 추가와 평가 중 응답, 없는 문서 `404`, 판 정보 없는데 판 지정 `400` | RAG Server (가짜) | `test/` |
| `REQ-BE-5.1.2` | unit | 검색 가능이 아닌 문서 거부 | documents (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.1.5` | unit | 공백 무시, 없는 구간·자리표시 설명·자리표시 가로지름 거부 | documents (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.1.3` | e2e | 고치는 엔드포인트 없음 | | `test/` |
| `REQ-BE-5.1.4` | unit | 삭제와 기록 삭제, 없는 골든셋 | `MONGO_DB` (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.1` | unit | 추가 뒤 평가 요청 | rag (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.2` | unit | 지표와 N 기록 | rag (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.3` | unit | 연결 불가·오류 응답 시 평가 실패와 사유 | rag (가짜, 실패) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.4` | unit | 한 건·전체 새 기록 | rag (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.5` | unit | 평가 중이면 전체 거부 | `MONGO_DB` (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.6` | unit | 확장 후 Hit@N으로 판정 | rag (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.7` | unit | 검색 불가 문서는 호출 없이 평가 실패 | documents·rag (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.2.8` | unit | 기동 때 평가 중 기록 정리 | `MONGO_DB` (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.3.1` | e2e | 거르기, 정렬, 값 없는 행 맨 뒤 | | `test/` |
| `REQ-BE-5.3.2` | unit | 최근 기록 | `MONGO_DB` (가짜) | `src/evaluation/**/*.spec.ts` |
| `REQ-BE-5.3.3` | unit | 비율·MRR 계산, 분모 규칙, 기록 없음 | `MONGO_DB` (가짜) | `src/evaluation/**/*.spec.ts` |
