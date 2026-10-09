# evaluation 모듈 명세 (REQ-RAG-6)

Backend가 보낸 골든셋 한 건으로 검색 요청과 같은 처리로 결과 N개를 만들고, 연관 청크 확장 전·후의 적중, 순위, 역순위, 포함 비율을 계산해 돌려준다. 골든셋과 결과는 저장하지 않는다. 폴더는 `apps/rag-server/src/minerva_rag/evaluation`다.

## 요약

**핵심 계약**

- 평가의 결과 N개는 검색 요청과 같은 처리로 만든다. search를 한 번만 부르고, 확장 전 지표는 그 결과의 `chunks`로, 확장 후 지표는 `before`·`chunks`·`after`로 잰다. 검색 처리를 따로 흉내 내지 않는다 (`REQ-RAG-6.2.1`, `REQ-RAG-6.2.6`)
- 정답 구간과 결과 본문은 공백 문자를 모두 지운 뒤 비교한다. 공백 문자의 범위는 Backend가 정답 구간을 확인할 때(`REQ-BE-5.1.5`)와 같다(「측정 — REQ-RAG-6.2」). 범위가 다르면 Backend가 받은 정답 구간이 공백 차이로 놓침이 된다 (`REQ-RAG-6.2.2`, `REQ-RAG-6.2.3`)
- 정답 구간은 자리표시를 넘지 않는다. Backend가 색인용 MD의 자리표시 사이 한 구역 안에 있는 구간만 받기 때문이다(`REQ-BE-5.1.5`). 결과 본문의 자리표시는 바꾸지 않고 그대로 비교한다
- 골든셋과 평가 결과를 저장하지 않는다. evaluation은 search 말고 어떤 저장소에도 기대지 않는다 (`REQ-RAG-6.1.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-RAG-6.1` | 평가 요청 | 골든셋 한 건의 입력과 적중으로 셀 결과의 범위를 정한다 |
| `REQ-RAG-6.2` | 측정 | 결과 N개로 적중·순위·역순위·포함 비율을 확장 전·후로 잰다 |
| `REQ-RAG-6.3` | 결과 반환 | 지표를 돌려주고, 정답 문서가 검색되지 않으면 평가하지 않는다 |

**비범위**

- 골든셋 전체의 Hit 비율·MRR 요약 — Backend (`REQ-BE-5.3.3`)
- 검색 품질 임계값 판단 — 관리자가 Console에서 본다 (`AGENTS.md` 「테스트 규칙」)

## 구조

### 예상 배치

```text
src/minerva_rag/evaluation/
├── MODULE.md
├── models.py               # 공개 데이터 타입 (REQ-RAG-6.1.1, REQ-RAG-6.2)
├── metrics.py              # 공백 제거, 결과 본문, 적중·순위·포함 비율 계산 (REQ-RAG-6.1.3, REQ-RAG-6.2.2~REQ-RAG-6.2.6)
└── evaluator.py            # 평가 한 번 (REQ-RAG-6). Evaluator

tests/unit/evaluation/
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| search | import | `Searcher.search`, `Searcher.document_chunks`, `SearchQuery`, `SearchHit` | search `MODULE.md` | `REQ-RAG-6.2.1`, `REQ-RAG-6.3.2` |
| core | import | `Settings`, `get_logger`, `DocumentNotSearchableError`, `InvalidRequestError` | core `MODULE.md` | `REQ-RAG-6.1.1`, `REQ-RAG-6.3.2` |

**금지 의존** — resource를 직접 부르지 않는다. 검색 한 번의 처리 순서는 search 안에서 지킨다(`ARCHITECT.md` 「의존 규칙」).

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 평가 요청 | `Evaluator.evaluate`, `EvaluationCase` | 「평가 요청 — REQ-RAG-6.1」 | `REQ-RAG-6.1` |
| 측정 | `EvaluationResult`, `EvaluationMetrics` | 「측정 — REQ-RAG-6.2」 | `REQ-RAG-6.2` |

HTTP 형식(`EvaluationResult`, `EvaluationMetrics`)은 `API.md`가 소유하며, 아래 타입은 api가 그 형식으로 옮기는 원천이다.

## 데이터 계약

### 모델별 필드

**`EvaluationCase`** — 정의: evaluation, 값 생산: service (`REQ-RAG-6.1.1`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `query` | `str` | 필수 | |
| `doc_id` | `str` | 필수 | 정답 문서 |
| `answer_span` | `str` | 필수 | 정답 원문 구간. 공백을 지운 뒤 비어 있지 않다 |
| `edition_only` | `bool` | 필수 | 기본 `False` |
| `top_n` | `int \| None` | 선택 | 1 이상. `None`이면 `RAG_SEARCH_DEFAULT_TOP_N` |

`top_n`이 1 미만이면 만들 때 `ValueError`를 낸다(api가 먼저 거른다). `answer_span`의 "공백을 지운 뒤 비어 있지 않다"는 `evaluate`가 검사한다(`REQ-RAG-6.1.1`).

**`EvaluationMetrics`** — 정의: evaluation, 값 생산: evaluation (`REQ-RAG-6.2`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `hit_at_1`, `hit_at_3`, `hit_at_5`, `hit_at_n` | `bool` | 필수 | 앞 k개 안에 적중이 있는가. k가 결과 수보다 크면 결과 전부를 본다. `hit_at_1`이 참이면 나머지도 참이다 |
| `rank` | `int \| None` | 선택 | 처음 적중한 결과의 `rank`. 적중이 없으면 `None` |
| `reciprocal_rank` | `float` | 필수 | `1 / rank`. `rank`가 `None`이면 0 |
| `coverage` | `float` | 필수 | 0 이상 1 이하 |

**`EvaluationResult`** — `n`(이번 평가에 쓴 N), `base`(확장 전), `expanded`(확장 후).

## 기능 그룹별 요구사항

```python
class Evaluator:
    """골든셋 한 건으로 검색 품질 지표를 계산한다."""

    def __init__(self, searcher: Searcher, settings: Settings) -> None: ...
    async def evaluate(self, case: EvaluationCase) -> EvaluationResult: ...
```

### 평가 요청 — `REQ-RAG-6.1`

**`REQ-RAG-6.1.1`** 평가 입력

- 실패: 공백 문자(「측정 — REQ-RAG-6.2」)를 지운 `answer_span`이 비어 있으면 `document_chunks`·`search`를 부르기 전에 `InvalidRequestError`(`INVALID_REQUEST`)를 낸다
- 충족 기준: 질의, 정답 문서 ID, 정답 원문 구간, 판 지정 여부, N을 담은 `EvaluationCase`로 `evaluate`가 결과를 돌려주고, `n`이 요청한 N(없으면 기본 개수)이다. 공백 문자만 든 `answer_span`이면 `InvalidRequestError`가 나고 search가 불리지 않는다

**`REQ-RAG-6.1.2`** 저장하지 않음

- 충족 기준: `evaluate` 뒤 search 호출 말고는 어떤 단위·파일에도 쓰기가 없다

**`REQ-RAG-6.1.3`** 적중으로 세는 결과의 범위

- 처리 계약: `edition_only`가 거짓이면 `name`이 정답 문서의 이름과 같은 결과를, 참이면 `doc_id`가 정답 문서인 결과만 적중 후보로 센다. 정답 문서의 이름은 `document_chunks`로 얻는다
- 충족 기준: 정답 구간을 담은 결과가 같은 이름의 다른 판이면, `edition_only`가 거짓일 때 적중이고 참일 때 놓침이다. 이름이 다른 문서의 결과는 어느 쪽이든 적중이 아니다

### 측정 — `REQ-RAG-6.2`

정답 구간과 결과 본문은 모든 공백 문자를 지운 뒤 비교한다. ★ 공백 문자는 JavaScript 정규식 `\s`와 같은 글자 집합이다 — 띄어쓰기·탭·줄바꿈(`\t\n\v\f\r`)과 U+00A0, U+1680, U+2000~U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. Python `str.isspace`·`re`의 `\s`와 다르므로(U+001C~U+001F·U+0085를 더 넣고 U+FEFF를 뺀다) 그대로 쓰지 않는다. U+200B는 공백이 아니다. 결과 본문은 확장 전이면 `chunks`의 `text`를, 확장 후면 `before`·`chunks`·`after`의 `text`를 이 순서로 이은 것이다(`REQ-RAG-6.2.6`). 글자 수(10자 기준, 덮인 글자 수, 정답 구간 글자 수)는 모두 공백 문자를 지운 뒤 유니코드 코드 포인트 단위로 센다. 그래서 공백 문자는 포함 비율의 분모에도 들지 않는다.

**`REQ-RAG-6.2.1`** 검색과 같은 처리로 결과 N개

- 처리 계약: `SearchQuery(query, top_n=n, edition_scope=ALL, expand_neighbors=True)`로 `search`를 한 번 부르고 나머지 필드는 기본값으로 둔다. `n`은 `EvaluationCase.top_n`이고, `None`이면 `RAG_SEARCH_DEFAULT_TOP_N`으로 채운 값이다(`EvaluationResult.n`과 같다). 판 범위는 거르지 않는다
- 충족 기준: `evaluate` 한 번에 `search`가 정확히 한 번, 위 인자로 불린다

**`REQ-RAG-6.2.2`** 포함 비율

- 처리 계약: 결과 N개(적중 후보에 한정하지 않는다) 각각에서 정답 구간과 그 본문의 공통 부분 문자열 중 가장 긴 것을 찾아 그 자리를 덮인 글자로 표시한다. 10자 미만의 공통 부분은 우연한 일치로 보고 세지 않으며, 정답 구간이 10자 미만이면 구간 전체가 들어 있을 때만 센다. 포함 비율은 덮인 글자 수 / 정답 구간 글자 수다
- 충족 기준: 정답 구간의 앞 절반이 한 결과 끝에, 뒤 절반이 다른 결과 앞에 있으면 1에 가깝고, 정답 구간과 10자 이상 겹치는 결과가 없으면 0이다. 줄바꿈 위치만 다르거나 띄어쓰기 대신 U+00A0이 든 결과도 같은 값이다

**`REQ-RAG-6.2.3`** 적중

- 처리 계약: 적중 후보 결과의 본문 안에 정답 구간이 통째로 들어 있으면 그 결과가 적중이다
- 충족 기준: 분할 조각 둘에 걸친 정답 구간은 조각을 합친 결과 하나에서 적중이고, 앞 청크까지 걸친 구간은 확장 후에만 적중이다

**`REQ-RAG-6.2.4`** 적중 순위와 역순위

- 충족 기준: 3위 결과가 처음 적중이면 `rank`가 3, `reciprocal_rank`가 1/3이고, 적중이 없으면 `rank`가 `None`, `reciprocal_rank`가 0이다

**`REQ-RAG-6.2.5`** 1·3·5·N개 안의 적중

- 충족 기준: 처음 적중이 4위면 `hit_at_1`·`hit_at_3`이 거짓, `hit_at_5`·`hit_at_n`이 참이다. N이 3이고 적중이 없으면 넷 다 거짓이다

**`REQ-RAG-6.2.6`** 확장 전·후

- 충족 기준: `base`는 `chunks`만으로, `expanded`는 `before`·`chunks`·`after`로 계산되며, 앞뒤 청크에만 정답 구간이 있으면 `base`는 놓침, `expanded`는 적중이다

### 결과 반환 — `REQ-RAG-6.3`

**`REQ-RAG-6.3.1`** 응답으로 결과 반환

- 충족 기준: `evaluate`가 `EvaluationResult`를 돌려주고, 작업을 만들지 않는다

**`REQ-RAG-6.3.2`** 정답 문서가 검색되지 않으면 오류

- 처리 계약: 검색하기 전에 `document_chunks(doc_id)`를 보고 `version`이 `None`이면 `DocumentNotSearchableError`를 낸다
- 실패: `DocumentNotSearchableError` (`DOCUMENT_NOT_SEARCHABLE`)
- 충족 기준: 검색되는 버전이 없는 문서로 평가하면 `DocumentNotSearchableError`가 나고 `search`가 불리지 않는다

## 실행 계약

### 설정

정의는 core 「설정」이 소유한다. 이 모듈이 읽는 키: `RAG_SEARCH_DEFAULT_TOP_N`.

### 예외

| 예외 | 발생 조건 | 코드·상태 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `InvalidRequestError` | 공백 문자를 지운 정답 구간이 비어 있다 | `INVALID_REQUEST` | 발생: evaluation. 변환: api | `REQ-RAG-6.1.1` |
| `DocumentNotSearchableError` | 정답 문서에 검색되는 버전이 없다 | `DOCUMENT_NOT_SEARCHABLE` | 발생: evaluation. 변환: api | `REQ-RAG-6.3.2` |

search가 내는 resource 예외는 그대로 전파한다.

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `evaluation.done` | `evaluate` 끝 | info | `doc_id`, `n`, `base_rank`, `expanded_rank`, `elapsed_ms` | `REQ-RAG-6.3.1` |

질의 원문과 정답 구간은 로그에 넣지 않는다.

## 테스트와 추적성

pytest는 지표 계산 규칙만 검증하고, 검색 품질 임계값은 검증하지 않는다(`AGENTS.md`).

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-RAG-6.1.1` | unit | 입력 필드 반영, `n` 기본값 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.1.2` | unit | search 외 호출·쓰기 없음 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.1.3` | unit | 판 지정 여부별 적중 후보, 다른 이름 제외 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.2.1` | unit | `search` 한 번, 인자 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.2.2` | unit | 걸친 구간, 겹침 없음, 10자 미만 무시, 줄바꿈·U+00A0 공백 차이 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.2.3` | unit | 조각 합친 결과의 적중, 확장 후에만 적중 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.2.4` | unit | 순위·역순위, 적중 없음 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.2.5` | unit | k별 적중, N이 5보다 작을 때 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.2.6` | unit | 확장 전·후 본문 구성 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.3.1` | unit | 결과 반환 | search (가짜) | `tests/unit/evaluation/` |
| `REQ-RAG-6.3.2` | unit | 검색되지 않는 문서에서 오류, 검색 호출 없음 | search (가짜) | `tests/unit/evaluation/` |
