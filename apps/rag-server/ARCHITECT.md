# minerva RAG Server 아키텍처

RAG Server는 Backend의 요청을 받아 요약·캡션 생성, 청킹, 색인, 검색을 하는 minerva의 내부 연산 서비스다. 요구는 이 폴더의 `REQUIREMENTS.md`가 정의하며, 요구사항의 depth-1 모듈 하나가 단위 하나다. 계층은 api → service → 기능 단위 → resource 순으로 내려가고, 단위를 엮는 일과 앱 기동·종료는 service 한 곳에서만 한다. 문서에 속한 데이터는 Backend가 소유하며, RAG Server는 Backend가 요청에 담아 보낸 데이터만 처리하고 검색 인덱스만 소유한다. 이 문서의 경로는 `apps/rag-server/` 기준이다.

## 기술 스택

| 영역 | 선택 | 버전·제약 |
| :--- | :--- | :--- |
| 언어 | Python | 3.12 |
| 웹 프레임워크 | FastAPI | |
| 패키지 관리 | uv | `pyproject.toml` + `uv.lock` |
| 로깅·테스트 | structlog, pytest | |
| 검색 인덱스 | Qdrant | dense 벡터와 BM25 sparse 벡터 |
| 작업 목록 저장소 | SQLite | 로컬 파일 |
| LLM·VLM 서빙 | Ollama | |
| 임베딩·재정렬 실행 | sentence-transformers | RAG Server 프로세스 안에서 실행. GPU가 있으면 GPU, 없으면 CPU (`REQ-RAG-12.1.3`) |
| PyTorch 휠 | 기본 CPU 휠, GPU 배포는 CUDA 휠 | CUDA 휠은 `pyproject.toml`의 선택 설치 항목으로만 받는다. 라이선스 예외는 저장소 루트 `AGENTS.md` 「라이선스」 |
| 모델 구성 | `REQUIREMENTS.md` 「제약과 가정」 | |

## 시스템 컨텍스트

```mermaid
flowchart LR
    Backend --> RAG["RAG Server"]
    RAG -. 작업 상태 알림 .-> Backend
    RAG --> Qdrant[/"Qdrant"/]
    RAG --> Ollama[/"Ollama"/]
```

- RAG Server를 호출하는 것은 Backend뿐이다
- RAG Server가 Backend로 보내는 것은 작업 상태 알림(`REQ-RAG-10.8.7`)뿐이다

## 단위 구성

| 단위 | 종류 | 폴더 | 담당 REQ | 책임 |
| :--- | :--- | :--- | :--- | :--- |
| api | 모듈 | `src/minerva_rag/api` | `REQ-RAG-9` | HTTP 라우팅, 요청·응답 형식, HTTP 오류 변환 |
| service | 모듈 | `src/minerva_rag/service` | `REQ-RAG-10` | 서비스마다 처리 순서를 정하고 단위를 엮는다. 앱 기동·종료를 맡는다. 색인 작업의 접수·순서·상태를 관리하고 Backend에 상태를 알린다. 표 요약과 이미지 캡션을 만든다. 일괄 색인의 단계(분할 단계, 임베딩 단계)를 정해 단계마다 모델을 내리고 올리게 하고, 일괄 색인 중 검색·평가를 거부한다 |
| chunking | 모듈 | `src/minerva_rag/chunking` | `REQ-RAG-2` | 색인용 MD를 청크로 나눈다 |
| indexing | 모듈 | `src/minerva_rag/indexing` | `REQ-RAG-3` | 색인 텍스트를 만들고 버전 교체·판·삭제·중복 방지를 정한다 |
| search | 모듈 | `src/minerva_rag/search` | `REQ-RAG-4` | 질의 확장부터 하이브리드 검색, 재정렬, 결과 구성, 연관 청크 확장, 판 처리까지 검색 한 번을 처리하고, 문서 청크 목록을 돌려준다. 질의 확장에 쓰는 용어집을 읽고 검증한다 |
| evaluation | 모듈 | `src/minerva_rag/evaluation` | `REQ-RAG-6` | 골든셋 한 건으로 검색해 지표를 계산한다. 저장하지 않는다 |
| core | 모듈 | `src/minerva_rag/core` | `REQ-RAG-11` | 설정, 로깅, 오류 정의, 단위 사이 공유 타입(`INTERFACES.md`의 `IF-RAG-1` 청크 타입, 실패 위치, 키워드 벡터 타입), 자리표시(루트 `IF-1`) 읽기 |
| resource | 모듈 | `src/minerva_rag/resource` | `REQ-RAG-12` | LLM·VLM·임베딩·재정렬 모델을 준비하고 호출하며, GPU 메모리에 올리고 내린다. 색인과 질의가 같이 써야 하는 BM25 키워드 벡터도 만든다. Qdrant에 연결해 컬렉션을 구성하고 청크를 저장·삭제·조회한다 |

