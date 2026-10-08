# minerva RAG Server 인터페이스 명세

이 문서는 RAG Server 안에서 둘 이상의 단위가 공유하는 계약을 소유한다. 참여 단위의 `MODULE.md`는 계약을 다시 정의하지 않고 IF ID로 가리키기만 한다. 앱 사이 계약(자리표시 형식, 작업 상태 알림)은 저장소 루트의 `INTERFACES.md`가 소유한다.

## 계약 목록

| ID | 계약 | 참여 단위 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| `IF-RAG-1` | 청크 레코드 | chunking, indexing, resource, search | `REQ-RAG-2`, `REQ-RAG-3`, `REQ-RAG-4`, `REQ-RAG-12.2` |
| `IF-RAG-2` | 폐기 — 색인 작업 실행은 service 안의 계약이 됐다(service `MODULE.md`) | service | `REQ-RAG-10.8` |

## IF-RAG-1 청크 레코드

chunking이 만든 청크를 indexing이 색인 정보와 함께 resource로 Qdrant에 저장하고, search가 그것을 읽어 결과를 만든다. 네 단위가 같은 필드를 같은 뜻으로 읽어야 자리표시 보존, 버전 교체, 연관 청크 확장, 판 처리가 맞게 동작하므로 한 단위의 명세로는 정할 수 없다.

### 참여 단위

| 단위 | 역할 | 관련 REQ |
| :--- | :--- | :--- |
| chunking | 생산 (`Chunk`) | `REQ-RAG-2` |
| core | 정의 (타입) | `REQ-RAG-11` |
| indexing | 생산 (`ChunkRecord`) | `REQ-RAG-3` |
| resource | 저장 | `REQ-RAG-12.2` |
| search | 소비 | `REQ-RAG-4` |

### 계약 표면

아래 타입은 core 단위에 둔다. chunking, indexing, resource, search는 core에서 import한다(`ARCHITECT.md` 「단위 구성」).

```python
from dataclasses import dataclass
from datetime import date
from enum import StrEnum


class ChunkKind(StrEnum):
    TEXT = "text"    # 본문 청크
    ASSET = "asset"  # 표·이미지 청크


@dataclass(frozen=True)
class Chunk:
    """chunking이 만들어 indexing에 넘기는 청크다."""
    chunk_key: str
    kind: ChunkKind
    order: int
    heading_path: tuple[str, ...]
    title: str | None
    summary: str | None
    text: str
    placeholder_ids: tuple[str, ...]
    split_group: str | None
    split_index: int | None
    split_total: int | None


@dataclass(frozen=True)
class ChunkingResult:
    """chunking의 결과다."""
    chunks: tuple[Chunk, ...]
    fallback_used: bool


@dataclass(frozen=True)
class Edition:
    """문서의 판 정보다."""
    label: str
    edition_date: date


@dataclass(frozen=True)
class ChunkRecord:
    """indexing이 resource로 저장하고 search가 읽는 청크 레코드다."""
    chunk_id: str
    doc_id: str
    version: str
    job_id: str
    active: bool
    name: str
    edition: Edition | None
    is_latest_edition: bool
    chunk: Chunk
```

