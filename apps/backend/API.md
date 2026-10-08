# minerva Backend API 명세

Backend가 Console과 AI 에이전트·개발 도구에 제공하는 HTTP API다. 문서 관리·평가·로그 API는 Console이, 검색 API는 AI 에이전트·개발 도구가 쓴다. RAG Server가 보내는 작업 상태 알림을 받는 주소도 여기 두지만, 그 본문 형식은 루트 `INTERFACES.md`의 `IF-2`가 소유한다. 서버 구현은 각 모듈의 `MODULE.md`가 소유한다.

## 공통 규약

- **기본 경로·버전** — 모든 경로는 `/v1`로 시작한다
- **인증** — Console·AI 에이전트의 요청은 인증을 요구하지 않는다 (`REQ-BE-7.1.1`). RAG Server의 작업 상태 알림만 `X-Minerva-Token` 헤더의 알림 토큰을 검사한다 (`REQ-BE-3.2.5`)
- **요청·응답 형식** — `application/json`, UTF-8. 파일을 올리는 요청은 `multipart/form-data`, 이미지 응답은 이미지 바이너리다. 필드 이름은 snake_case다
- **오류 응답** — 모든 실패 응답은 아래 본문을 갖는다. `message`는 한국어이고, 스택 트레이스·쿼리·파일 경로를 담지 않는다 (`REQ-BE-8.3`)
- **null과 빠진 필드** — 응답의 선택 필드는 값이 없으면 빠뜨리지 않고 `null`로 내보낸다. 요청의 선택 필드는 빠뜨리면 기본값을 쓴다. `PATCH`에서는 빠진 필드는 바꾸지 않고, `null`은 값을 지운다
- **시각·날짜** — 시각은 UTC의 ISO 8601 문자열(예: `2026-10-04T05:05:31Z`)이다 (`REQ-BE-8.4`). 날짜로 거르는 파라미터는 날짜 문자열(예: `2026-10-04`)이며 한국 표준시(KST) 하루로 해석한다 (`REQ-BE-1.3.4`, `REQ-BE-6.2.2`)
- **ID** — `doc_id`, `golden_set_id`, `log_id`는 Backend가 정한 문자열이다. `doc_id`는 소문자 UUID다. 경로의 `{doc_id}`와 `exclude_doc_id`가 이 형식이 아니면 `400 INVALID_REQUEST`다
- **이미지 주소** — 표·이미지의 이미지 주소(`AssetView.image_url`, `GET /v1/documents/{doc_id}/original`의 `images` 값, 복원한 본문의 `![캡션](주소)`, 표 안 이미지 경로를 바꾼 주소)는 호스트 없이 `/v1/`로 시작하는 Backend 기준 경로다
- **페이지네이션** — 목록 요청은 `page`(1부터, 기본 1)와 `page_size`(20·50·100, 기본 20)를 받고, 응답은 `{"items": [...], "total": 정수, "page": 정수, "page_size": 정수}`다 (`REQ-BE-7.1.3`)
- **정렬** — 목록 요청은 `sort`(열 이름)와 `order`(`asc`·`desc`, 기본 `desc`)를 받는다. 한 번에 한 열만 정렬한다
- **공통 오류** — 형식이 잘못된 요청은 `400 INVALID_REQUEST` (`REQ-BE-7.1.2`), 없는 경로는 `404 NOT_FOUND`, RAG Server가 응답하지 않거나 준비 중이면 `503 RAG_UNAVAILABLE` (`REQ-BE-10.1.2`), 예상하지 못한 서버 오류는 `500 INTERNAL_ERROR`다

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "판 표기와 판 날짜는 함께 입력해야 합니다"
  }
}
```

## 엔드포인트 목록

| 메서드 | 경로 | 요약 | REQ |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/documents` | 문서 업로드 | `REQ-BE-1.1` |
| `GET` | `/v1/documents` | 문서 목록 | `REQ-BE-1.3.1`~`REQ-BE-1.3.6`, `REQ-BE-1.3.8` |
| `GET` | `/v1/document-names` | 문서 이름 목록 | `REQ-BE-1.3.7` |
| `GET` | `/v1/documents/replacement-check` | 같은 판 문서 확인 | `REQ-BE-1.2.7` |
| `GET` | `/v1/documents/{doc_id}` | 문서 조회 | `REQ-BE-1.4.1`, `REQ-BE-1.4.2`, `REQ-BE-1.4.4` |
| `GET` | `/v1/documents/{doc_id}/original` | 원본 MD | `REQ-BE-1.4.3` |
| `GET` | `/v1/documents/{doc_id}/chunks` | 검색에 쓰이는 청크 | `REQ-BE-1.4.5` |
| `GET` | `/v1/documents/{doc_id}/versions/{version}/assets/{placeholder_id}` | 이미지 파일 | `REQ-BE-2.4.1` |
| `PATCH` | `/v1/documents/{doc_id}` | 이름·판 정보·요약·캡션 편집 | `REQ-BE-1.5` |
| `POST` | `/v1/documents/{doc_id}/contents` | 내용 다시 올리기 | `REQ-BE-1.6.1`, `REQ-BE-1.6.2`, `REQ-BE-1.9.1` |
| `POST` | `/v1/documents/{doc_id}/reindex` | 재색인 | `REQ-BE-1.7` |
| `DELETE` | `/v1/documents/{doc_id}` | 문서 삭제 | `REQ-BE-1.8` |
| `POST` | `/v1/search` | 검색 (AI용) | `REQ-BE-4` |
| `GET` | `/v1/golden-sets` | 골든셋 목록 | `REQ-BE-5.3.1`, `REQ-BE-5.3.2` |
| `POST` | `/v1/golden-sets` | 골든셋 추가 | `REQ-BE-5.1.1`, `REQ-BE-5.1.2`, `REQ-BE-5.1.5`, `REQ-BE-5.2.1` |
| `DELETE` | `/v1/golden-sets/{golden_set_id}` | 골든셋 삭제 | `REQ-BE-5.1.4` |
| `POST` | `/v1/golden-sets/{golden_set_id}/evaluate` | 한 건 다시 평가 | `REQ-BE-5.2.4`, `REQ-BE-5.2.7` |
| `POST` | `/v1/golden-sets/evaluate-all` | 전체 다시 평가 | `REQ-BE-5.2.4`, `REQ-BE-5.2.5`, `REQ-BE-5.2.7` |
| `GET` | `/v1/evaluation-summary` | 평가 요약 | `REQ-BE-5.3.3` |
| `GET` | `/v1/logs` | 로그 목록 | `REQ-BE-6.2` |
| `POST` | `/v1/internal/rag-events` | RAG Server 작업 상태 알림 받기 | `REQ-BE-3.2` |