`REQ-RAG-8`은 예정 마일스톤(M-2)이라 단위를 두지 않는다.

## 의존 규칙

```mermaid
flowchart TB
    api --> service
    service --> chunking
    service --> indexing
    service --> search
    service --> evaluation
    service --> resource
    evaluation --> search
    chunking --> resource
    indexing --> resource
    search --> resource
    api --> core
    service --> core
    chunking --> core
    indexing --> core
    search --> core
    evaluation --> core
    resource --> core
```

**금지 의존**

- Qdrant와 LLM·VLM·임베딩·재정렬 모델에는 resource만 접근한다. resource로 청크를 저장·삭제하는 것은 indexing만 하고, search는 조회만 한다
- 단위 조립(의존 주입)과 앱 기동·종료 처리는 service에서만 한다. api는 service가 만든 기동·종료 처리를 FastAPI 수명주기에 연결만 한다. service가 resource에 직접 기대는 것은 조립, 기동·종료(연결, 모델 준비), 상태 확인, 표 요약·이미지 캡션 생성(`REQ-RAG-10.2`), 일괄 색인 단계마다 모델 올리기·내리기(`REQ-RAG-10.8.8`)뿐이다
- 검색 한 번의 처리 순서(`REQ-RAG-10.4.1`)는 search 안에서 지킨다. 검색 서비스와 evaluation은 search를 한 번 부른다
- Backend로 보내는 HTTP 호출은 service의 작업 상태 알림만 한다

**호출 방식**

- Backend ↔ RAG Server: HTTP. 작업 상태 알림은 설정된 Backend 주소로 보낸다
- 단위 사이: import
- evaluation: service의 평가 서비스가 부르고, evaluation은 search를 import해 검색 서비스와 같은 처리로 결과를 만든다

## 폴더 구조와 배치 규칙

```text
apps/rag-server/
├── src/minerva_rag/
│   ├── api/  service/
│   ├── chunking/  indexing/  search/  evaluation/
│   └── core/  resource/
├── tests/
│   ├── unit/
│   └── integration/
├── config/
├── pyproject.toml
├── uv.lock
├── REQUIREMENTS.md
├── ARCHITECT.md
└── AGENTS.md
```

- 단위의 명세는 그 단위 폴더의 `MODULE.md`다
- 단위 폴더 안에 하위 패키지를 두지 않는다. 기능(depth-2)과 파일의 대응은 각 `MODULE.md`의 「예상 배치」가 정한다
- service 단위는 depth-2 서비스(`REQ-RAG-10.1`~`REQ-RAG-10.7`) 하나를 파일 하나로 둔다: 수명주기, 요약·캡션, 색인, 검색, 문서 삭제, 이름·판 정보, 평가 서비스. 색인 작업 관리(`REQ-RAG-10.8`)와 요약·캡션 생성(`REQ-RAG-10.2.2`, `REQ-RAG-10.2.3`)은 서비스 파일들이 쓰는 헬퍼 파일로 둔다
- RAG Server 안 단위 사이 계약은 이 폴더의 `INTERFACES.md`(`IF-RAG-<n>`)에, 앱 사이 계약(자리표시 형식, 작업 상태 알림)은 저장소 루트의 `INTERFACES.md`(`IF-<n>`)에 둔다
- Backend가 호출하는 API의 명세는 이 폴더의 `API.md`에 둔다
- 테스트는 `tests/`에 둔다. `unit/`은 외부 자원 없이 실행되고, `integration/`은 Qdrant·Ollama가 필요하다
- 용어집은 `config/glossary.yaml`에 둔다

## 데이터·상태 소유

| 데이터·상태 | 소유 단위 | 저장 위치 | 읽는 단위 | 쓰는 단위 |
| :--- | :--- | :--- | :--- | :--- |
| 청크·벡터 (판 정보 사본 포함) | indexing | Qdrant (resource 경유) | indexing, search | indexing |
| 작업 목록·작업 상태·문서 색인 상태 | service | SQLite 파일 (「실행 구조」의 로컬 파일) | service | service |
| 용어집 | search | `config/glossary.yaml` | search | 관리자 (파일 편집) |
| 일괄 색인 상태(지금 단계, 남은 작업 수), 임베딩을 기다리는 작업의 청크 | service | 프로세스 메모리. 다시 시작하면 사라지며, 그 작업은 서버 재시작 실패로 기록된다(`REQ-RAG-10.8.5`) | service | service |

