# minerva 앱 사이 인터페이스 명세

이 문서는 앱(Console, Backend, RAG Server) 사이에서 공유하는 계약 중, 한 앱의 API 명세로 정할 수 없는 것을 소유한다. 앱 안 단위 사이 계약은 각 앱 폴더의 `INTERFACES.md`가, 한 앱이 제공하는 HTTP API는 그 앱 폴더의 `API.md`가 소유한다. 참여하는 앱과 단위의 명세는 IF ID로 가리키기만 한다.

## 계약 목록

| ID | 계약 | 참여 단위 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| `IF-1` | 자리표시 | Backend assets, RAG Server chunking·indexing·search | `REQ-BE-2.1`, `REQ-BE-2.2`, `REQ-BE-2.3`, `REQ-BE-4.2`, `REQ-RAG-2.2`, `REQ-RAG-2.4`, `REQ-RAG-3.1`, `REQ-RAG-4.3.4` |
| `IF-2` | 작업 상태 알림 | RAG Server service, Backend indexing | `REQ-RAG-10.8.2`, `REQ-RAG-10.8.6`, `REQ-RAG-10.8.7`, `REQ-BE-3.2` |
| `IF-3` | 일괄 색인 | Backend documents·assets·indexing·search·evaluation, RAG Server service | `REQ-BE-1.10.1`, `REQ-BE-1.10.9`, `REQ-BE-2.3.7`, `REQ-BE-5.2.9`, `REQ-BE-10.1.5`, `REQ-RAG-10.2.4`, `REQ-RAG-10.4.3`, `REQ-RAG-10.7.2`, `REQ-RAG-10.8.8` |

## IF-1 자리표시

Backend는 원본 MD의 표·이미지 자리를 자리표시로 바꾼 색인용 MD를 RAG Server에 보내고, RAG Server는 자리표시를 보존한 청크를 돌려주며, Backend는 검색 결과의 자리표시를 다시 원래 표·이미지로 복원한다. 만드는 쪽과 읽는 쪽이 다른 앱이고 양쪽이 같은 형식에 기대야 하므로 한 앱의 명세로 정할 수 없다.

### 참여 단위

| 단위 | 역할 | 관련 REQ |
| :--- | :--- | :--- |
| Backend assets | 정의, 생산 (자리표시와 요약·캡션), 소비 (복원) | `REQ-BE-2.1.3`, `REQ-BE-2.2`, `REQ-BE-2.3.2`, `REQ-BE-2.5` |
| RAG Server chunking | 소비 (보존) | `REQ-RAG-2.2`, `REQ-RAG-2.4` |
| RAG Server indexing | 소비 (색인 텍스트 치환) | `REQ-RAG-3.1` |
| RAG Server search | 소비 (원문 반환) | `REQ-RAG-4.3.4` |

### 계약 표면

자리표시는 색인용 MD 본문 안의 한 줄 문자열이다.

```text
[[minerva:{kind}:{placeholder_id} | {description}]]
```

| 요소 | 형식 | 불변 조건 |
| :--- | :--- | :--- |
| `kind` | `table` 또는 `image` | 표는 `table`, 이미지는 `image` |
| `placeholder_id` | 영문 소문자·숫자 | 문서 한 버전 안에서 고유하다 |
| `description` | 문자열 | 표·이미지를 짧게 설명한다. 비어 있지 않고, 줄바꿈과 `]]`를 담지 않으며, 끝 글자가 `]`가 아니다 |

자리표시는 `[[minerva:`에서 시작해 그 뒤에 처음 나오는 `]]`에서 끝난다. `description`의 끝 글자가 `]`이면 `…]]]`의 앞쪽 `]]`에서 끝난 것으로 읽혀 `]` 하나가 본문에 남으므로, 끝 글자 조건은 양쪽이 같은 끝을 읽기 위한 것이다.

색인 요청은 자리표시 ID마다 요약·캡션 문장을 함께 담는다. 그 형식은 `apps/rag-server/API.md`가 소유한다.

### 의무