## 엔드포인트

### `POST /v1/documents`

MD 파일 여러 개와 이미지 파일들을 받아 MD 하나마다 문서를 만든다. (`REQ-BE-1.1`)

**요청** — `multipart/form-data`

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `files` | 파일[] | 필수 | `.md`와 `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`. MD가 하나 이상 |
| body | `meta` | `UploadMeta[]` (JSON 문자열) | 필수 | `files`의 MD마다 하나 |

**응답**

- `201` — `{"documents": UploadedDocument[]}`. MD마다 만든 문서. 처리 상태는 업로드됨, 검색 상태는 검색 안 됨이다 (`REQ-BE-1.1.8`)

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `400` | `UNSUPPORTED_FILE` | 받지 않는 형식의 파일이 있다. `message`에 파일 이름을 담는다. UTF-8로 읽을 수 없는 MD도 같다 (`REQ-BE-1.1.2`) |
| `413` | `PAYLOAD_TOO_LARGE` | 업로드 한도(MD 하나 10MB, 이미지 하나 20MB, 파일 200개, 요청 전체 200MB 기본)를 넘는다. `message`에 넘은 파일 이름이나 한도를 담는다 (`REQ-BE-1.1.10`) |
| `400` | `INVALID_REQUEST` | 이름이 비었거나 판 표기·판 날짜 중 하나만 있다 (`REQ-BE-1.1.6`) |

**동작**

- 같은 판의 기존 문서는 새 문서가 검색 가능이 될 때 교체됨이 된다 (`REQ-BE-1.2.3`, `REQ-BE-1.2.5`)
- 응답 뒤에 표·이미지 처리와 색인이 이어서 진행된다 (`REQ-BE-1.1.9`)

### `GET /v1/documents`