- 원본 MD, 색인용 MD, 표·이미지, 요약·캡션, 문서 이름·판 정보, 골든셋, 평가 기록은 Backend가 소유한다. RAG Server는 요청에 담겨 온 것만 처리하고 요약·캡션을 저장하지 않는다 (`REQ-RAG-10.2.2.2`, `REQ-RAG-10.2.3.2`)

## 횡단 관심사

| 관심사 | 소유 단위 | 규칙 위치 |
| :--- | :--- | :--- |
| 설정 | core | `REQ-RAG-11.1`, `AGENTS.md` |
| 로깅 | core | `REQ-RAG-11.2`, 저장소 루트 `AGENTS.md` 「보안과 로그」, 이 폴더의 `AGENTS.md` |
| 오류 정의 | core | `REQ-RAG-11.3`, `AGENTS.md` |
| HTTP 오류 응답 변환 | api | `REQ-RAG-11.3` |
| 모델 호출 | resource | `REQ-RAG-12`, `REQUIREMENTS.md` 「제약과 가정」 |
| 저장소 접근 | resource | `REQ-RAG-12.2` |
| 단위 조립, 앱 기동·종료 | service | `REQ-RAG-10.1`, 이 문서 「의존 규칙」 |

## 주요 흐름

### 색인

```mermaid
sequenceDiagram
    participant BE as Backend
    participant API as api
    participant SV as service
    participant C as chunking
    participant I as indexing
    participant R as resource
    BE->>API: 요약·캡션 요청 (이미지, 그다음 표)
    API->>SV: 요약·캡션 서비스
    SV->>R: 임베딩·재정렬 모델 내림, 생성
    BE->>API: 색인 요청
    API->>SV: 색인 서비스
    SV->>I: 체크섬 확인
    SV-->>BE: 작업 ID
    SV->>C: 분할 (분할 대기 작업 모두)
    C-->>SV: 청크
    SV->>R: LLM 내림
    SV->>I: 색인 (임베딩 대기 작업 모두)
    I->>R: 임베딩·저장·이전 버전 삭제
    SV->>R: 임베딩·재정렬 모델 올림
    SV->>BE: 상태 알림
```

앱 사이의 요청 순서와 일괄 색인 중 거부는 저장소 루트 `INTERFACES.md`의 `IF-3`이 소유한다.

1. **요약·캡션** — Backend가 예약 색인에서 요약·캡션을 요청하면 service가 임베딩·재정렬 모델을 GPU 메모리에서 내린 뒤 resource로 만든다. 임베딩 단계 중에 온 요청은 그 단계가 끝난 뒤 처리한다. (`REQ-RAG-10.2`, `REQ-RAG-10.8.8.5`)
2. **중복 확인과 접수** — 색인 서비스가 indexing으로 체크섬을 확인하고, 다시 색인해야 할 때만 작업을 접수한다. (`REQ-RAG-10.3.1`, `REQ-RAG-3.5`, `REQ-RAG-10.8.1`)
3. **분할 단계** — 분할을 기다리는 작업이 있는 동안 색인 서비스가 순서대로 chunking으로 청크를 만들고, 그 작업을 임베딩 대기로 둔다. (`REQ-RAG-10.3.2`, `REQ-RAG-10.8.3`, `REQ-RAG-10.8.8.1`, `REQ-RAG-2`)
4. **임베딩 단계** — 분할을 기다리는 작업이 없으면 service가 resource로 분할·요약·캡션 모델을 내리고, 임베딩 대기 작업을 차례로 indexing에 넘긴다. indexing이 resource로 임베딩·저장하고 이전 버전을 지운다. 이 단계 중에 접수한 작업은 단계가 끝난 뒤 분할한다. (`REQ-RAG-10.8.8.2`~`REQ-RAG-10.8.8.4`, `REQ-RAG-3`)
5. **일괄 색인 끝** — 일괄 색인이 끝나면(`REQUIREMENTS.md` 「용어」 일괄 색인) service가 임베딩·재정렬 모델을 GPU 메모리에 올린다. (`REQ-RAG-10.8.8.6`)
6. **알림** — service가 작업 상태가 바뀔 때마다 Backend에 알린다. (`REQ-RAG-10.8.7`)

