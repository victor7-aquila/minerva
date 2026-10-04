# glossary 모듈 명세 (REQ-RAG-5)

관리자가 고치는 용어집 파일을 읽어, 질의에 든 말과 같은 묶음의 대표어·동의어를 돌려준다. search가 질의를 확장할 때 쓰며, 용어집이 바뀌어도 문서를 다시 색인하지 않는다. 폴더는 `apps/rag-server/src/minerva_rag/glossary`이고, 용어집 파일은 `config/glossary.yaml`이다.

## 요약

**핵심 계약**

- 동의어 하나는 대표어 하나에만 속한다. 두 묶음에 같은 말이 있는 파일은 받아들이지 않는다 (`REQ-RAG-5.1.2`)
- 파일이 바뀌면 다시 시작하지 않고 다음 확장부터 새 내용을 쓴다. 바뀐 파일이 잘못됐으면 직전의 올바른 용어집을 계속 쓴다 (`REQ-RAG-5.1.3`)
- 용어집은 질의만 바꾼다. 색인 텍스트와 저장된 청크에는 손대지 않는다 (`REQ-RAG-5.2.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-RAG-5.1` | 용어 등록 | 용어집 파일의 형식을 정하고, 읽고 검증하고, 바뀌면 다시 읽는다 |
| `REQ-RAG-5.2` | 질의 확장 | 질의에 든 말의 묶음 전체를 돌려준다 |

**비범위**

- 확장한 말을 검색에 어떻게 넣을지 — search (`REQ-RAG-4.1`)

## 구조

### 예상 배치

```text
src/minerva_rag/glossary/
└── MODULE.md

config/glossary.yaml        # 관리자가 고치는 용어집 (위치는 RAG_GLOSSARY_PATH)

tests/unit/glossary/
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| core | import | `Settings`, `get_logger` | core `MODULE.md` | `REQ-RAG-5.1` |
| 용어집 파일 | 파일 읽기 | 「데이터 계약」의 형식 | 이 문서 | `REQ-RAG-5.1` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 용어 등록 | `Glossary.load`, `GlossaryError` | 「용어 등록 — REQ-RAG-5.1」 | `REQ-RAG-5.1` |
| 질의 확장 | `Glossary.expand`, `Expansion` | 「질의 확장 — REQ-RAG-5.2」 | `REQ-RAG-5.2` |
| 용어 등록 | `config/glossary.yaml` | 「데이터 계약」 | `REQ-RAG-5.1.1` |

## 데이터 계약

### 모델별 필드

**용어집 파일** — 정의: glossary, 값 생산: 관리자 (`REQ-RAG-5.1.1`)

```yaml
terms:
  - canonical: 인증서
    synonyms: [certificate, cert, 인증 문서]
  - canonical: 폐기 목록
    synonyms: [CRL, certificate revocation list]
```

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `terms` | 목록 | 필수 | 비어 있어도 된다 |
| `terms[].canonical` | 문자열 | 필수 | 비어 있지 않다 |
| `terms[].synonyms` | 문자열 목록 | 필수 | 비어 있어도 된다. 한글·영문을 섞어 쓸 수 있다 |

- 대표어와 동의어를 통틀어 같은 말은 파일 전체에서 한 번만 나온다. 영문은 대소문자를 가리지 않고 같은 말로 본다 (`REQ-RAG-5.1.2`)
- 파일이 없으면 빈 용어집이다

**`Expansion`** — 정의: glossary, 값 생산: glossary (`REQ-RAG-5.2.1`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `matched` | `tuple[str, ...]` | 필수 | 질의에서 찾은 용어집의 말 |
| `terms` | `tuple[str, ...]` | 필수 | 찾은 말이 속한 묶음들의 대표어와 동의어 전부. 질의에 이미 있는 말은 뺀다 |

## 기능 그룹별 요구사항

### 용어 등록 — `REQ-RAG-5.1`

```python
class GlossaryError(Exception):
    """용어집 파일이 형식에 맞지 않는다."""


class Glossary:
    """용어집을 읽고 질의를 확장한다."""

    def __init__(self, settings: Settings) -> None: ...
    def load(self) -> None: ...
```

**`REQ-RAG-5.1.1`** 대표어와 동의어 묶음 등록

- 처리 계약: 「데이터 계약」의 형식대로 묶음마다 대표어 하나와 동의어 여러 개를 읽는다
- 실패: 형식에 맞지 않으면 `load`가 `GlossaryError`를 낸다. 기동 때 `load`가 실패하면 service가 기동을 멈춘다
- 충족 기준: 예시 파일을 읽은 뒤 `인증서`, `certificate`, `cert`, `인증 문서`가 한 묶음으로 확장되고, 필수 필드가 없는 파일은 `GlossaryError`를 낸다

**`REQ-RAG-5.1.2`** 동의어는 대표어 하나에만 속함

- 실패: 같은 말이 두 묶음에 나오면 `GlossaryError`를 내며, 메시지에 그 말을 담는다
- 충족 기준: 두 묶음에 같은 동의어(대소문자만 다른 영문 포함)가 있으면 `GlossaryError`가 난다

**`REQ-RAG-5.1.3`** 다시 시작하지 않고 반영

- 처리 계약: `expand`를 부를 때 파일이 마지막으로 읽은 뒤 바뀌었으면 다시 읽는다. 다시 읽기가 `GlossaryError`로 실패하면 직전 용어집을 계속 쓰고 경고 로그를 남긴다
- 충족 기준: 파일을 고친 뒤 다음 `expand`가 새 묶음으로 확장하고, 잘못된 내용으로 고치면 직전 묶음으로 확장하며 경고 로그가 남는다

### 질의 확장 — `REQ-RAG-5.2`

```python
@dataclass(frozen=True)
class Expansion:
    """질의에서 찾은 말과 넣을 말이다."""
    matched: tuple[str, ...]
    terms: tuple[str, ...]


class Glossary:
    def expand(self, query: str) -> Expansion: ...
```

**`REQ-RAG-5.2.1`** 묶음의 대표어와 동의어까지 확장

- 처리 계약: 질의에 대표어나 동의어가 나오면 그 묶음의 대표어와 동의어 전부를 `terms`에 담는다. 영문은 대소문자를 가리지 않는다. 용어집의 말이 없으면 `matched`와 `terms`가 비어 있다
- 충족 기준: 동의어 하나가 든 질의가 그 묶음의 대표어와 다른 동의어로 확장되고, 용어집의 말이 없는 질의는 빈 확장이 된다

**`REQ-RAG-5.2.2`** 용어집 변경 시 재색인 없음

- 처리 계약: glossary는 store·indexing에 기대지 않으며, 용어집 변경은 질의 확장 결과만 바꾼다
- 충족 기준: 용어집을 고친 뒤에도 store에 쓰기가 일어나지 않고, 다음 검색의 확장 결과만 달라진다

## 실행 계약

### 설정

정의는 core 「설정」이 소유한다. 이 모듈이 읽는 키: `RAG_GLOSSARY_PATH`.

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `glossary.loaded` | 읽기 성공 | info | `groups`, `terms` (개수) | `REQ-RAG-5.1.3` |
| `glossary.reload_failed` | 다시 읽기 실패로 직전 용어집을 계속 쓸 때 | warning | `reason` | `REQ-RAG-5.1.3` |

질의 원문은 로그에 넣지 않는다. 찾은 말의 개수만 남긴다.

### 실패 모드

- **잘못 고친 용어집** (`REQ-RAG-5.1.3`) — 증상: 관리자가 고친 내용이 반영되지 않는다. 탐지: `glossary.reload_failed` 경고 로그. 방어: 직전의 올바른 용어집을 계속 써서 검색이 멈추지 않게 한다

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-RAG-5.1.1` | unit | 묶음 읽기, 형식 오류 시 `GlossaryError`, 파일 없음은 빈 용어집 | 임시 파일 | `tests/unit/glossary/` |
| `REQ-RAG-5.1.2` | unit | 두 묶음의 같은 말(대소문자 차이 포함) 거부 | 임시 파일 | `tests/unit/glossary/` |
| `REQ-RAG-5.1.3` | unit | 파일 변경 후 다음 확장에 반영, 잘못된 변경 시 직전 유지와 경고 | 임시 파일 | `tests/unit/glossary/` |
| `REQ-RAG-5.2.1` | unit | 동의어·대표어로 묶음 전체 확장, 대소문자 무시, 없는 말은 빈 확장 | 임시 파일 | `tests/unit/glossary/` |
| `REQ-RAG-5.2.2` | unit | 용어집 변경 시 저장소 쓰기 없음 | 임시 파일 | `tests/unit/glossary/` |