- **Backend assets** (정의, 생산) — 보장: 색인용 MD의 표·이미지마다 자리표시를 하나씩 넣고, `placeholder_id`를 문서 버전 안에서 고유하게 정한다(`REQ-BE-2.1.3`, `REQ-BE-2.2.1`). 표 안의 이미지는 그 표의 일부라 자리표시를 따로 넣지 않고 표의 자리표시에 포함한다(`apps/backend/REQUIREMENTS.md` 「용어」 표·이미지). `description`은 계약 표면의 조건을 지킨다. 코드 블록 안의 표·이미지 모양은 자리표시로 바꾸지 않는다(`REQ-BE-2.1.2`). 원본 본문에 자리표시와 같은 모양의 문자열이 있으면 자리표시로 읽히지 않게 바꿔 넣는다(`REQ-BE-2.2.2`). 색인 요청에 색인용 MD의 모든 `placeholder_id`에 대한 요약·캡션을 담고, 만들지 못한 것은 임시 설명으로 채운다(`REQ-BE-2.3.2`, `REQ-BE-3.1.1`).
- **Backend assets** (소비) — 보장: 청크 본문의 표 자리표시를 그 버전의 원본 Markdown 표(표 안 짝 있는 이미지의 경로는 그 버전의 이미지 주소로 바꾼 것)로, 이미지 자리표시를 그 버전의 이미지 주소와 캡션으로 복원한다(`REQ-BE-2.5`). 검색 결과와 문서 청크 조회는 이 복원을 쓴다(`REQ-BE-4.2.1`, `REQ-BE-1.4.5`). 전제: RAG Server가 결과·청크와 함께 그 버전을 알려 준다(`apps/rag-server/API.md`).
- **RAG Server chunking** (소비) — 보장: 자리표시를 바꾸거나 자르지 않고 청크 하나에 원형 그대로 정확히 한 번 담는다(`REQ-RAG-2.2`). 전제: Backend의 고유성·형식 보장.
- **RAG Server indexing** (소비) — 보장: 색인 텍스트에서만 자리표시 전체를 그 `placeholder_id`의 요약·캡션 문장으로 바꾸고, 저장하는 청크 원문은 바꾸지 않는다(`REQ-RAG-3.1`). 전제: 모든 `placeholder_id`에 요약·캡션이 있다는 Backend의 보장.
- **RAG Server search** (소비) — 보장: 결과 본문에 자리표시를 원형 그대로 담아 돌려준다(`REQ-RAG-4.3.4`).

### 검증

| 검증할 것 | 담당 단위 | 종류 | 대체 경계 |
| :--- | :--- | :--- | :--- |
| 자리표시 보존 | RAG Server chunking | unit | 분할 LLM |
| 색인 텍스트 치환과 원문 보존 | RAG Server indexing | unit | Qdrant, 임베딩 모델 |
| 결과 본문의 자리표시 원형 | RAG Server search | unit | Qdrant |
| 자리표시 고유성, 코드 블록 제외, 이스케이프, `description` 조건, 표 안 이미지 자리표시 없음, 요약·캡션 빠짐 없음 | Backend assets | unit | RAG Server (요약·캡션 생성) |
| 표·이미지 복원 | Backend assets | unit | 저장소 |

## IF-2 작업 상태 알림

RAG Server의 service는 작업 상태가 바뀔 때마다 Backend에 알리고, Backend는 이를 받아 문서 상태를 갱신하며 Console은 Backend를 다시 조회해 상태를 본다. 보내는 쪽이 RAG Server이고 받는 쪽이 Backend라, RAG Server가 제공하는 API(`apps/rag-server/API.md`)에 넣을 수 없다.

### 참여 단위

| 단위 | 역할 | 관련 REQ |
| :--- | :--- | :--- |
| RAG Server service | 정의, 생산 | `REQ-RAG-10.8.2`, `REQ-RAG-10.8.6`, `REQ-RAG-10.8.7` |
| Backend indexing | 소비 | `REQ-BE-3.2` |

### 계약 표면

RAG Server는 설정한 Backend 알림 주소로 HTTP `POST`를 보낸다. 요청 헤더 `X-Minerva-Token`에 설정한 알림 토큰을 담고, 본문은 JSON이다.