`Chunk` 필드:

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `chunk_key` | `str` | 필수 | 문서 한 버전 안에서 고유하다 |
| `kind` | `ChunkKind` | 필수 | 본문 청크는 `TEXT`, 표·이미지 청크는 `ASSET` |
| `order` | `int` | 필수 | 문서 안 순서. 본문 청크끼리는 문서에 나오는 차례대로 커진다. 분할 조각은 원래 청크의 순서를 그대로 갖고, 표·이미지 청크는 그 표·이미지를 담은 본문 청크의 순서를 갖는다 |
| `heading_path` | `tuple[str, ...]` | 필수 | 청크가 속한 절까지의 헤딩을 위에서부터 차례로 담는다. 분할 조각은 원래 청크와 같다 |
| `title` | `str \| None` | 조건부 | `TEXT`이면 필수, `ASSET`이면 `None`. 분할 조각은 원래 청크와 같다 |
| `summary` | `str \| None` | 조건부 | `TEXT`이면 필수, `ASSET`이면 `None` |
| `text` | `str` | 필수 | 청크 원문. 자리표시는 원형 그대로 들어 있다. `ASSET`이면 그 표·이미지의 자리표시 하나뿐이다 |
| `placeholder_ids` | `tuple[str, ...]` | 필수 | `text`에 든 자리표시 ID를 나오는 차례대로 담는다. `ASSET`이면 정확히 하나다 |
| `split_group` | `str \| None` | 조건부 | 크기 상한으로 나뉜 조각이면 같은 원래 청크의 조각끼리 같은 값, 나뉘지 않았으면 `None` |
| `split_index` | `int \| None` | 조건부 | `split_group`이 있으면 1부터 `split_total`까지의 조각 번호, 없으면 `None` |
| `split_total` | `int \| None` | 조건부 | `split_group`이 있으면 조각 수, 없으면 `None` |

`ChunkRecord` 필드 (`chunk`를 뺀 것):

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `chunk_id` | `str` | 필수 | 모든 문서·버전에 걸쳐 고유하다 |
| `doc_id` | `str` | 필수 | Backend가 색인 요청에 담아 보낸 값 그대로 |
| `version` | `str` | 필수 | Backend가 색인 요청에 담아 보낸 값 그대로 |
| `job_id` | `str` | 필수 | 이 레코드를 만든 작업의 ID. 한 작업이 만든 레코드는 모두 같은 값이다. 다시 시작할 때 그 작업의 결과가 검색에 쓰이는지 가리는 기준이다(`REQ-RAG-10.8.5.3`) |
| `active` | `bool` | 필수 | 문서 하나에서 `True`인 레코드는 모두 같은 버전이고, 그 버전이 "현재 검색되는 버전"이다. 버전을 바꾸는 동안(새 레코드를 활성화하고 이전 레코드를 지우기까지)만 두 버전이 함께 `True`일 수 있다 |
| `name` | `str` | 필수 | 문서 이름. 색인 요청이나 이름·판 정보 변경 요청에 담긴 값 그대로. 문서의 모든 레코드가 같은 값을 갖는다 |
| `edition` | `Edition \| None` | 선택 | 판 정보. 판 정보가 없는 문서면 `None`. 문서의 모든 레코드가 같은 값을 갖는다 |
| `is_latest_edition` | `bool` | 필수 | 같은 `name`의 `active` 레코드 중 `edition_date`가 가장 늦은 판의 레코드는 `True`이고, 가장 늦은 날짜의 판이 여럿이면 모두 `True`다. `edition`이 `None`이면 `False` |

Qdrant 벡터:

| 이름 | 만드는 텍스트 | 불변 조건 |
| :--- | :--- | :--- |
| `dense` | 색인 텍스트 (`REQ-RAG-3.1.1`) | 차원이 지금 임베딩 모델의 차원과 같다 |
| `sparse` | 색인 텍스트 | BM25 키워드 벡터 |

색인 텍스트는 레코드에 저장하지 않는다.

### 의무

