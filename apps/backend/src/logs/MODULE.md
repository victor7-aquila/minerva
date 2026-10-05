# logs 모듈 명세 (REQ-BE-6)

문서에 일어난 일(업로드, 내용 다시 올리기, 요약·캡션 생성, 처리 상태 변경, 편집, 삭제, 교체)을 기록하고, Console이 조회하게 하며, 보관 기간이 지난 기록을 지운다. 애플리케이션 로그(logger 라이브러리)와 다른, 관리자가 보는 기록이다. 폴더는 `apps/backend/src/logs`다.

## 요약

**핵심 계약**

- 기록의 한 줄 설명은 이 모듈이 정한 문장 틀로만 만든다. 부르는 모듈은 종류와 사유 코드만 넘기므로 문서 본문·질의가 기록에 들어갈 길이 없다 (`REQ-BE-6.1.3`)
- 기록에는 그 시점의 문서 이름·판 표기를 함께 남긴다. 문서가 삭제되거나 이름이 바뀌어도 기록은 그대로 읽힌다 (`REQ-BE-6.1.2`, `REQ-BE-1.8.6`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-6.1` | 기록 | 문서 기록을 정해진 필드와 문장 틀로 남긴다 |
| `REQ-BE-6.2` | 조회 | 기록을 거르고 정렬해 페이지로 준다 |
| `REQ-BE-6.3` | 보관 | 보관 기간이 지난 기록을 지운다 |

**비범위**

- 언제 무엇을 기록할지 — 일이 일어난 모듈(documents, assets). 처리 상태 변경은 실제로 바뀐 경우에만 documents가 부른다(`IF-BE-1`)

## 구조

### 예상 배치

```text
src/logs/
├── index.ts
├── logs.module.ts
├── controllers/
│   └── logs.controller.ts
├── helpers/
│   └── log-description.ts
├── interfaces/
│   ├── list-logs-query.dto.ts
│   └── logs.types.ts
├── services/
│   ├── logs.service.ts
│   └── logs-crud.service.ts
└── MODULE.md

src/logs/**/*.spec.ts
test/
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| storage | DI | `MONGO_DB` (컬렉션 `logs`) | storage `MODULE.md` | `REQ-BE-6` |
| common | DI·import | `ConfigService`(`LOG_RETENTION_DAYS`), `parseKstDayRange`, `ProcessingState` | common `MODULE.md` | `REQ-BE-6.2.2`, `REQ-BE-6.3.1` |
| libs/logger | DI | `PinoLogger` (nestjs-pino) | logger `MODULE.md` | `REQ-BE-8.2.1` |
| libs/utils | import | `toIsoUtc`, 페이지 규약(`PageQueryDto`, `Page<T>`, `toPage()`) | utils `MODULE.md` | `REQ-BE-6.2`, `REQ-BE-8.4.1`, `REQ-BE-7.1.3` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 기록 | `LogsService.record`, `LogInput`, `LogKind` | 「기록 — REQ-BE-6.1」 | `REQ-BE-6.1` |
| 조회 | `GET /v1/logs` | `API.md` | `REQ-BE-6.2` |

## 데이터 계약

### 모델별 필드

**기록** (MongoDB `logs`) — 정의: logs, 값 생산: logs (`REQ-BE-6.1.2`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `logId` | `string` | 필수 | 고유 |
| `occurredAt` | `Date` | 필수 | 기록한 시각. TTL 인덱스의 기준 |
| `kind` | `LogKind` | 필수 | |
| `docId` | `string` | 필수 | |
| `name` | `string` | 필수 | 기록 시점의 문서 이름 |
| `editionLabel` | `string \| null` | 필수 | 기록 시점의 판 표기 |
| `outcome` | `'success' \| 'failure'` | 필수 | |
| `description` | `string` | 필수 | 「문장 틀」로 만든 한 줄 |

응답 형식(`LogEntry`)은 `API.md`가 소유한다.

## 기능 그룹별 요구사항

### 기록 — `REQ-BE-6.1`

```typescript
export type LogKind =
  | 'upload' | 'content_upload' | 'captioning' | 'processing_state'
  | 'edit' | 'delete' | 'replace';

/** 기록 하나의 입력이다. 자유 문장은 받지 않는다. */
export interface LogInput {
  kind: LogKind;
  docId: string;
  name: string;
  editionLabel: string | null;
  outcome: 'success' | 'failure';
  detail?: LogDetail;
}

/** 문장 틀에 넣는 값이다. 모두 코드·개수·상태 이름이다. */
export interface LogDetail {
  fromState?: ProcessingState;
  toState?: ProcessingState;
  reasonCode?: string;
  count?: number;
  failedCount?: number;
  changedFields?: ReadonlyArray<'name' | 'edition' | 'hints'>;
  replacedByDocId?: string;
}

/** 문서 기록을 남긴다. */
@Injectable()
export class LogsService {
  record(input: LogInput): Promise<void>;
}
```

**`REQ-BE-6.1.1`** 기록하는 일

- 처리 계약: `LogKind`의 일곱 종류를 받는다. 기록 실패는 부른 쪽 처리를 실패시키지 않고 애플리케이션 로그에 경고로 남긴다
- 충족 기준: 일곱 종류 각각으로 `record`하면 그 종류의 기록이 하나 생기고, 저장이 실패해도 `record`가 예외를 내지 않는다

**`REQ-BE-6.1.2`** 기록 필드

- 충족 기준: 기록에 시각, 종류, 문서 ID·이름·판 표기, 결과, 한 줄 설명이 있고, 설명이 「문장 틀」의 그 종류 문장이다

**`REQ-BE-6.1.3`** 본문·청크·질의 비기록

- 처리 계약: `description`은 「문장 틀」과 `LogDetail`의 코드·개수·상태 이름으로만 만든다. `LogInput`에는 자유 문장 필드가 없다
- 충족 기준: 모든 종류의 설명이 틀 문장과 `LogDetail` 값만으로 이루어진다(타입으로 자유 문장을 넘길 수 없다)

### 조회 — `REQ-BE-6.2`

요청·응답 형식은 `API.md`의 `GET /v1/logs`가 소유한다.

응답의 `document_deleted`는 같은 `docId`의 `delete` 기록이 있으면(결과와 상관없이) 참이다. 삭제 기록은 documents가 남긴다(`REQ-BE-6.1.1`).

**`REQ-BE-6.2.1`** 페이지와 정렬

- 충족 기준: 시각·종류·결과 열로 오름·내림차순 정렬하고 페이지로 나눠 주며, 전체 개수가 거른 결과의 수다

**`REQ-BE-6.2.2`** 거르기

- 처리 계약: 종류(여러 개), 결과, 기간(`parseKstDayRange`로 KST 하루), 문서 이름(기록의 `name`), 문서 ID로 거르고, 조건은 모두 함께 만족해야 한다
- 충족 기준: 조건마다 맞는 기록만 나오고, `to`가 `2026-10-04`면 KST 10월 4일 23:59에 남긴 기록이 나온다

### 보관 — `REQ-BE-6.3`

**`REQ-BE-6.3.1`** 보관 기간이 지난 기록 삭제

- 처리 계약: `occurredAt`에 TTL 인덱스를 두고 만료 시간을 `LOG_RETENTION_DAYS`로 맞춘다. 기동할 때 설정 값과 인덱스의 만료 시간이 다르면 인덱스를 고친다(`ARCHITECT.md` 「설계 결정」)
- 충족 기준: 기동 뒤 `logs`의 TTL 인덱스 만료 시간이 설정한 일수와 같고, 설정을 바꿔 다시 기동하면 새 값이 된다

## 실행 계약

### 문장 틀

| 종류 | 성공 문장 | 실패 문장 |
| :--- | :--- | :--- |
| `upload` | 문서를 올렸습니다 | 문서를 올리지 못했습니다 |
| `content_upload` | 내용을 다시 올렸습니다 | 내용을 다시 올리지 못했습니다 |
| `captioning` | 요약·캡션 {count}개를 만들었습니다 (임시 설명 {failedCount}개) | 요약·캡션을 만들지 못했습니다 |
| `processing_state` | 처리 상태가 {fromState}에서 {toState}로 바뀌었습니다 | 처리 상태가 {fromState}에서 실패로 바뀌었습니다 (사유 {reasonCode}) |
| `edit` | {changedFields}을 고쳤습니다 | {changedFields}을 고치지 못했습니다 |
| `delete` | 문서를 삭제했습니다 | 문서 삭제를 마치지 못했습니다 |
| `replace` | 같은 판의 다른 문서로 교체됐습니다 | |

상태 이름과 필드 이름은 한국어 표시 이름(예: 색인 중, 이름)으로 넣는다.

### 설정

정의는 common 「설정」이 소유한다. 이 모듈이 읽는 키: `LOG_RETENTION_DAYS`.

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `logs.record_failed` | 기록 저장 실패 | warning | `kind`, `docId`, `errorName` | `REQ-BE-6.1.1` |

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-6.1.1` | unit | 일곱 종류 기록, 저장 실패에도 예외 없음 | `MONGO_DB` (가짜) | `src/logs/**/*.spec.ts` |
| `REQ-BE-6.1.2` | unit | 기록 필드와 문장 틀 | `MONGO_DB` (가짜) | `src/logs/**/*.spec.ts` |
| `REQ-BE-6.1.3` | unit | 설명이 틀 문장과 코드 값만으로 이루어짐 | `MONGO_DB` (가짜) | `src/logs/**/*.spec.ts` |
| `REQ-BE-6.2.1` | e2e | 열별 정렬, 페이지, 전체 개수 | | `test/` |
| `REQ-BE-6.2.2` | e2e | 조건별 거르기, KST 하루 경계 | | `test/` |
| `REQ-BE-6.3.1` | e2e | TTL 인덱스 만료 시간과 설정 변경 반영 | | `test/` |