| 필드 | 타입 | 필수 | 불변 조건 |
| :--- | :--- | :--- | :--- |
| `doc_id` | string | 필수 | 색인 요청의 문서 ID |
| `job_id` | string | 필수 | 상태가 바뀐 작업의 ID |
| `version` | string | 필수 | 그 작업이 색인하는 문서 버전 |
| `job_state` | string | 필수 | `queued`·`running`·`succeeded`·`failed`·`superseded` 중 하나 (색인 대기·색인 중·완료·실패·대체됨) |
| `index_state` | object | 필수 | 알림을 보내는 시점의 문서 색인 상태(`REQ-RAG-10.8.6.1`) |
| `index_state.searchable_version` | string 또는 null | 필수 | 현재 검색되는 버전. 없으면 `null` |
| `index_state.latest_job_id` | string | 필수 | 그 문서의 최신 작업 ID |
| `index_state.latest_job_state` | string | 필수 | 그 문서의 최신 작업 상태. 값은 `job_state`와 같은 목록 |
| `index_state.latest_job_stage` | string 또는 null | 필수 | 최신 작업이 `running`이면 그 시점의 단계(`chunking`·`embedding_pending`·`embedding`·`storing`, 분할·임베딩 대기·임베딩·저장, `REQ-RAG-10.8.2.3`), 아니면 `null` |
| `sequence` | integer | 필수 | 문서마다 1부터 시작해 알림마다 1씩 커진다 |

Backend가 2xx로 응답하면 받은 것으로 본다. 알림 토큰이 없거나 다르면 Backend는 `401`로 응답하고 반영하지 않는다. 본문이 위 표와 다르면(필드 없음, 표에 없는 필드 있음, 허용값 밖, `sequence`가 1 이상의 정수가 아님) Backend는 `400`으로 응답하고 반영하지 않는다. ★ 표에 없는 필드도 거부하므로 알림에 필드를 더하려면 이 표와 Backend를 함께 바꿔야 한다. 토큰 검사가 본문 검사보다 먼저다 — 토큰이 없으면 본문이 잘못돼도 `401`이다. 응답 상태와 본문의 정확한 형식은 `apps/backend/API.md`의 `POST /v1/internal/rag-events`가 소유한다.

알림 본문에는 작업 결과와 실패 사유가 없다. Backend는 `succeeded`·`failed` 알림을 받으면 `apps/rag-server/API.md`의 `GET /v1/index-jobs/{job_id}`로 결과(`result`)나 실패 사유(`failure`)를 조회한다.

### 의무

- **RAG Server service** (정의, 생산) — 보장: 작업 상태가 바뀔 때마다 알림을 하나 보낸다(`REQ-RAG-10.8.7.1`). 색인 중 단계가 바뀌는 것은 알리지 않는다(`REQ-RAG-10.8.7.2`). 2xx를 받지 못하면 설정한 횟수(기본 5회)만큼, 1초에서 시작해 두 배씩 늘어나는 간격으로 다시 보낸다(`REQ-RAG-10.8.7.3`). 같은 알림을 다시 보낼 때는 `sequence`를 바꾸지 않는다(`REQ-RAG-10.8.7.4`). 모든 알림에 알림 토큰을 담는다(`REQ-RAG-10.8.7.5`). 알림을 보내기 전에 그 상태와 결과·실패 사유를 기록해, 알림을 받은 뒤의 작업 조회가 알림과 같거나 더 나중의 상태를 돌려준다(`REQ-RAG-10.8.2.2`, `REQ-RAG-10.8.2.4`, `REQ-RAG-10.8.2.6`). 금지: 알림 외에 Backend의 다른 기능을 호출하지 않는다(`apps/rag-server/ARCHITECT.md` 「의존 규칙」).
- **Backend indexing** (소비) — 보장: 알림 토큰이 맞으면 2xx로 응답하고(`REQ-BE-3.2.1`), 없거나 다르면 `401`로 응답하고 반영하지 않는다(`REQ-BE-3.2.5`). 문서마다 이미 반영한 `sequence`보다 작거나 같은 알림은 반영하지 않으며, 같은 알림을 두 번 받아도 결과가 같다(`REQ-BE-3.2.4`). 알림이 끝내 오지 않아도 주기적으로 색인 상태를 조회해 맞춘다(`REQ-BE-3.3.1`). `succeeded` 알림의 결과를 조회하지 못하면 그 알림을 반영하지 않고(순번도 올리지 않는다) 상태 맞추기에 맡기며, `failed` 알림의 실패 사유를 조회하지 못하면 사유 코드 `RAG_UNREACHABLE`로 반영한다(`REQ-BE-3.2.2`·`REQ-BE-3.2.3`을 구체화한 `apps/backend/src/indexing/MODULE.md`의 결정). 받는 주소는 `apps/backend/API.md`의 `POST /v1/internal/rag-events`다. 전제: RAG Server의 `sequence` 보장과 작업 조회 보장.