- **chunking** (생산) — 보장: 색인용 MD의 모든 자리표시가 `TEXT` 청크 전체에서 정확히 한 번, 원형 그대로 나오고 두 청크에 걸쳐 잘리지 않는다(`REQ-RAG-2.2`). 표·이미지마다 `ASSET` 청크를 하나씩 만든다(`REQ-RAG-2.4`). 위 `Chunk` 필드의 불변 조건을 지킨다. 분할 조각 사이에 겹치는 텍스트가 없다(`REQ-RAG-2.5.1.6`). 금지: 자리표시를 다른 텍스트로 바꾸지 않는다.
- **indexing** (생산) — 보장: 색인 텍스트를 만들 때 자리표시 전체를 그 자리표시 ID의 요약·캡션 문장으로 바꾼다(`REQ-RAG-3.1.1`). `chunk.text`는 받은 그대로 저장한다(`REQ-RAG-3.1.2`). `job_id`는 레코드를 만든 작업의 ID로 채운다(`REQ-RAG-10.8.5.3`). 새 버전의 레코드를 모두 저장한 뒤에만 그 버전을 `active`로 바꾸고, 같은 문서의 이전 버전 레코드를 지운다(`REQ-RAG-3.3`). 새 버전 저장이 실패하면 이전 버전의 `active` 레코드를 바꾸지 않는다(`REQ-RAG-10.3.4`). 판을 색인하거나 지우거나 이름·판 정보를 바꿀 때마다 관련된 이름의 `is_latest_edition`을 다시 맞춘다(`REQ-RAG-3.6.3`, `REQ-RAG-3.6.5`). 금지: 이름·판 정보가 같은 다른 문서의 레코드를 지우지 않는다. 문서 레코드는 그 문서의 버전 교체와 Backend의 문서 삭제 요청으로만 지운다(`REQ-RAG-3.3`, `REQ-RAG-3.4.1`, `REQ-RAG-3.6.6`). 전제: chunking의 보장, 모든 자리표시 ID에 요약·캡션이 있다는 루트 `IF-1`의 Backend 보장.
- **resource** (저장) — 보장: 받은 레코드의 필드를 바꾸지 않고 저장하고 그대로 돌려준다. 저장된 `dense` 벡터의 차원이 지금 임베딩 모델과 다르면 저장·조회를 하지 않고 오류를 낸다(`REQ-RAG-12.2.2`). 금지: 레코드의 필드를 스스로 채우거나 바꾸지 않는다.
- **search** (소비) — 보장: `active`가 `True`인 레코드만 결과에 넣는다(`REQ-RAG-3.3.1`, `REQ-RAG-3.3.2`). 결과 본문은 `chunk.text`를 그대로 쓴다(`REQ-RAG-4.3.4`). 연관 청크는 `split_group`·`split_index`와 `order`로 찾는다(`REQ-RAG-4.4`). 판 범위는 `name`·`edition`·`is_latest_edition`으로 거른다(`REQ-RAG-4.5`). 문서 청크 조회는 그 문서의 `active` 레코드를 `order` 순으로 돌려준다(`REQ-RAG-4.7`). 질의 임베딩은 색인에 쓴 것과 같은 임베딩 모델로 만든다. 전제: indexing·resource의 보장. 금지: 레코드를 저장하거나 지우지 않는다.

### 오류

| 실패 | 발생 단위 | 전달 형태 | 받는 단위의 처리 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| 자리표시 보존 검증을 설정한 횟수만큼 실패 | chunking | 대체 분할로 만든 결과와 `fallback_used=True` | indexing은 그대로 색인하고, 작업 결과에 대체 분할 여부를 남긴다(service `MODULE.md`) | `REQ-RAG-2.3` |
| 벡터 차원 불일치 | resource | 예외 | 색인·검색 요청에 오류를 알린다 | `REQ-RAG-12.2.2` |
| Qdrant 연결 실패 | resource | 예외 | 색인·검색 요청에 오류를 알린다 | `REQ-RAG-12.2.1` |

### 검증

| 검증할 것 | 담당 단위 | 종류 | 대체 경계 |
| :--- | :--- | :--- | :--- |
| 자리표시 정확히 한 번·잘리지 않음, `Chunk` 필드 불변 조건, 분할 조각 겹침 없음 | chunking | unit | resource (분할 LLM) |
| 색인 텍스트 치환, `chunk.text` 보존, `active` 전환 순서, 실패 시 이전 버전 유지, `is_latest_edition` 재계산, 같은 이름·판 다른 문서 레코드 유지 | indexing | unit | resource |
| 필드 왕복 보존, 차원 불일치 거부 | resource | integration | |
| `active` 레코드만 반환, 결과 본문이 `chunk.text`, 연관 청크 찾기 | search | unit | resource |