### 검색

```mermaid
sequenceDiagram
    participant BE as Backend
    participant API as api
    participant SV as service
    participant S as search
    participant R as resource
    BE->>API: 검색 요청
    API->>SV: 검색 서비스
    SV->>S: 검색
    S->>S: 질의 확장
    S->>R: 질의 임베딩
    S->>R: 청크 조회
    S->>R: 재정렬
    S-->>SV: 결과 N개
    SV-->>API: 결과
    API-->>BE: 결과
```

1. **일괄 색인 확인** — 일괄 색인 중이면 검색 서비스가 검색하지 않고 거부한다. 평가 서비스도 같다. (`REQ-RAG-10.4.3`, `REQ-RAG-10.7.2`)
2. **질의 확장** — search가 용어집으로 동의어를 넣는다. (`REQ-RAG-4.9`)
3. **검색** — search가 resource로 dense·키워드 검색을 하고 순위를 합친다. (`REQ-RAG-4.1`)
4. **재정렬과 반환** — search가 resource로 재정렬하고 연관 청크·판 정보를 붙여 돌려준다. (`REQ-RAG-4.2`~`REQ-RAG-4.5`, `REQ-RAG-10.4`)

## 실행 구조

- **RAG Server 프로세스** — FastAPI 앱 하나가 HTTP API와 색인 작업 처리기를 함께 실행한다. 동시에 분할하는 작업 수와 동시에 임베딩·저장하는 작업 수는 각각 설정값이다 (`REQ-RAG-10.8.3.1`)
- **GPU 메모리** — 일괄 색인 밖에서는 임베딩·재정렬 모델만 GPU에 둔다. 일괄 색인 중에는 분할·요약·캡션 모델(Ollama)과 임베딩·재정렬 모델이 GPU를 함께 쓰지 않게 단계마다 내리고 올린다 (`REQ-RAG-10.8.8`, `REQ-RAG-12.1.3`)
- **기동 순서** — 용어집 읽기, 모델 준비, Qdrant 연결(모델의 임베딩 차원으로), 작업 처리기 시작을 차례로 마친 뒤 요청을 받는다 (`REQ-RAG-10.1.1`, `REQ-RAG-4.8`)
- **Qdrant, Ollama** — RAG Server보다 먼저 떠 있어야 한다. 로컬 개발에서는 저장소 루트의 `docker-compose.yml`로 띄우고, 데이터는 named volume `qdrant-data`(Qdrant)와 `ollama-models`(Ollama 모델)에 둔다
- **로컬 파일** — RAG Server 프로세스가 직접 쓰는 작업 목록 SQLite(`data/rag-server/jobs.sqlite3`)와 임베딩·리랭커 모델 파일(`data/rag-server/models`)은 저장소 루트의 `data/` 아래에 둔다. 위치는 설정으로 바꿀 수 있고, 모델 파일을 이 위치에 미리 받아 두면 기동할 때 내려받지 않는다
- **Backend 알림 주소** — 설정으로 받는다

## 설계 결정