### 오류

| 실패 | 발생 단위 | 전달 형태 | 받는 단위의 처리 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| 알림 전송 실패·2xx 아닌 응답(`401`·`400` 포함) | Backend 또는 네트워크 | HTTP 응답·연결 실패 | RAG Server service가 설정한 횟수만큼 다시 보낸다 | `REQ-RAG-10.8.7.3` |

### 검증

| 검증할 것 | 담당 단위 | 종류 | 대체 경계 |
| :--- | :--- | :--- | :--- |
| 상태 변경마다 알림, 단계 변경은 알리지 않음, 재전송 횟수, `sequence` 증가·재전송 시 유지, 알림 토큰 헤더 | RAG Server service | unit | Backend (가짜 HTTP 수신자) |
| 알림 전 상태·결과·실패 사유 기록 | RAG Server service | unit | `IndexRunner` (가짜), Backend (가짜 HTTP 수신자) |
| 2xx 응답, 오래된 `sequence` 무시, 중복 수신, 토큰 불일치 `401`, 본문 오류 `400`, 결과·실패 사유 조회 실패 처리 | Backend indexing | unit | RAG Server (가짜 알림, 가짜 작업 조회) |


## IF-3 일괄 색인

Backend는 예약 색인에서 요약·캡션과 색인을 몰아서 요청하고, RAG Server는 그 동안을 일괄 색인으로 다뤄 단계마다 GPU에 한 종류의 모델만 올린다. 요청 순서는 Backend가, 단계와 그 동안의 거부는 RAG Server가 지키고, 거부를 받은 Backend가 그 사실을 전해야 결과가 맞으므로 한 앱의 명세로 정할 수 없다.

### 참여 단위

| 단위 | 역할 | 관련 REQ |
| :--- | :--- | :--- |
| Backend documents | 조정 (예약 색인의 순서) | `REQ-BE-1.10.1`, `REQ-BE-1.10.9` |
| Backend assets | 생산 (요약·캡션 요청) | `REQ-BE-2.3.7` |
| Backend indexing | 생산 (색인 요청) | `REQ-BE-1.10.1` |
| Backend search | 소비 (검색 거부 전달) | `REQ-BE-10.1.5` |
| Backend evaluation | 소비 (평가 거부 기록) | `REQ-BE-5.2.9` |
| RAG Server service | 정의 (일괄 색인 단계, 거부) | `REQ-RAG-10.2.4`, `REQ-RAG-10.4.3`, `REQ-RAG-10.7.2`, `REQ-RAG-10.8.8` |

### 계약 표면

예약 색인 한 번에서 Backend가 RAG Server에 보내는 요청의 순서는 다음과 같다. 각 요청의 형식은 `apps/rag-server/API.md`가 소유한다.

1. 대기열에 있는 모든 문서의 이미지 캡션 요청(`POST /v1/captions/image`)
2. 대기열에 있는 모든 문서의 표 요약 요청(`POST /v1/captions/table`)
3. 대기열에 있는 문서의 색인 요청(`POST /v1/index-jobs`)

일괄 색인의 시작과 끝은 `apps/rag-server/REQUIREMENTS.md` 「용어」 일괄 색인이 정한다. 일괄 색인 중 검색(`POST /v1/search`)과 평가(`POST /v1/evaluations`)의 거부는 `503`과 오류 코드 `BATCH_INDEXING`으로 응답하며, 응답에 남은 작업 수(끝나지 않은 색인 작업의 수, 0 이상의 정수)를 담는다. 오류 응답 본문의 정확한 형식은 `apps/rag-server/API.md` 「오류 코드」가 소유한다.