문서 목록을 페이지로 준다. 삭제한 문서는 나오지 않는다. (`REQ-BE-1.3`, `REQ-BE-1.8.2`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| query | `page`, `page_size`, `order` | | 선택 | 「공통 규약」 |
| query | `sort` | `string` | 선택 | `name`, `search_state`, `processing_state`, `uploaded_at`, `updated_at`. 기본 `updated_at` |
| query | `search_state` | `string` (쉼표로 여러 개) | 선택 | `searchable`, `not_searchable`, `replaced` |
| query | `processing_state` | `string` (쉼표로 여러 개) | 선택 | `uploaded`, `captioning`, `queued`, `indexing`, `completed`, `failed` |
| query | `name` | `string` | 선택 | 이 이름의 문서만 |
| query | `has_edition` | `boolean` | 선택 | `true`면 판 정보가 있는 문서만, `false`면 없는 문서만 |
| query | `latest_only` | `boolean` | 선택 | `true`면 이름마다 최신판만. 판 정보가 없는 문서는 그대로 나온다. 기본 `false` |
| query | `uploaded_from`, `uploaded_to` | 날짜 | 선택 | 업로드 날짜 범위 (KST) |

**응답**

- `200` — `DocumentSummary`의 페이지

### `GET /v1/document-names`

이미 올라온 문서 이름을 준다. (`REQ-BE-1.3.7`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| query | `prefix` | `string` | 선택 | 이 글자로 시작하는 이름만 |
| query | `limit` | `integer` | 선택 | 1~50, 기본 20 |

**응답**

- `200` — `{"items": string[]}`. 가나다순

### `GET /v1/documents/replacement-check`

이 이름·판 표기로 올리거나 저장하면 같은 판이 되는 다른 문서들을 알려 준다. 이 문서들은 올리거나 저장한 문서가 검색 가능이 될 때 교체됨이 된다. (`REQ-BE-1.2.7`, `REQ-BE-1.2.5`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| query | `name` | `string` | 필수 | |
| query | `edition_label` | `string` | 선택 | 빠지면 판 정보가 없는 문서끼리로 본다 |
| query | `exclude_doc_id` | `string` | 선택 | 편집 중인 문서 자신을 뺀다 |

**응답**

- `200` — `{"replaces": DocumentRef[]}`. 같은 판의 다른 문서들(교체됨·삭제됨 제외). 없으면 빈 배열 (`REQ-BE-1.2.3`)

### `GET /v1/documents/{doc_id}`

문서 하나의 정보와 표·이미지를 준다. (`REQ-BE-1.4.1`, `REQ-BE-1.4.2`, `REQ-BE-1.4.4`)

**응답**

- `200` — `DocumentDetail`

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 삭제됐다 |

### `GET /v1/documents/{doc_id}/original`

마지막으로 올린 원본 MD와 이미지 주소를 준다. (`REQ-BE-1.4.3`)

**응답**

- `200` — `{"markdown": string, "images": {이미지 경로: 주소}}`. `images`의 키는 MD 안에 적힌 이미지 경로이고, 값은 `GET /v1/documents/{doc_id}/versions/{version}/assets/{placeholder_id}` 주소다. 짝이 없는 이미지 경로는 값이 `null`이다

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 삭제됐다 |

### `GET /v1/documents/{doc_id}/chunks`

지금 검색에 쓰이는 청크를 문서 안 순서대로 준다. 자리표시는 RAG Server가 알려 준 검색 버전의 표·이미지로 복원해 준다. (`REQ-BE-1.4.5`, `REQ-BE-2.5`)

**응답**

- `200` — `{"items": ChunkView[]}`. 검색 상태가 검색 가능이 아니면 빈 배열

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 삭제됐다 |

### `GET /v1/documents/{doc_id}/versions/{version}/assets/{placeholder_id}`

이미지 파일을 준다. (`REQ-BE-2.4.1`)

**응답**

- `200` — 이미지 바이너리. `Content-Type`은 이미지 형식에 맞춘다

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `ASSET_NOT_FOUND` | 그 문서 버전에 그 이미지가 없다 |

### `PATCH /v1/documents/{doc_id}`

이름, 판 정보, 요약·캡션 중 보낸 것만 고친다. (`REQ-BE-1.5`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `name` | `string` | 선택 | 비울 수 없다 |
| body | `edition` | `Edition` 또는 `null` | 선택 | `null`이면 판 정보를 지운다 |
| body | `assets` | `AssetTextUpdate[]` | 선택 | 바꾼 요약·캡션만 |

**응답**

- `200` — `DocumentDetail`. 고친 뒤의 문서

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 삭제됐다 |
| `409` | `DOCUMENT_LOCKED` | 처리 중(업로드됨, 요약·캡션 생성 중, 색인 대기, 색인 중)이거나 교체됨이다 (`REQ-BE-1.5.5`, `REQ-BE-1.5.6`) |

**동작**

- 이름·판 정보만 바꾸면 다시 색인하지 않고 RAG Server에 이름·판 정보 변경을 요청한다. 요청하지 못하면 Backend가 주기적으로 다시 요청한다 (`REQ-BE-1.5.2`, `REQ-BE-3.4.1`, `REQ-BE-3.4.2`)
- 바꾼 이름·판 표기로 같은 판이 된 다른 문서는, 이 문서가 검색 가능이면 바로, 아니면 이 문서가 검색 가능이 될 때 교체됨이 되고 RAG Server에서 청크가 지워진다 (`REQ-BE-1.5.3`, `REQ-BE-1.2.5`, `REQ-BE-1.2.8`)
- 요약·캡션이 바뀌면 새 버전을 만들어 색인을 요청하고 처리 상태가 색인 대기가 된다. 다시 색인하는 동안 이전 버전이 계속 검색된다 (`REQ-BE-1.5.4`, `REQ-BE-1.6.3`, `REQ-BE-1.9.3`)

### `POST /v1/documents/{doc_id}/contents`

MD 하나와 이미지들로 그 문서의 새 버전을 만든다. (`REQ-BE-1.6.1`, `REQ-BE-1.6.2`, `REQ-BE-1.9.1`)

**요청** — `multipart/form-data`

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `files` | 파일[] | 필수 | MD 정확히 하나와 이미지들. 형식은 `POST /v1/documents`와 같다 |

**응답**

- `202` — `UploadedDocument`. 처리 상태는 업로드됨이고, 처리가 끝날 때까지 이전 버전이 계속 검색된다

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `400` | `UNSUPPORTED_FILE` | 받지 않는 형식의 파일이 있다. UTF-8로 읽을 수 없는 MD도 같다 |
| `400` | `INVALID_REQUEST` | MD가 정확히 하나가 아니다 (`REQ-BE-1.6.1`) |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 삭제됐다 |
| `409` | `DOCUMENT_LOCKED` | 처리 중이거나 교체됨이다 |
| `413` | `PAYLOAD_TOO_LARGE` | 업로드 한도를 넘는다 (`REQ-BE-1.6.1`, `REQ-BE-1.1.10`) |

### `POST /v1/documents/{doc_id}/reindex`

내용이 같은 새 버전을 만들어 다시 색인한다. (`REQ-BE-1.7`, `REQ-BE-1.6.3`)

**응답**

- `202` — 본문 없음. 임시 설명인 표·이미지가 있으면 처리 상태가 요약·캡션 생성 중이 되어 그 요약·캡션을 다시 만든 뒤 색인 대기가 되고, 없으면 바로 색인 대기가 된다 (`REQ-BE-1.7.1`, `REQ-BE-1.9.2`, `REQ-BE-1.9.3`)

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 삭제됐다 |
| `409` | `DOCUMENT_LOCKED` | 처리 중이거나 교체됨이다 |

### `DELETE /v1/documents/{doc_id}`

문서를 지운다. (`REQ-BE-1.8`)

**응답**

- `204` — 본문 없음. 문서는 바로 삭제됨이 되어 목록·조회에 나오지 않고, AI 검색 응답에서도 빠진다 (`REQ-BE-1.8.1`, `REQ-BE-1.8.2`)

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `DOCUMENT_NOT_FOUND` | 그 ID의 문서가 없거나 이미 삭제됐다 |

**동작**

- 응답 뒤에 RAG Server의 청크 삭제를 요청하고, 실패하면 설정한 주기로 다시 요청한다. 청크가 지워지면 원본, 표·이미지, 요약·캡션을 지운다 (`REQ-BE-1.8.4`, `REQ-BE-1.8.5`)
- 진행 중이던 요약·캡션 생성과 색인 요청은 더 하지 않는다 (`REQ-BE-1.8.3`)

### `POST /v1/search`

질의와 관련된 결과를 돌려준다. 표·이미지는 원래 모양으로 복원하며(`REQ-BE-2.5`), 삭제됨·교체됨 문서의 결과는 빼고, 답변 문장은 만들지 않는다. (`REQ-BE-4`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `query` | `string` | 필수 | 공백만은 안 된다 |
| body | `top_n` | `integer` | 선택 | 1~50. 빠지면 RAG Server 기본값 |
| body | `names` | `string[]` | 선택 | 이 이름의 문서들 안에서만 검색한다 |
| body | `edition_scope` | `string` | 선택 | `all`, `latest`, `specific`. 기본 `all` |
| body | `edition` | `EditionRef` | 조건부 | `edition_scope`가 `specific`이면 필수. 그 밖에는 쓰지 않는다 |
| body | `expand_neighbors` | `boolean` | 선택 | 기본 `false` |

**응답**

- `200` — `{"results": SearchResult[]}`. 결과가 없으면 빈 배열

### `GET /v1/golden-sets`

골든셋 목록과 골든셋마다 최근 평가 결과를 준다. (`REQ-BE-5.3.1`, `REQ-BE-5.3.2`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| query | `page`, `page_size`, `order` | | 선택 | 「공통 규약」 |
| query | `sort` | `string` | 선택 | `outcome`, `rank`, `coverage`, `evaluated_at`, `created_at`. 기본 `created_at` |
| query | `outcome` | `string` | 선택 | `hit`, `miss`. 빠지면 전체 |

**응답**

- `200` — `GoldenSet`의 페이지

**동작**

- 정렬 값은 `outcome`(적중이 놓침보다 크다), `rank`(`latest.expanded.rank`), `coverage`(`latest.expanded.coverage`), `evaluated_at`(`latest.evaluated_at`), `created_at`이다. 그 값이 없는 행(평가 중·평가 실패, 정답 순위가 없는 놓침, 평가 중의 평가 시각)은 `order`와 관계없이 맨 뒤에 둔다. 같은 값끼리는 추가 늦은 순이다 (`REQ-BE-5.3.1`)

### `POST /v1/golden-sets`

골든셋을 추가하고 바로 평가를 시작한다. (`REQ-BE-5.1.1`, `REQ-BE-5.1.2`, `REQ-BE-5.1.5`, `REQ-BE-5.2.1`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| body | `query` | `string` | 필수 | 비울 수 없다 |
| body | `doc_id` | `string` | 필수 | 정답 문서 |
| body | `answer_span` | `string` | 필수 | 정답 원문 구간. 비울 수 없다 |
| body | `edition_only` | `boolean` | 선택 | `true`면 정답 문서의 판만 적중으로 센다. 정답 문서에 판 정보가 없으면 `true`를 받지 않는다. 기본 `false` |

**응답**

- `201` — `GoldenSet`. `latest.outcome`은 `evaluating`이다

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `400` | `INVALID_REQUEST` | `query`·`doc_id`·`answer_span`이 없거나 공백뿐이다, `edition_only`가 `true`인데 정답 문서에 판 정보가 없다 (`REQ-BE-5.1.1`) |
| `400` | `ANSWER_SPAN_NOT_FOUND` | 정답 구간이 정답 문서의 지금 검색되는 버전 색인용 MD에 없다. 공백·줄바꿈 차이는 무시하고, 표·이미지 안의 글자는 찾지 않는다 (`REQ-BE-5.1.5`) |
| `409` | `DOCUMENT_NOT_SEARCHABLE` | 정답 문서의 검색 상태가 검색 가능이 아니다 (`REQ-BE-5.1.2`) |
| `404` | `DOCUMENT_NOT_FOUND` | 정답 문서가 없거나 삭제됐다 |

### `DELETE /v1/golden-sets/{golden_set_id}`

골든셋과 그 평가 기록을 지운다. (`REQ-BE-5.1.4`)

**응답**

- `204` — 본문 없음

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `GOLDEN_SET_NOT_FOUND` | 그 ID의 골든셋이 없다 |

### `POST /v1/golden-sets/{golden_set_id}/evaluate`

골든셋 한 건을 다시 평가한다. 정답 문서가 검색 가능이 아니면 평가를 요청하지 않고 결과가 평가 실패가 된다. (`REQ-BE-5.2.4`, `REQ-BE-5.2.7`)

**응답**

- `202` — 본문 없음. `latest.outcome`이 `evaluating`이 된다

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `404` | `GOLDEN_SET_NOT_FOUND` | 그 ID의 골든셋이 없다 |

### `POST /v1/golden-sets/evaluate-all`

모든 골든셋을 다시 평가한다. 정답 문서가 검색 가능이 아닌 골든셋은 평가 실패가 된다. (`REQ-BE-5.2.4`, `REQ-BE-5.2.5`, `REQ-BE-5.2.7`)

**응답**

- `202` — 본문 없음

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `409` | `EVALUATION_IN_PROGRESS` | 평가 중인 골든셋이 있다 |

### `GET /v1/evaluation-summary`

골든셋 전체의 최근 결과로 낸 지표를 준다. (`REQ-BE-5.3.3`)

**응답**

- `200` — `EvaluationSummary`

### `GET /v1/logs`

문서 기록을 페이지로 준다. (`REQ-BE-6.2`)

**요청**

| 위치 | 이름 | 타입 | 필수 | 제약 |
| :--- | :--- | :--- | :--- | :--- |
| query | `page`, `page_size`, `order` | | 선택 | 「공통 규약」 |
| query | `sort` | `string` | 선택 | `occurred_at`, `kind`, `outcome`. 기본 `occurred_at` |
| query | `kind` | `string` (쉼표로 여러 개) | 선택 | `upload`, `content_upload`, `captioning`, `processing_state`, `edit`, `delete`, `replace` |
| query | `outcome` | `string` | 선택 | `success`, `failure` |
| query | `from`, `to` | 날짜 | 선택 | 기간 (KST) |
| query | `name` | `string` | 선택 | 이 이름의 문서들에 대한 기록만 |
| query | `doc_id` | `string` | 선택 | 이 문서 하나에 대한 기록만 |

**응답**

- `200` — `LogEntry`의 페이지

### `POST /v1/internal/rag-events`

RAG Server의 작업 상태 알림을 받는다. 본문과 `X-Minerva-Token` 헤더는 루트 `INTERFACES.md` `IF-2`의 형식이다. Console과 AI는 부르지 않는다. (`REQ-BE-3.2`)

**응답**

- `204` — 본문 없음. 받았다 (`REQ-BE-3.2.1`)

**오류**

| 상태 | 오류 코드 | 조건 |
| :--- | :--- | :--- |
| `401` | `UNAUTHORIZED` | 알림 토큰이 없거나 다르다. 알림을 반영하지 않는다 (`REQ-BE-3.2.5`) |

## 공용 모델

### `UploadMeta`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `file_name` | `string` | 필수 | `files` 안의 MD 파일 이름 |
| `name` | `string` | 필수 | 문서 이름. 비울 수 없다 |
| `edition` | `Edition` | 선택 | 판 정보. 빠지면 판 정보가 없는 문서다 |

### `UploadedDocument`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `doc_id` | `string` | 필수 | |
| `name` | `string` | 필수 | |
| `file_name` | `string` | 필수 | |
| `unmatched_images` | `string[]` | 필수 | 짝이 없는 이미지 경로. 없으면 빈 배열 (`REQ-BE-1.1.4`) |

### `Edition`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `label` | `string` | 필수 | 판 표기 |
| `edition_date` | `string` | 필수 | 판 날짜 (날짜 문자열) |

### `EditionRef`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 필수 | 문서 이름 |
| `label` | `string` | 필수 | 판 표기 |

### `DocumentRef`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `doc_id` | `string` | 필수 | |
| `name` | `string` | 필수 | |
| `edition` | `Edition` | 선택 | 판 정보가 없으면 `null` |

### `DocumentSummary`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `doc_id` | `string` | 필수 | |
| `name` | `string` | 필수 | |
| `edition` | `Edition` | 선택 | 이 문서의 판. 없으면 `null` |
| `sibling_editions` | `Edition[]` | 필수 | 이 문서 자신과, 같은 이름이고 검색 가능인 다른 문서들의 판. 판 날짜가 늦은 순. 이 문서에 판 정보가 없으면 빈 배열 (`REQ-BE-1.3.5`) |
| `search_state` | `string` | 필수 | `searchable`(검색 가능), `not_searchable`(검색 안 됨), `replaced`(교체됨) |
| `processing_state` | `string` | 필수 | `uploaded`(업로드됨), `captioning`(요약·캡션 생성 중), `queued`(색인 대기), `indexing`(색인 중), `completed`(완료), `failed`(실패) |
| `stage` | `string` | 선택 | `processing_state`가 `indexing`이면 `chunking`, `embedding`, `storing` 중 하나, 아니면 `null`. RAG Server에서 단계를 받지 못했으면 `indexing`이어도 `null` (`REQ-BE-1.3.6`) |
| `failure_message` | `string` | 선택 | `processing_state`가 `failed`이면 실패 사유 설명, 아니면 `null` (`REQ-BE-1.3.8`) |
| `uploaded_at` | `string` | 필수 | |
| `updated_at` | `string` | 필수 | 마지막으로 내용을 다시 올리거나 편집한 시각 |

### `DocumentDetail`

`DocumentSummary`의 모든 필드에 아래를 더한다.

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `file_name` | `string` | 필수 | 마지막으로 올린 MD 파일 이름 |
| `result` | `ProcessingResult` | 선택 | `processing_state`가 `completed`면 값, 아니면 `null` |
| `failure` | `ProcessingFailure` | 선택 | `processing_state`가 `failed`면 값, 아니면 `null` |
| `assets` | `AssetView[]` | 필수 | 마지막 버전의 표·이미지. 문서 안 순서대로. 표 안 이미지는 표의 일부라 따로 나오지 않는다 |

### `ProcessingResult`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `chunk_count` | `integer` | 필수 | 만든 청크 수 |
| `fallback_used` | `boolean` | 필수 | 대체 분할을 썼는가 |

### `ProcessingFailure`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `code` | `string` | 필수 | 실패 사유 코드. Backend가 정하는 코드는 `RAG_UNREACHABLE`(RAG Server에 색인을 요청하지 못함, `REQ-BE-1.9.4`)와 `REPLACED`(처리 중에 교체됨, `REQ-BE-1.2.8`)다. RAG Server가 색인 요청을 거부하면 그 오류 코드 `PAYLOAD_TOO_LARGE`(색인용 MD가 크기 한도를 넘음)·`INVALID_REQUEST`(형식 오류)다 (`REQ-BE-1.9.4`). 그 밖은 RAG Server 작업의 실패 사유 코드다 (`REQ-BE-1.9.5`) |
| `message` | `string` | 필수 | 한국어 설명 |
| `heading_path` | `string[]` | 선택 | 문제가 난 절. 모르면 `null` |
| `placeholder_id` | `string` | 선택 | 문제가 난 표·이미지. 모르면 `null` |

### `AssetView`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `placeholder_id` | `string` | 필수 | |
| `kind` | `string` | 필수 | `table` 또는 `image` |
| `table_markdown` | `string` | 조건부 | `kind`가 `table`이면 원본 Markdown 표, 아니면 `null`. 인용문·목록 안 표는 둘째 줄부터의 블록 접두를 떼고, 표 안 짝 있는 이미지의 경로는 이미지 주소로 바꾼다 |
| `image_url` | `string` | 조건부 | `kind`가 `image`이고 짝이 있으면 이미지 주소, 아니면 `null` |
| `text` | `string` | 필수 | 요약·캡션 |
| `is_fallback` | `boolean` | 필수 | 임시 설명인가 |

### `AssetTextUpdate`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `placeholder_id` | `string` | 필수 | |
| `text` | `string` | 필수 | 새 요약·캡션. 비울 수 없다 |

### `ChunkView`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `order` | `integer` | 필수 | 문서 안 순서 |
| `kind` | `string` | 필수 | `text`(본문 청크) 또는 `asset`(표·이미지 청크) |
| `heading_path` | `string[]` | 필수 | |
| `title` | `string` | 선택 | 본문 청크의 제목. 표·이미지 청크는 `null` |
| `summary` | `string` | 선택 | 본문 청크의 요약. 표·이미지 청크는 `null` |
| `markdown` | `string` | 필수 | 자리표시를 원래 표·이미지로 바꾼 본문 |
| `split_index` | `integer` | 선택 | 분할 조각이면 조각 번호, 아니면 `null` |
| `split_total` | `integer` | 선택 | 분할 조각이면 조각 수, 아니면 `null` |

### `SearchResult`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `rank` | `integer` | 필수 | 1부터 |
| `score` | `number` | 필수 | |
| `doc_id` | `string` | 필수 | |
| `name` | `string` | 필수 | 문서 이름 |
| `edition` | `ResultEdition` | 선택 | 판 정보가 없으면 `null` |
| `heading_path` | `string[]` | 필수 | |
| `markdown` | `string` | 필수 | 결과 본문. 나뉜 청크면 조각 전부를 순서대로 이은 것이다. 표는 원본 Markdown 표(표 안 짝 있는 이미지의 경로는 이미지 주소), 이미지는 `![캡션](이미지 주소)`로 바뀌어 있다 (`REQ-BE-2.5`, `REQ-BE-4.2.1`) |
| `before` | `string[]` | 필수 | 앞 청크 본문들(복원됨). `expand_neighbors`가 `false`면 빈 배열 |
| `after` | `string[]` | 필수 | 뒤 청크 본문들(복원됨). `expand_neighbors`가 `false`면 빈 배열 |

### `ResultEdition`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `label` | `string` | 필수 | |
| `edition_date` | `string` | 필수 | |
| `is_latest` | `boolean` | 필수 | 같은 이름의 최신판인가 |
| `other_editions_in_results` | `boolean` | 필수 | 같은 이름의 다른 판 결과가 이 응답에 함께 있는가 |

### `GoldenSet`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `golden_set_id` | `string` | 필수 | |
| `query` | `string` | 필수 | |
| `answer` | `DocumentRef` | 필수 | 정답 문서. 삭제된 문서면 이름·판만 남는다 |
| `answer_span` | `string` | 필수 | |
| `edition_only` | `boolean` | 필수 | |
| `created_at` | `string` | 필수 | |
| `latest` | `EvaluationRecord` | 필수 | 가장 최근 평가 |

### `EvaluationRecord`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `outcome` | `string` | 필수 | `hit`(적중), `miss`(놓침), `evaluating`(평가 중), `error`(평가 실패). 적중·놓침은 `expanded.hit_at_n`으로 정한다 (`REQ-BE-5.2.6`) |
| `n` | `integer` | 선택 | 이번 평가의 결과 개수. 평가가 끝나지 않았으면 `null` |
| `base` | `EvaluationMetrics` | 선택 | 연관 청크 확장 전. 평가가 끝나지 않았으면 `null` |
| `expanded` | `EvaluationMetrics` | 선택 | 연관 청크 확장 후. 평가가 끝나지 않았으면 `null` |
| `error_message` | `string` | 선택 | `outcome`이 `error`면 사유(정답 문서가 검색되지 않음 포함, `REQ-BE-5.2.7`), 아니면 `null` |
| `evaluated_at` | `string` | 선택 | 평가가 끝난 시각. 평가 중이면 `null` |

Console의 정답 순위·포함 비율 칸은 `expanded`의 값을 쓴다.

### `EvaluationMetrics`

RAG Server `POST /v1/evaluations` 응답의 `EvaluationMetrics`와 같은 모양이다.

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `hit_at_1`, `hit_at_3`, `hit_at_5`, `hit_at_n` | `boolean` | 필수 | 결과 1·3·5·N개 안에서 적중했는가 |
| `rank` | `integer` | 선택 | 정답 구간을 담은 결과가 처음 나온 순위. 결과 N개 안에 없으면 `null` |
| `reciprocal_rank` | `number` | 필수 | 역순위. 순위가 없으면 0 |
| `coverage` | `number` | 필수 | 정답 구간 글자 중 결과 N개에 들어 있는 비율 (0~1) |

### `EvaluationSummary`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `golden_set_count` | `integer` | 필수 | |
| `evaluating_count` | `integer` | 필수 | 평가 중인 골든셋 수 |
| `last_evaluated_at` | `string` | 선택 | 적중·놓침인 최근 기록 중 가장 늦은 평가 시각. 없으면 `null` |
| `n` | `integer` | 필수 | Hit@N의 N (RAG Server 기본 결과 개수). `last_evaluated_at` 기록의 값이며, 없으면 0 |
| `base` | `SummaryMetrics` | 필수 | 연관 청크 확장 전 |
| `expanded` | `SummaryMetrics` | 필수 | 연관 청크 확장 뒤 |

### `SummaryMetrics`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `hit_at_1`, `hit_at_3`, `hit_at_5`, `hit_at_n` | `number` | 필수 | 평가가 끝난 골든셋 중 적중 비율(0~1) |
| `mrr` | `number` | 필수 | 역순위의 평균 |

### `LogEntry`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `log_id` | `string` | 필수 | |
| `occurred_at` | `string` | 필수 | |
| `kind` | `string` | 필수 | `GET /v1/logs`의 `kind` 값 중 하나 |
| `document` | `LogDocumentRef` | 필수 | 문서가 삭제되거나 이름이 바뀌어도 기록 시점의 이름·판 표기가 남는다 (`REQ-BE-6.1.2`, `REQ-BE-1.8.6`) |
| `document_deleted` | `boolean` | 필수 | 문서가 삭제됐는가 |
| `outcome` | `string` | 필수 | `success` 또는 `failure` |
| `description` | `string` | 필수 | 한 줄 설명 |

### `LogDocumentRef`

| 필드 | 타입 | 필수 | 설명·제약 |
| :--- | :--- | :--- | :--- |
| `doc_id` | `string` | 필수 | |
| `name` | `string` | 필수 | 기록 시점의 문서 이름 |
| `edition_label` | `string` | 선택 | 기록 시점의 판 표기. 판 정보가 없었으면 `null` |

## 오류 코드

| 코드 | 상태 | 의미 |
| :--- | :--- | :--- |
| `INVALID_REQUEST` | `400` | 요청 형식이 잘못되었다 |
| `UNSUPPORTED_FILE` | `400` | 받지 않는 형식의 파일이 있다 |
| `ANSWER_SPAN_NOT_FOUND` | `400` | 정답 구간을 정답 문서에서 찾을 수 없다 |
| `UNAUTHORIZED` | `401` | RAG Server 알림의 토큰이 없거나 다르다 |
| `DOCUMENT_NOT_FOUND` | `404` | 문서가 없거나 삭제됐다 |
| `ASSET_NOT_FOUND` | `404` | 그 이미지가 없다 |
| `GOLDEN_SET_NOT_FOUND` | `404` | 골든셋이 없다 |
| `NOT_FOUND` | `404` | 요청한 경로가 없다 |
| `DOCUMENT_LOCKED` | `409` | 처리 중이거나 교체된 문서라 바꿀 수 없다 |
| `DOCUMENT_NOT_SEARCHABLE` | `409` | 검색 가능이 아닌 문서를 정답 문서로 고를 수 없다 |
| `EVALUATION_IN_PROGRESS` | `409` | 평가 중인 골든셋이 있어 전체 다시 평가를 할 수 없다 |
| `PAYLOAD_TOO_LARGE` | `413` | 업로드 한도를 넘는다 |
| `INTERNAL_ERROR` | `500` | 예상하지 못한 서버 오류 |
| `RAG_UNAVAILABLE` | `503` | RAG Server가 응답하지 않거나 준비 중이다 |
