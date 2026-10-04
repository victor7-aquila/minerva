# store 모듈 명세 (REQ-RAG-13)

Qdrant에 연결해 청크 레코드(`IF-RAG-1`의 `ChunkRecord`)와 dense·키워드 벡터를 저장·삭제·조회하는 유일한 단위다. 레코드의 필드를 스스로 채우거나 바꾸지 않고 받은 그대로 저장하며, 저장된 벡터 차원이 지금 임베딩 모델과 다르면 저장도 조회도 하지 않는다. 폴더는 `apps/rag-server/src/minerva_rag/store`다.

## 요약

**핵심 계약**

- 레코드는 받은 그대로 저장하고 그대로 돌려준다. 버전 전환, 최신판 표시 같은 판단은 하지 않고 indexing이 지시한 대로만 바꾼다 (`IF-RAG-1`)
- 조회 메서드는 `active`가 `True`인 레코드만 돌려준다(기동 복구용 `job_records`만 예외). search가 이전 버전·색인 중인 버전을 보지 않게 하는 경계다 (`REQ-RAG-3.3.1`, `REQ-RAG-3.3.2`)
- 차원이 맞지 않으면 모든 저장·조회가 오류를 낸다. 틀린 공간의 벡터로 조용히 검색하지 않는다 (`REQ-RAG-13.1.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-RAG-13.1` | 저장소 연결 | Qdrant에 연결해 컬렉션을 맞추고, 청크 레코드를 저장·삭제·조회한다 |

**비범위**

- 어떤 레코드를 언제 저장·활성화·삭제할지 — indexing
- 검색 범위(판, 문서 ID)를 무엇으로 할지, 점수 합치기 — search

## 구조

### 예상 배치

```text
src/minerva_rag/store/
└── MODULE.md

tests/unit/store/
tests/integration/store/
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| core | import | `ChunkRecord`, `Chunk`, `Edition`, `SparseVector`, `Settings`, `get_logger`, `StoreUnavailableError`, `VectorDimensionMismatchError` | `IF-RAG-1`, core `MODULE.md` | `REQ-RAG-13.1` |
| Qdrant | HTTP (qdrant-client) | 컬렉션·포인트 API | Qdrant | `REQ-RAG-13.1` |

**금지 의존** — Qdrant에는 store만 접근한다. 저장·삭제 메서드는 indexing만 부르고, search는 조회 메서드만 부른다(`ARCHITECT.md` 「의존 규칙」).

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 저장소 연결 | `ChunkStore.connect`, `close`, `ping` | 「저장소 연결 — REQ-RAG-13.1」 | `REQ-RAG-13.1.1`, `REQ-RAG-13.1.2` |
| 저장소 연결 (쓰기) | `ChunkStore.upsert`, `activate_records`, `delete_records_except`, `delete_records`, `delete_document`, `set_document_metadata`, `set_latest_editions` | 같은 절 | `REQ-RAG-13.1` |
| 저장소 연결 (조회) | `ChunkStore.search_dense`, `search_sparse`, `active_records`, `active_editions`, `job_records`, `ChunkFilter`, `ScoredRecord` | 같은 절 | `REQ-RAG-13.1` |

## 데이터 계약

레코드 필드와 벡터 이름은 `IF-RAG-1`이 소유한다. 이 모듈은 조회 조건과 점수 붙은 결과만 정의한다.

### 모델별 필드

**`ChunkFilter`** — 정의: store, 값 생산: search (`REQ-RAG-4.1.3`, `REQ-RAG-4.5`)

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `doc_ids` | `tuple[str, ...] \| None` | 선택 | `None`이면 문서 제한 없음 |
| `edition_name` | `str \| None` | 선택 | `edition_label`과 함께 있거나 함께 없다 |
| `edition_label` | `str \| None` | 선택 | 있으면 `name == edition_name`이고 `edition.label == edition_label`인 레코드만 |
| `latest_or_unversioned` | `bool` | 필수 | `True`면 `is_latest_edition`이 `True`이거나 `edition`이 `None`인 레코드만 |

**`ScoredRecord`** — 정의: store, 값 생산: store

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `record` | `ChunkRecord` | 필수 | 저장한 것과 필드가 같다 |
| `score` | `float` | 필수 | 그 조회 안에서 클수록 질의와 가깝다 |

### 변환·저장 경계

- **저장** (`ChunkRecord` + 벡터 → Qdrant 포인트) — 보존: `ChunkRecord`와 `Chunk`의 모든 필드. 파생: 포인트 ID는 `chunk_id`. 제외: 색인 텍스트(`IF-RAG-1`). 형식: dense 벡터 이름 `dense`(코사인 거리), 키워드 벡터 이름 `sparse`(IDF 보정)
- **조회** (Qdrant 포인트 → `ChunkRecord`) — 보존: 저장한 필드 전부. `edition_date`는 `date`로 되돌린다

## 기능 그룹별 요구사항

### 저장소 연결 — `REQ-RAG-13.1`

```python
@dataclass(frozen=True)
class ChunkFilter:
    """조회 범위다. 모든 조회는 active 레코드 안에서만 한다."""
    doc_ids: tuple[str, ...] | None = None
    edition_name: str | None = None
    edition_label: str | None = None
    latest_or_unversioned: bool = False


@dataclass(frozen=True)
class ScoredRecord:
    """점수가 붙은 조회 결과다."""
    record: ChunkRecord
    score: float


class ChunkStore:
    """Qdrant의 청크 컬렉션을 다룬다."""

    def __init__(self, settings: Settings) -> None: ...
    async def connect(self, dense_dimension: int) -> None: ...
    async def close(self) -> None: ...
    async def ping(self) -> bool: ...

    # 쓰기 — indexing만 부른다
    async def upsert(
        self,
        records: Sequence[ChunkRecord],
        dense: Sequence[Sequence[float]],
        sparse: Sequence[SparseVector],
    ) -> None: ...
    async def activate_records(self, doc_id: str, chunk_ids: Collection[str]) -> None: ...
    async def delete_records_except(self, doc_id: str, chunk_ids: Collection[str]) -> None: ...
    async def delete_records(self, chunk_ids: Collection[str]) -> None: ...
    async def delete_document(self, doc_id: str) -> None: ...
    async def set_document_metadata(self, doc_id: str, name: str, edition: Edition | None) -> None: ...
    async def set_latest_editions(self, name: str, latest_doc_ids: frozenset[str]) -> None: ...

    # 조회 — active 레코드만
    async def search_dense(self, vector: Sequence[float], flt: ChunkFilter, limit: int) -> list[ScoredRecord]: ...
    async def search_sparse(self, vector: SparseVector, flt: ChunkFilter, limit: int) -> list[ScoredRecord]: ...
    async def active_records(self, doc_id: str) -> list[ChunkRecord]: ...
    async def active_editions(self, name: str) -> dict[str, Edition | None]: ...

    # 조회 — active 여부와 관계없이, indexing의 기동 복구만 쓴다
    async def job_records(self, doc_id: str, job_id: str) -> list[ChunkRecord]: ...
```

- `upsert`의 세 인자는 같은 길이·같은 순서다. 저장한 레코드의 `active`는 받은 값 그대로다
- `activate_records`는 그 문서에서 `chunk_ids`에 든 레코드를 `active=True`로 바꾼다. `delete_records_except`는 그 문서에서 `chunk_ids`에 들지 않은 레코드를 모두 지운다. `delete_records`는 `chunk_ids`의 레코드만 지운다. 버전 문자열이 아니라 레코드 ID로 다루므로, 같은 버전을 다시 색인해도 이전 레코드와 섞이지 않는다
- `delete_document`·`set_document_metadata`는 그 문서의 모든 버전 레코드에 적용한다. 레코드가 없으면 아무 일 없이 끝난다
- `set_latest_editions`는 `name`이 같은 active 레코드 중 `doc_id`가 `latest_doc_ids`에 든 것은 `is_latest_edition=True`, 나머지는 `False`로 바꾼다
- `active_records`는 그 문서의 active 레코드를 돌려주며 순서는 보장하지 않는다. `active_editions`는 `name`이 같은 active 레코드의 문서마다 판 정보를 돌려준다
- `search_dense`·`search_sparse`는 점수 내림차순으로 최대 `limit`개를 돌려준다
- `job_records`는 그 문서에서 `job_id`가 같은 레코드를 active 여부와 관계없이 돌려준다. 이 메서드만 active가 아닌 레코드를 돌려준다

**`REQ-RAG-13.1.1`** Qdrant 연결 실패 알림

- 처리 계약: `connect` 뒤 모든 쓰기·조회 메서드는 Qdrant에 연결할 수 없으면 `StoreUnavailableError`를 낸다. `ping`은 오류를 내지 않고 연결 여부를 돌려준다
- 실패: `connect` 자체가 Qdrant에 연결하지 못하면 `StoreUnavailableError`를 내고, service가 기동을 멈춘다(service `MODULE.md` 「수명주기 서비스」)
- 충족 기준: Qdrant가 연결을 거부하면 쓰기·조회 메서드가 모두 `StoreUnavailableError`를 내고 `ping()`이 `False`다

**`REQ-RAG-13.1.2`** 벡터 차원 불일치 거부

- 처리 계약: `connect`는 컬렉션이 없으면 `dense_dimension` 차원으로 만든다. 있으면 저장된 `dense` 차원을 비교하고, 다르면 기동은 막지 않되 그 뒤 모든 쓰기·조회 메서드가 `VectorDimensionMismatchError`를 낸다. `ping`과 `close`는 영향을 받지 않는다
- 충족 기준: 다른 차원으로 만든 컬렉션에 `connect`한 뒤 `upsert`·`search_dense`·`active_records`가 `VectorDimensionMismatchError`를 내고, 같은 차원이면 정상 동작한다

## 실행 계약

### 설정

정의는 core 「설정」이 소유한다. 이 모듈이 읽는 키: `RAG_QDRANT_URL`.

### 예외

| 예외 | 발생 조건 | 코드·상태 | 처리 책임 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `StoreUnavailableError` | Qdrant에 연결할 수 없다 | `STORE_UNAVAILABLE` | 발생: store. 전파: indexing·search를 거쳐 service | `REQ-RAG-13.1.1` |
| `VectorDimensionMismatchError` | 저장된 차원이 `connect`에 준 차원과 다르다 | `VECTOR_DIMENSION_MISMATCH` | 발생: store. 전파: indexing·search를 거쳐 service | `REQ-RAG-13.1.2` |

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `store.dimension_mismatch` | `connect`에서 차원이 다를 때 | error | `stored_dimension`, `model_dimension` | `REQ-RAG-13.1.2` |
| `store.unavailable` | 연결 실패 | warning | `operation` | `REQ-RAG-13.1.1` |
| `store.upsert` | 저장 끝 | info | `doc_id`, `version`, `chunks` | `REQ-RAG-13.1` |

청크 본문(`text`)과 제목·요약은 레코드 안에 있으므로, 레코드를 통째로 로그에 넘기지 않는다.

### 런타임·보안

- **실행 형태** — 모든 Qdrant 호출은 `async`다(`AGENTS.md`)
- **영속화·복원** — 데이터는 Qdrant가 보관한다. 컬렉션 구성은 `connect`가 맞추며, 기존 컬렉션의 데이터를 지우거나 다시 만들지 않는다

### 실패 모드

- **여러 호출에 걸친 쓰기** (`REQ-RAG-3.3`) — 증상: `activate_records`와 `delete_records_except` 사이에 조회하면 한 문서의 이전 레코드와 새 레코드가 함께 나올 수 있다. 탐지: 결과에 같은 `doc_id`의 이전·새 레코드가 섞인다. 방어: 두 호출을 indexing이 연달아 부른다. 순서의 소유자는 indexing이다(indexing `MODULE.md` 「핵심 흐름」)

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-RAG-13.1.1` | unit | 연결 거부 시 모든 쓰기·조회가 `StoreUnavailableError`, `ping` 거짓, `connect` 실패 | Qdrant 클라이언트 (가짜) | `tests/unit/store/` |
| `REQ-RAG-13.1.2` | integration | 차원이 다른 기존 컬렉션에서 쓰기·조회 거부, 같은 차원이면 정상 | | `tests/integration/store/` |
| `REQ-RAG-13.1.2` | integration | 레코드 필드 왕복 보존, active 레코드만 조회, `ChunkFilter` 조건별 범위 (`IF-RAG-1` 검증) | | `tests/integration/store/` |