- **ARCHITECT.md는 앱 폴더마다 둔다** — 이유: 앱마다 요구사항 문서를 따로 두고, 앱마다 언어와 구조가 다르다. 버린 대안: 루트에 하나
- **api 아래에 service 계층을 둔다** — 이유: 처리 순서와 단위 조립을 한 곳에 모아, 순서를 바꿀 때 service만 고치게 한다. 버린 대안: api가 단위를 직접 엮는 구조. (`REQ-RAG-10`)
- **한 모듈만 쓰는 기능은 따로 모듈을 두지 않고 그 모듈의 기능으로 둔다** — 이유: 기능마다 모듈을 두면 소비자가 하나뿐인 모듈과 그 사이 계약이 생겨 구조만 복잡해진다. 작업 관리(`REQ-RAG-10.8`)와 요약·캡션 생성(`REQ-RAG-10.2.2`, `REQ-RAG-10.2.3`)은 서비스 모듈, 용어집(`REQ-RAG-4.8`, `REQ-RAG-4.9`)은 검색 모듈의 기능이다. chunking·indexing은 소비자가 service뿐이지만 색인의 핵심 도메인이라 모듈로 둔다. 버린 대안: 기능 영역마다 모듈 하나(요구사항 `REV-1`의 구조), 모듈 안의 하위 패키지. (`REQ-RAG-4`, `REQ-RAG-10`)
- **평가는 단위로 둔다** — 이유: 검색 결과를 정답 구간과 대조하는 규칙이 Backend의 정답 구간 확인(`REQ-BE-5.1.5`)과 맞물려 한곳에 모아야 하고, 골든셋 평가를 넓힐 때 들어갈 자리다. 버린 대안: service 안의 파일. (`REQ-RAG-6`)
- **Qdrant와 모델 접근은 resource 단위로 분리한다** — 이유: search가 indexing에 기대지 않게 하고, 기능 단위를 Qdrant·모델 없이 단위 테스트할 수 있게 한다. 둘 다 외부 자원 어댑터로 기능 단위 아래 같은 층에 놓여 한 단위로 둔다. 버린 대안: indexing 안에서 Qdrant에 접근, 모델과 Qdrant를 단위 둘로 나누기. (`REQ-RAG-12`, `REQ-RAG-12.2`)
- **LangChain을 쓰지 않는다** — 이유: 분할·자리표시 검증·재분할을 직접 제어해야 한다. 버린 대안: LangChain 1.x. (`REQ-RAG-2`)
- **작업 목록은 SQLite 파일** — 이유: 프로세스 하나에 동시 처리 수가 작아 인프라를 늘릴 필요가 없다. 버린 대안: Qdrant 컬렉션, Redis. (`REQ-RAG-10.8.5.1`)
- **작업 처리기는 RAG Server 프로세스 안** — 이유: 처리기를 따로 띄우면 기동·배포 단위가 늘어난다. 버린 대안: 별도 워커 프로세스. (`REQ-RAG-10.8.3`)
- **패키지 관리는 uv** — 이유: `pyproject.toml`과 lock 파일을 한 도구로 관리한다. 버린 대안: venv + pip + lock 파일
- **일괄 색인은 단계로 나눠 GPU를 한 종류의 모델에 쓴다** — 이유: 16GB GPU에 분할 LLM(qwen3:14b, 약 11.7GB)과 검색 모델(임베딩 Qwen3-Embedding-0.6B fp16 약 1.2GB, 재정렬 약 2.3GB)을 함께 올리면 재정렬 작업 메모리와 화면 등 다른 프로그램이 쓸 자리가 남지 않고, 문서마다 바꿔 올리면 교체 비용이 문서 수만큼 든다. 색인은 Backend의 예약 색인(자정), 검색은 낮으로 시간이 나뉜다(`apps/backend/REQUIREMENTS.md` `REQ-BE-1.10.1`). 버린 대안: 모델을 함께 올려 두기(메모리 부족), 문서마다 모델 바꾸기, 임베딩·재정렬을 CPU로 고정(검색 1건에 약 25초). (`REQ-RAG-10.8.8`, `REQ-RAG-12.1.3`)
- **임베딩은 Qwen3-Embedding-0.6B** — 이유: 4B(fp16 약 8GB)는 재정렬 모델과 함께 올리면 화면 등 다른 프로그램과 함께 16GB GPU가 차서 검색 1건이 1~54초로 흔들렸다. 0.6B는 영어 초안 1개로 잰 측정에서 같은 청크 기준 상위 10개 적중이 키워드가 겹치는 질문 60개 중 1건, 겹치지 않는 질문 60개 중 2건 적었고 1위 적중은 같았으며, 검색은 약 1초로 고르다(4B는 5초 이상). 버린 대안: 4B 유지(GPU 메모리 부족), 4B 8비트 양자화(새 의존성), 다른 1B 안팎 모델(공개 다국어 점수가 0.6B보다 낮다). (`REQ-RAG-3.2.1`, `REQ-RAG-12.1.3`)
- **일괄 색인 중 검색·평가는 거부한다** — 이유: 분할 단계에는 검색 모델을 올릴 GPU 메모리가 없고, 일괄 색인은 Backend의 호출 시간 제한(기본 30초) 안에 끝나지 않는다. 버린 대안: CPU로 처리, 검색이 오면 GPU를 내주기. (`REQ-RAG-10.4.3`, `REQ-RAG-10.7.2`)
- **CUDA 휠은 GPU 배포용 선택 설치** — 이유: CUDA 런타임은 허용 라이선스 밖이라 기본 설치에 넣지 않는다(사용자 승인 예외). 버린 대안: 기본 설치를 CUDA로. (`REQ-RAG-12.1.3`)
