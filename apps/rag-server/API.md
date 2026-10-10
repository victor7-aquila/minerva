# minerva RAG Server API 명세

RAG Server가 Backend에 제공하는 HTTP API다. Backend는 이 API로 표 요약·이미지 캡션 생성, 색인, 문서 삭제, 이름·판 정보 변경, 검색, 문서 청크 조회, 평가, 작업·문서 색인 상태 조회를 요청한다(`REQ-RAG-9.1.1`). RAG Server가 Backend로 보내는 작업 상태 알림은 저장소 루트 `INTERFACES.md`의 `IF-2`가 소유한다. 서버 구현은 api 단위의 `MODULE.md`가 소유한다.

## 공통 규약

- **기본 경로·버전** — 모든 경로는 `/v1`로 시작한다
- **인증** — 상태 확인(`GET /v1/health`)을 뺀 모든 요청은 `X-Minerva-Token` 헤더에 설정한 API 토큰을 담는다. 없거나 다르면 `401 UNAUTHORIZED`다(`REQ-RAG-9.3.1`)
- **크기 한도** — 색인 요청의 `markdown`과 이미지 캡션 요청의 `image`가 설정한 한도(기본 10MB, 20MB)를 넘으면 `413 PAYLOAD_TOO_LARGE`다(`REQ-RAG-9.1.3`)
- **요청·응답 형식** — `application/json`, UTF-8. 이미지 캡션 요청만 `multipart/form-data`다. 필드 이름은 snake_case다
- **오류 응답** — 모든 실패 응답은 아래 본문을 갖는다. `message`는 한국어이고, 스택 트레이스·쿼리·파일 경로를 담지 않는다(`REQ-RAG-11.3`)
- **null과 빠진 필드** — 응답의 선택 필드는 값이 없으면 빠뜨리지 않고 `null`로 내보낸다. 요청의 선택 필드는 빠뜨리면 기본값을 쓴다
- **시간·ID 형식** — 날짜는 ISO 8601 날짜 문자열(예: `2025-01-31`)이다. `doc_id`와 `version`은 Backend가 정한 문자열을 그대로 쓴다. `job_id`와 `chunk_id`는 RAG Server가 정한 문자열이다
- **공통 오류** — 형식이 잘못된 요청은 `400 INVALID_REQUEST`(`REQ-RAG-9.1.2`), 준비가 끝나기 전 요청은 상태 확인(`GET /v1/health`)을 빼고 `503 SERVER_NOT_READY`(`REQ-RAG-10.1.2`), 예상하지 못한 서버 오류는 `500 INTERNAL_ERROR`다

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "요청 형식이 잘못되었습니다"
  }
}
```

## 엔드포인트 목록

| 메서드 | 경로 | 요약 | REQ |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/captions/table` | 표 요약 생성 | `REQ-RAG-10.2.2`, `REQ-RAG-10.2` |
| `POST` | `/v1/captions/image` | 이미지 캡션 생성 | `REQ-RAG-10.2.3`, `REQ-RAG-10.2` |
| `POST` | `/v1/index-jobs` | 색인 요청 | `REQ-RAG-2.1.6`, `REQ-RAG-3.5`, `REQ-RAG-3.6.1`, `REQ-RAG-3.6.4`, `REQ-RAG-10.8.1`, `REQ-RAG-10.3` |
| `GET` | `/v1/index-jobs/{job_id}` | 작업 상태 조회 | `REQ-RAG-10.8.2` |
| `DELETE` | `/v1/documents/{doc_id}` | 문서 삭제 | `REQ-RAG-3.4`, `REQ-RAG-10.5` |
| `GET` | `/v1/documents/{doc_id}/index-state` | 문서 색인 상태 조회 | `REQ-RAG-10.8.6.1`, `REQ-RAG-10.8.6.2` |
| `POST` | `/v1/documents/index-states` | 여러 문서의 색인 상태 조회 | `REQ-RAG-10.8.6.3` |
| `PUT` | `/v1/documents/{doc_id}/metadata` | 이름·판 정보 변경 | `REQ-RAG-3.6.5`, `REQ-RAG-3.6.7`, `REQ-RAG-10.6` |
| `GET` | `/v1/documents/{doc_id}/chunks` | 문서 청크 조회 | `REQ-RAG-4.7` |
| `POST` | `/v1/search` | 검색 | `REQ-RAG-4`, `REQ-RAG-4.9`, `REQ-RAG-10.4` |
| `POST` | `/v1/evaluations` | 골든셋 한 건 평가 | `REQ-RAG-6`, `REQ-RAG-10.7` |
| `GET` | `/v1/health` | 상태 확인 (인증 없음) | `REQ-RAG-9.2.1` |