### 의무

- **Backend documents** (조정) — 보장: 예약 색인에서 대기열 문서의 요약·캡션 요청을 모두 마친 뒤에 색인을 요청하고, 요약·캡션은 이미지를 모두 마친 뒤 표를 요청한다(`REQ-BE-1.10.1`, `REQ-BE-1.10.9`).
- **Backend assets** (생산) — 보장: 요약·캡션을 예약 색인에서만 요청한다(`REQ-BE-2.3.7`). 금지: 업로드·편집·재색인 요청을 받은 때 RAG Server에 요약·캡션을 요청하지 않는다.
- **Backend indexing** (생산) — 보장: 예약 색인에서 documents가 넘긴 문서 버전만 색인을 요청한다(`REQ-BE-1.10.1`).
- **RAG Server service** (정의) — 보장: 분할을 기다리는 작업이 있는 동안 임베딩을 시작하지 않고, 분할을 기다리는 작업이 없으면 분할을 마친 작업을 모두 임베딩·저장한다(`REQ-RAG-10.8.8.1`, `REQ-RAG-10.8.8.2`). 임베딩 단계 중에 받은 요약·캡션 요청과 작업은 그 단계가 끝난 뒤 처리한다(`REQ-RAG-10.2.4.1`, `REQ-RAG-10.8.8.3`). 단계를 바꾸기 전에 앞 단계의 모델을 GPU 메모리에서 내리고, 일괄 색인이 끝나면 임베딩·재정렬 모델을 올린다(`REQ-RAG-10.8.8.4`~`REQ-RAG-10.8.8.6`). 일괄 색인 중 검색·평가 요청은 처리하지 않고 위 거부 응답을 돌려준다(`REQ-RAG-10.4.3`, `REQ-RAG-10.7.2`). 전제: Backend의 요청 순서. 순서가 어긋나도 결과는 같고 모델을 더 자주 바꿔 올릴 뿐이다.
- **Backend search** (소비) — 보장: 거부 응답을 받으면 검색을 요청한 AI 에이전트·개발 도구에 일괄 색인 중이라는 오류와 남은 작업 수를 알린다(`REQ-BE-10.1.5`). 응답 형식은 `apps/backend/API.md`가 소유한다.
- **Backend evaluation** (소비) — 보장: 거부 응답을 받으면 그 평가를 평가 실패(사유: 일괄 색인 중)로 기록한다(`REQ-BE-5.2.9`).

### 오류

| 실패 | 발생 단위 | 전달 형태 | 받는 단위의 처리 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| 일괄 색인 중 검색 | RAG Server service | `503` `BATCH_INDEXING`, 남은 작업 수 | Backend search가 AI 에이전트·개발 도구에 전한다 | `REQ-RAG-10.4.3`, `REQ-BE-10.1.5` |
| 일괄 색인 중 평가 | RAG Server service | `503` `BATCH_INDEXING`, 남은 작업 수 | Backend evaluation이 평가 실패로 기록한다 | `REQ-RAG-10.7.2`, `REQ-BE-5.2.9` |

### 검증

| 검증할 것 | 담당 단위 | 종류 | 대체 경계 |
| :--- | :--- | :--- | :--- |
| 예약 색인의 요청 순서(이미지 캡션 → 표 요약 → 색인), 요약·캡션을 다 마친 뒤 색인 요청 | Backend documents | unit | assets, indexing (가짜) |
| 예약 색인 밖에서 요약·캡션을 요청하지 않음 | Backend assets | unit | RAG Server (가짜) |
| 분할 단계와 임베딩 단계, 임베딩 단계 중 받은 요청의 처리 시점, 단계마다 모델 내리기·올리기 | RAG Server service | unit | resource (가짜 모델), chunking·indexing (가짜) |
| 일괄 색인 중 검색·평가 거부와 남은 작업 수 | RAG Server service | unit | 작업 목록 (가짜) |
| 거부 응답의 전달 | Backend search | unit | RAG Server (가짜) |
| 거부 응답의 평가 실패 기록 | Backend evaluation | unit | RAG Server (가짜) |
