# utils 라이브러리 명세 (REQ-BE-8.4)

Backend의 여러 모듈이 함께 쓰는, 업무와 무관한 함수와 형식을 모은 라이브러리다. 시각 직렬화와 KST 날짜 범위 변환, 목록 엔드포인트의 페이지 규약을 제공한다. 도메인 오류를 모르며 `src`와 다른 라이브러리를 import하지 않는다. 폴더는 `apps/backend/libs/utils`다.

## 요약

**핵심 계약**

- 시각은 UTC ISO 8601로 주고받고, 날짜 필터는 KST 하루로 해석한다. 두 변환은 이 라이브러리의 함수로만 한다. 요청의 날짜 필터는 common의 `parseKstDayRange`를 거쳐 쓴다 (`REQ-BE-8.4.1`, `REQ-BE-1.3.4`, `REQ-BE-6.2.2`)
- `src`는 이 라이브러리를 `libs/utils/index.ts`로만 import한다 (`ARCHITECT.md` 「의존 규칙」)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-8.4` | 시각 | 시각 직렬화와 KST 날짜 범위 변환을 제공한다 |
| `REQ-BE-7.1.3` (떠받침) | 페이지 규약 | 목록 요청 DTO와 페이지 응답 형식을 정의한다 |

**비범위**

- 날짜 형식 오류를 `InvalidRequestError`로 바꾸는 일 — common (`parseKstDayRange`)
- 목록 응답 형식의 충족 기준 — api (`REQ-BE-7.1.3`)

## 구조

### 예상 배치

```text
libs/utils/
├── index.ts
├── helpers/
│   ├── page.ts
│   └── time.ts
├── interfaces/
│   ├── page-query.dto.ts
│   └── page.ts
└── MODULE.md

libs/utils/**/*.spec.ts      # 단위 테스트는 대상 파일 옆
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| class-validator, class-transformer | import | 검증 데코레이터, `@Type` | 각 라이브러리 | `REQ-BE-7.1.3` |

**금지 의존** — utils는 `src`와 다른 라이브러리를 import하지 않는다. 모든 `src` 모듈이 utils를 쓸 수 있으므로(`ARCHITECT.md` 「의존 규칙」) 반대 방향이 생기면 순환한다.

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 시각 | `toIsoUtc()`, `kstDayRange()` | 「시각 — REQ-BE-8.4」 | `REQ-BE-8.4.1` |
| 페이지 규약 | `PageQueryDto`, `Page<T>`, `toPage()` | 「페이지 규약」 | `REQ-BE-7.1.3` |

## 기능 그룹별 요구사항

### 시각 — `REQ-BE-8.4`

```typescript
/** Date를 UTC ISO 8601 문자열로 바꾼다. */
export function toIsoUtc(at: Date): string;

/** KST 날짜 문자열(YYYY-MM-DD) 하루를 UTC 시각 범위 [start, end)로 바꾼다. */
export function kstDayRange(day: string): { start: Date; end: Date };
```

**`REQ-BE-8.4.1`** 시간대가 붙은 ISO 8601

- 처리 계약: 응답의 모든 시각은 `toIsoUtc`로 만든 `Z` 끝 문자열이다. 날짜 필터는 `kstDayRange`로 KST 00:00부터 다음 날 00:00까지로 바꾼다
- 실패: 날짜 형식이 아니거나 달력에 없는 날짜면 `RangeError`를 던지고, 메시지에 입력값을 넣지 않는다. 이를 `InvalidRequestError`로 바꾸는 일은 common의 `parseKstDayRange`가 한다(common `MODULE.md` 「날짜 범위 — REQ-BE-8.4」)
- 충족 기준: `toIsoUtc`가 `Z`로 끝나는 문자열을 만들고, `kstDayRange('2026-10-04')`가 `2026-10-03T15:00:00Z`부터 `2026-10-04T15:00:00Z` 전까지이며, 날짜 형식이 아니면 `RangeError`다

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

## 실행 계약

### 예외

| 예외 | 발생 조건 | 코드 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `RangeError` | `kstDayRange`에 날짜 형식이 아니거나 달력에 없는 날짜가 들어온다 | 없음 (도메인 오류가 아니다) | 발생: utils. 변환: common(`parseKstDayRange` → `InvalidRequestError`) | `REQ-BE-8.4.1` |

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-8.4.1` | unit | UTC 문자열, KST 하루 범위, 잘못된 날짜의 `RangeError` | | `libs/utils/**/*.spec.ts` |
| `REQ-BE-7.1.3` | unit | `PageQueryDto` 기본값·제약, `toPage()`의 응답 형식 | | `libs/utils/**/*.spec.ts` |