## 엔드포인트

### `POST /v1/captions/table`

표의 요약 문장을 만들어 돌려준다. 결과는 저장하지 않는다. (`REQ-RAG-10.2.2`, `REQ-RAG-10.2.1`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `table_markdown` | `string` | 필수 | 표 하나의 Markdown. 인용문·목록 안의 표는 블록 접두를 뗀 모양이다. 칸 안에 이미지 Markdown(`![대체 텍스트](경로)`)이 있을 수 있다 — 표 안 이미지는 표의 일부라 따로 캡션을 요청하지 않는다 |

**응답**

- `200` — `{"summary": string}`. 표의 내용을 요약한 문장

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `502` | `CAPTION_FAILED` | 요약을 만들지 못했다 (`REQ-RAG-10.2.2.3`) |
| `503` | `MODEL_UNAVAILABLE` | 모델 서버에 연결할 수 없다 (`REQ-RAG-12.1.2`) |

### `POST /v1/captions/image`

이미지를 설명하는 캡션을 만들어 돌려준다. 결과는 저장하지 않는다. (`REQ-RAG-10.2.3`, `REQ-RAG-10.2.1`)

**요청** — `multipart/form-data`

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `image` | 파일 | 필수 | 이미지 파일 하나. 설정한 한도(기본 20MB) 이하 (`REQ-RAG-9.1.3`). 파트의 `Content-Type`과 파일 이름은 형식 판단에 쓰지 않는다. Backend는 PNG·JPEG·GIF·SVG·WebP를 보내며, 파트의 `Content-Type`은 지정하지 않고 파일 이름에는 원본 확장자가 붙는다 |

**응답**

- `200` — `{"caption": string}`. 이미지를 설명하는 캡션

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `502` | `CAPTION_FAILED` | 캡션을 만들지 못했다. 모델이 읽지 못하는 형식의 이미지도 같다 (`REQ-RAG-10.2.3.3`) |
| `503` | `MODEL_UNAVAILABLE` | 모델 서버에 연결할 수 없다 (`REQ-RAG-12.1.2`) |

### `POST /v1/index-jobs`

문서 한 버전의 색인을 요청한다. 다시 색인해야 하면 작업으로 접수하고 처리가 끝나기를 기다리지 않고 응답한다. (`REQ-RAG-10.8.1.1`, `REQ-RAG-10.3.1`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `doc_id` | `string` | 필수 | |
| body | `version` | `string` | 필수 | |
| body | `markdown` | `string` | 필수 | 색인용 MD. 자리표시 형식은 루트 `INTERFACES.md`의 `IF-1`. UTF-8로 설정한 한도(기본 10MB) 이하 (`REQ-RAG-9.1.3`) |
| body | `assets` | `AssetText[]` | 필수 | `markdown`의 모든 자리표시 ID에 대해 하나씩. 자리표시가 없으면 빈 배열 |
| body | `name` | `string` | 필수 | 문서 이름 (`REQ-RAG-3.6.1`) |
| body | `edition` | `Edition` | 선택 | 판 정보. 빠지면 판 정보가 없는 문서다 (`REQ-RAG-3.6.1`, `REQ-RAG-3.6.4`) |
| body | `chunking` | `string` | 선택 | `semantic`(의미 단위 분할) 또는 `rule`(규칙 분할). 기본값 `semantic` (`REQ-RAG-2.1.6`) |
| body | `force` | `boolean` | 선택 | `true`면 체크섬이 같아도 다시 색인한다. 기본값 `false` (`REQ-RAG-3.5.5`) |

**응답**

- `202` — `IndexJobAccepted`, `outcome`이 `queued`. 새 작업을 접수했다
- `202` — `IndexJobAccepted`, `outcome`이 `joined`. 같은 문서·같은 체크섬의 작업이 색인 대기 또는 색인 중이라 그 작업의 ID를 돌려준다 (`REQ-RAG-3.5.3`)
- `200` — `IndexJobAccepted`, `outcome`이 `reused`. 체크섬이 현재 검색되는 색인과 같아 다시 색인하지 않았다. `job_id`는 그 색인을 만든 작업이다 (`REQ-RAG-3.5.1`, `REQ-RAG-3.5.4`)

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `400` | `INVALID_REQUEST` | `assets`에 `markdown`의 자리표시 ID가 빠졌다 |
| `503` | `SHUTTING_DOWN` | 서버가 종료 중이라 새 작업을 받지 않는다 (`REQ-RAG-10.1.3`) |

**동작**

- 같은 문서의 새 작업이 접수되면 아직 시작하지 않은 이전 작업은 `superseded`가 된다 (`REQ-RAG-10.8.3.4`)
- 실패한 작업과 체크섬이 같은 요청도 새 작업으로 접수한다 (`REQ-RAG-10.8.4.3`)
- 이름·판 정보가 같은 다른 문서의 청크는 지우지 않는다. 같은 판 문서의 정리는 Backend가 문서 삭제로 요청한다 (`REQ-RAG-3.6.6`)
- 작업 상태가 바뀔 때마다 Backend에 알림을 보낸다 (루트 `INTERFACES.md` `IF-2`)

**예시**

```http
POST /v1/index-jobs
Content-Type: application/json

{
  "doc_id": "3f2b8c1e-5d4a-4e7b-9c6f-0a1b2c3d4e5f",
  "version": "3",
  "markdown": "# 설치\n\n[[minerva:table:t1 | 환경 변수 표]]",
  "assets": [{"placeholder_id": "t1", "text": "환경 변수별 타입과 기본값을 정리한 표"}],
  "name": "IEEE 1609.2.1",
  "edition": {"label": "2025", "edition_date": "2025-01-31"},
  "chunking": "semantic",
  "force": false
}
```

```json
{
  "outcome": "queued",
  "job_id": "job-7f3a",
  "doc_id": "3f2b8c1e-5d4a-4e7b-9c6f-0a1b2c3d4e5f",
  "version": "3"
}
```

### `GET /v1/index-jobs/{job_id}`

작업 하나의 상태를 돌려준다. RAG Server가 다시 시작한 뒤에도 조회된다. (`REQ-RAG-10.8.2.2`, `REQ-RAG-10.8.5.1`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| path | `job_id` | `string` | 필수 | |

**응답**

- `200` — `IndexJob`

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `JOB_NOT_FOUND` | 그 ID의 작업이 없다 |

### `DELETE /v1/documents/{doc_id}`

문서의 모든 버전 청크를 지운다. (`REQ-RAG-3.4.1`, `REQ-RAG-10.5`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| path | `doc_id` | `string` | 필수 | |

**응답**

- `204` — 본문 없음. 청크를 지웠다. 그 뒤 검색 결과에 이 문서의 청크가 나오지 않는다. 청크가 없는 문서여도 `204`다 (`REQ-RAG-3.4.2`, `REQ-RAG-3.4.3`)

**동작**

- 아직 시작하지 않은 이 문서의 작업은 `failed`(사유: 문서 삭제)가 된다 (`REQ-RAG-10.5.1`)
- 이 문서에 색인 중인 작업이 있으면 그 작업이 끝난 뒤 지우고 응답한다. 그래서 응답이 늦어질 수 있고, Backend는 응답을 기다리지 못하면 실패로 보고 같은 요청을 다시 보낸다(`REQ-RAG-10.5.2`, `REQ-BE-1.8.4`). 청크를 이미 지운 문서도 오류 없이 받으므로(`REQ-RAG-3.4.3`) 같은 요청을 여러 번 받아도 결과가 같다
- Backend는 삭제한 문서와, 같은 판의 다른 문서로 교체된 문서를 이 요청으로 지운다 (`REQ-RAG-3.6.6`)

### `GET /v1/documents/{doc_id}/index-state`

문서 하나의 색인 상태를 돌려준다. (`REQ-RAG-10.8.6.2`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| path | `doc_id` | `string` | 필수 | |

**응답**

- `200` — `IndexState`. 색인된 적이 없는 문서면 `searchable_version`, `latest_job_id`, `latest_job_state`가 모두 `null`이다

### `POST /v1/documents/index-states`

여러 문서의 색인 상태를 한 번에 돌려준다. (`REQ-RAG-10.8.6.3`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `doc_ids` | `string[]` | 필수 | 1~100개 |

**응답**

- `200` — `{"items": IndexState[]}`. `doc_ids`의 순서대로 하나씩

### `PUT /v1/documents/{doc_id}/metadata`

문서의 이름과 판 정보를 바꾼다. 다시 색인하지 않는다. (`REQ-RAG-3.6.5`, `REQ-RAG-10.6.1`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| path | `doc_id` | `string` | 필수 | |
| body | `name` | `string` | 필수 | 문서 이름 |
| body | `edition` | `Edition` 또는 `null` | 필수 | 판 정보. `null`이면 판 정보가 없는 문서가 된다 |

**응답**

- `204` — 본문 없음. 그 문서의 모든 청크의 이름·판 정보가 바뀌었다. 청크가 없는 문서여도 `204`다 (`REQ-RAG-3.6.7`)

**동작**

- 이 문서에 색인 중인 작업이 있으면 그 작업이 끝난 뒤 바꾸고 응답한다. 그래서 응답이 늦어질 수 있고, Backend는 응답을 기다리지 못하면 실패로 보고 같은 요청을 다시 보낸다(`REQ-RAG-10.6.1`, `REQ-BE-3.4.2`). 청크가 없는 문서도 오류 없이 받고(`REQ-RAG-3.6.7`) 같은 이름·판 정보로 다시 바꾸는 것이므로 같은 요청을 여러 번 받아도 결과가 같다
- 바꾼 이름·판 정보와 같은 다른 문서의 청크는 지우지 않는다 (`REQ-RAG-3.6.6`)
- 이 문서와 관련된 이름의 최신판 표시가 다시 맞춰진다 (`REQ-RAG-3.6.3`)

### `GET /v1/documents/{doc_id}/chunks`

문서의 지금 검색되는 청크를 문서 안 순서대로 돌려준다. (`REQ-RAG-4.7`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| path | `doc_id` | `string` | 필수 | |

**응답**

- `200` — `{"version": string 또는 null, "items": DocumentChunk[]}`. `version`은 지금 검색되는 버전이다. 검색되는 버전이 없으면 `version`은 `null`, `items`는 빈 배열 (`REQ-RAG-4.7.1`, `REQ-RAG-4.7.3`)

### `POST /v1/search`

질의와 관련된 결과를 상위 N개 돌려준다. 답변 문장은 만들지 않는다. (`REQ-RAG-4`, `REQ-RAG-10.4`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `query` | `string` | 필수 | |
| body | `top_n` | `integer` | 선택 | 1 이상. 빠지면 설정한 기본 개수 (`REQ-RAG-4.3.2`) |
| body | `doc_ids` | `string[]` | 선택 | 주면 이 문서들 안에서만 검색한다. 개수 상한은 없다 — Backend는 이름으로 찾은 문서 ID를 모두 담는다 (`REQ-RAG-4.1.3`) |
| body | `edition_scope` | `string` | 선택 | `all`(전체), `latest`(이름마다 최신판만), `specific`(`edition`의 판만). 기본값 `all`. `latest`·`all`에서는 판 정보가 없는 문서도 나오고, `specific`에서는 나오지 않는다 (`REQ-RAG-4.5.3`, `REQ-RAG-4.5.4`, `REQ-RAG-4.5.6`) |
| body | `edition` | `EditionRef` | 조건부 | `edition_scope`가 `specific`이면 필수, 아니면 쓰지 않는다 |
| body | `expand_neighbors` | `boolean` | 선택 | `true`면 결과마다 앞뒤 청크를 함께 넣는다. 기본값 `false` (`REQ-RAG-4.4.4`) |

**응답**

- `200` — `{"results": SearchResult[]}`. `rank` 순서대로. 결과가 없으면 빈 배열 (`REQ-RAG-10.4.2`)

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `503` | `MODEL_UNAVAILABLE` | 모델 서버에 연결할 수 없다 (`REQ-RAG-12.1.2`) |
| `503` | `STORE_UNAVAILABLE` | Qdrant에 연결할 수 없다 (`REQ-RAG-12.2.1`) |
| `500` | `VECTOR_DIMENSION_MISMATCH` | 저장된 벡터의 차원이 지금 임베딩 모델과 다르다 (`REQ-RAG-12.2.2`) |

**동작**

- 질의에 용어집의 말이 있으면 같은 묶음의 대표어와 동의어까지 넣어 검색한다 (`REQ-RAG-4.9.1`)
- 현재 검색되는 버전의 청크만 결과에 나온다. 색인 중인 새 버전은 끝나기 전에는 나오지 않는다 (`REQ-RAG-3.3.1`, `REQ-RAG-3.3.2`)
- 재정렬에 실패하면 합친 순위와 점수로 돌려준다 (`REQ-RAG-4.2.2`)

**예시**

```http
POST /v1/search
Content-Type: application/json

{"query": "인증서 갱신 절차", "top_n": 1, "edition_scope": "all", "expand_neighbors": false}
```

```json
{
  "results": [
    {
      "rank": 1,
      "score": 0.87,
      "doc_id": "3f2b8c1e-5d4a-4e7b-9c6f-0a1b2c3d4e5f",
      "version": "3",
      "heading_path": ["인증서", "갱신"],
      "name": "IEEE 1609.2.1",
      "edition": {"label": "2025", "edition_date": "2025-01-31", "is_latest": true},
      "other_editions_in_results": false,
      "chunks": [
        {"chunk_id": "c-91", "kind": "text", "text": "인증서는 만료 30일 전부터 갱신을 요청한다.", "placeholder_ids": [], "split_index": null, "split_total": null}
      ],
      "before": [],
      "after": []
    }
  ]
}
```

### `POST /v1/evaluations`

골든셋 한 건으로 검색해 지표를 계산해 돌려준다. 골든셋과 결과는 저장하지 않는다. (`REQ-RAG-6`, `REQ-RAG-10.7.1`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `query` | `string` | 필수 | |
| body | `doc_id` | `string` | 필수 | 정답 문서 |
| body | `answer_span` | `string` | 필수 | 정답 원문 구간. 공백 문자를 모두 지운 뒤 비어 있지 않다. 공백 문자는 JavaScript 정규식 `\s`와 같은 글자 집합이다(띄어쓰기·탭·줄바꿈과 U+00A0, U+1680, U+2000~U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) (`REQ-RAG-6.1.1`) |
| body | `edition_only` | `boolean` | 선택 | `false`면 정답 문서와 이름이 같은 다른 판의 결과도 적중으로 세고, `true`면 정답 문서의 결과만 센다. 기본값 `false` (`REQ-RAG-6.1.3`) |
| body | `top_n` | `integer` | 선택 | 1 이상. 빠지면 설정한 기본 개수 |

**응답**

- `200` — `EvaluationResult`

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `400` | `INVALID_REQUEST` | 공백 문자를 지운 `answer_span`이 비어 있다. 정답 문서 확인과 검색보다 먼저 검사한다 (`REQ-RAG-6.1.1`) |
| `409` | `DOCUMENT_NOT_SEARCHABLE` | 정답 문서가 검색되지 않는 상태다 (`REQ-RAG-6.3.2`) |
| `503` | `MODEL_UNAVAILABLE` | 모델 서버에 연결할 수 없다 (`REQ-RAG-12.1.2`) |
| `503` | `STORE_UNAVAILABLE` | Qdrant에 연결할 수 없다 (`REQ-RAG-12.2.1`) |

**동작**

- 검색 요청과 같은 처리로 결과 N개를 만든 뒤 지표를 잰다 (`REQ-RAG-6.2.1`)

### `GET /v1/health`

Qdrant와 Ollama의 연결 상태를 돌려준다. (`REQ-RAG-9.2.1`)

**응답**

- `200` — `{"qdrant": string, "ollama": string}`. 값은 `ok` 또는 `unavailable`

## 공용 모델

### `AssetText`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `placeholder_id` | `string` | 필수 | 색인용 MD의 자리표시 ID |
| `text` | `string` | 필수 | 그 표·이미지의 요약·캡션 문장. 색인 텍스트를 만들 때 자리표시 대신 쓴다 (`REQ-RAG-3.1.1`) |

### `Edition`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `label` | `string` | 필수 | 판 표기 |
| `edition_date` | `string` | 필수 | 판 날짜 (ISO 8601 날짜) |

### `EditionRef`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 필수 | 문서 이름 |
| `label` | `string` | 필수 | 판 표기 |

### `IndexJobAccepted`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `outcome` | `string` | 필수 | `queued`, `joined`, `reused` 중 하나 |
| `job_id` | `string` | 필수 | 접수한 작업, 합류한 작업, 또는 현재 색인을 만든 작업의 ID |
| `doc_id` | `string` | 필수 | |
| `version` | `string` | 필수 | 요청한 버전 |

### `IndexJob`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `job_id` | `string` | 필수 | |
| `doc_id` | `string` | 필수 | |
| `version` | `string` | 필수 | |
| `state` | `string` | 필수 | `queued`(색인 대기), `running`(색인 중), `succeeded`(완료), `failed`(실패), `superseded`(대체됨) 중 하나 (`REQ-RAG-10.8.2.1`) |
| `stage` | `string` | 조건부 | `state`가 `running`이면 `chunking`, `embedding`, `storing` 중 하나, 아니면 `null` (`REQ-RAG-10.8.2.3`) |
| `failure` | `JobFailure` | 조건부 | `state`가 `failed`이면 필수, 아니면 `null` (`REQ-RAG-10.8.2.4`) |
| `result` | `JobResult` | 조건부 | `state`가 `succeeded`이면 필수, 아니면 `null` (`REQ-RAG-10.8.2.6`) |

### `JobFailure`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `code` | `string` | 필수 | 실패 사유 코드. 아래 「작업 실패 사유 코드」 중 하나 |
| `message` | `string` | 필수 | 관리자가 읽고 조치할 수 있는 한국어 설명 |
| `heading_path` | `string[]` | 선택 | 실패가 생긴 절. 모르면 `null` (`REQ-RAG-10.8.2.5`) |
| `placeholder_id` | `string` | 선택 | 실패가 생긴 자리표시. 모르면 `null` (`REQ-RAG-10.8.2.5`) |

작업 실패 사유 코드 (`REQ-RAG-10.8.2.4`):

| 코드 | 뜻 |
| :--- | :--- |
| `CHUNKING_FAILED` | 청킹을 끝내지 못했다. 위치가 있으면 그 절이다 (`REQ-RAG-10.3.3`) |
| `MODEL_UNAVAILABLE` | 처리 중 모델 서버에 연결할 수 없었다 (`REQ-RAG-12.1.2`) |
| `STORE_UNAVAILABLE` | 처리 중 Qdrant에 연결할 수 없었다 (`REQ-RAG-12.2.1`) |
| `VECTOR_DIMENSION_MISMATCH` | 저장된 벡터와 임베딩 모델의 차원이 다르다 (`REQ-RAG-12.2.2`) |
| `DOCUMENT_DELETED` | 시작하기 전에 문서 삭제를 요청받았다 (`REQ-RAG-10.5.1`) |
| `SERVER_RESTARTED` | 끝나기 전에 RAG Server가 다시 시작했다 (`REQ-RAG-10.8.5.2`) |
| `INTERNAL_ERROR` | 예상하지 못한 오류 |

### `JobResult`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `chunk_count` | `integer` | 필수 | 만든 청크 수 |
| `fallback_used` | `boolean` | 필수 | 대체 분할을 썼는가 (`REQ-RAG-2.3.3`) |

### `IndexState`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `doc_id` | `string` | 필수 | |
| `searchable_version` | `string` | 선택 | 현재 검색되는 버전. 없으면 `null` (`REQ-RAG-10.8.6.1`) |
| `latest_job_id` | `string` | 선택 | 그 문서의 최신 작업. 없으면 `null` |
| `latest_job_state` | `string` | 선택 | 최신 작업의 상태. 값은 `IndexJob.state`와 같다. 없으면 `null` |
| `latest_job_stage` | `string` | 선택 | 최신 작업이 `running`이면 `chunking`, `embedding`, `storing` 중 하나, 아니면 `null` (`REQ-RAG-10.8.6.2`) |

### `SearchResult`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `rank` | `integer` | 필수 | 1부터 |
| `score` | `number` | 필수 | 재정렬 점수. 재정렬에 실패했으면 합친 순위의 점수. 최신판 가중치가 더해진 값이다 (`REQ-RAG-4.5.5`) |
| `doc_id` | `string` | 필수 | |
| `version` | `string` | 필수 | |
| `heading_path` | `string[]` | 필수 | |
| `name` | `string` | 필수 | 문서 이름 (`REQ-RAG-4.5.1`) |
| `edition` | `ResultEdition` | 선택 | 판 정보. 판 정보가 없는 문서면 `null` (`REQ-RAG-4.5.1`) |
| `other_editions_in_results` | `boolean` | 필수 | 같은 이름의 다른 판 결과가 이 응답에 함께 있는가. 판 정보가 없는 문서면 `false` (`REQ-RAG-4.5.2`) |
| `chunks` | `ResultChunk[]` | 필수 | 검색된 청크. 나뉜 청크면 같은 청크의 분할 조각 전부를 원문 순서대로 담는다 (`REQ-RAG-4.4.1`, `REQ-RAG-4.4.2`) |
| `before` | `ResultChunk[]` | 필수 | 앞 청크. `expand_neighbors`가 `false`면 빈 배열 (`REQ-RAG-4.4.4`, `REQ-RAG-4.4.5`) |
| `after` | `ResultChunk[]` | 필수 | 뒤 청크. `expand_neighbors`가 `false`면 빈 배열 |

### `ResultEdition`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `label` | `string` | 필수 | |
| `edition_date` | `string` | 필수 | ISO 8601 날짜 |
| `is_latest` | `boolean` | 필수 | 최신판인가 |

### `ResultChunk`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `chunk_id` | `string` | 필수 | |
| `kind` | `string` | 필수 | `text`(본문 청크) 또는 `asset`(표·이미지 청크) |
| `text` | `string` | 필수 | 청크 원문. 자리표시는 원형 그대로 들어 있다 (`REQ-RAG-4.3.4`, 루트 `INTERFACES.md` `IF-1`) |
| `placeholder_ids` | `string[]` | 필수 | `text`에 든 자리표시 ID |
| `split_index` | `integer` | 선택 | 분할 조각이면 조각 번호, 아니면 `null` |
| `split_total` | `integer` | 선택 | 분할 조각이면 조각 수, 아니면 `null` |

### `DocumentChunk`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `chunk_id` | `string` | 필수 | |
| `order` | `integer` | 필수 | 문서 안 순서 |
| `kind` | `string` | 필수 | `text`(본문 청크) 또는 `asset`(표·이미지 청크) |
| `heading_path` | `string[]` | 필수 | |
| `title` | `string` | 선택 | 본문 청크의 제목. 표·이미지 청크는 `null` |
| `summary` | `string` | 선택 | 본문 청크의 요약. 표·이미지 청크는 `null` |
| `text` | `string` | 필수 | 자리표시가 든 청크 원문 |
| `placeholder_ids` | `string[]` | 필수 | |
| `split_index` | `integer` | 선택 | 분할 조각이면 조각 번호, 아니면 `null` |
| `split_total` | `integer` | 선택 | 분할 조각이면 조각 수, 아니면 `null` |

### `EvaluationResult`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `n` | `integer` | 필수 | 이번 평가에 쓴 결과 개수 |
| `base` | `EvaluationMetrics` | 필수 | 연관 청크 확장 전 (`REQ-RAG-6.2.6`) |
| `expanded` | `EvaluationMetrics` | 필수 | 연관 청크 확장 후 (`REQ-RAG-6.2.6`) |

### `EvaluationMetrics`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `hit_at_1`, `hit_at_3`, `hit_at_5`, `hit_at_n` | `boolean` | 필수 | 결과 1·3·5·N개 안에서 적중했는가 (`REQ-RAG-6.2.5`) |
| `rank` | `integer` | 선택 | 정답 구간을 담은 결과가 처음 나온 순위. 결과 N개 안에 없으면 `null` (`REQ-RAG-6.2.4`) |
| `reciprocal_rank` | `number` | 필수 | 역순위. 순위가 없으면 0 (`REQ-RAG-6.2.4`) |
| `coverage` | `number` | 필수 | 정답 구간 글자 중 결과 N개에 들어 있는 비율 (0~1) (`REQ-RAG-6.2.2`) |

## 오류 코드

| 코드 | 상태 | 의미 |
| :--- | :--- | :--- |
| `INVALID_REQUEST` | `400` | 요청 형식이 잘못되었다 |
| `UNAUTHORIZED` | `401` | API 토큰이 없거나 다르다 |
| `JOB_NOT_FOUND` | `404` | 그 ID의 작업이 없다 |
| `PAYLOAD_TOO_LARGE` | `413` | 요청이 설정한 크기 한도를 넘는다 |
| `DOCUMENT_NOT_SEARCHABLE` | `409` | 정답 문서가 검색되지 않는 상태라 평가할 수 없다 |
| `INTERNAL_ERROR` | `500` | 예상하지 못한 서버 오류 |
| `VECTOR_DIMENSION_MISMATCH` | `500` | 저장된 벡터와 지금 임베딩 모델의 차원이 다르다 |
| `CAPTION_FAILED` | `502` | 요약·캡션을 만들지 못했다 |
| `MODEL_UNAVAILABLE` | `503` | 모델 서버에 연결할 수 없다 |
| `STORE_UNAVAILABLE` | `503` | Qdrant에 연결할 수 없다 |
| `SERVER_NOT_READY` | `503` | 서버가 아직 준비 중이다 |
| `SHUTTING_DOWN` | `503` | 서버가 종료 중이라 새 작업을 받지 않는다 |

