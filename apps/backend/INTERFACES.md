# minerva Backend 인터페이스 명세

이 문서는 Backend 안에서 둘 이상의 모듈이 공유하는 계약을 소유한다. 참여 모듈의 `MODULE.md`는 IF ID로 가리키기만 한다. 앱 사이 계약(자리표시 형식, 작업 상태 알림)은 루트 `INTERFACES.md`가 소유한다.

## 계약 목록

| ID | 계약 | 참여 단위 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| `IF-BE-1` | 색인 작업 상태 이벤트 | indexing, documents | `REQ-BE-1.9`, `REQ-BE-1.2.5`, `REQ-BE-1.2.8`, `REQ-BE-3.2`, `REQ-BE-3.3` |

## IF-BE-1 색인 작업 상태 이벤트

indexing은 RAG Server의 작업 상태 알림(루트 `IF-2`)과 상태 맞추기(`REQ-BE-3.3`)로 알게 된 상태를 documents에 넘기고, documents가 처리 상태·검색 상태와 교체를 반영하고 logs에 기록한다. documents → indexing 의존이 이미 있어 반대 방향은 이벤트로 넘기며(`ARCHITECT.md` 「의존 규칙」), 두 모듈이 같은 상태 대응을 써야 문서 상태가 맞는다.

### 참여 단위

| 단위 | 역할 | 관련 REQ |
| :--- | :--- | :--- |
| indexing | 생산 (알림·조회 결과를 이벤트로 바꾼다) | `REQ-BE-3.2`, `REQ-BE-3.3` |
| documents | 소비 (상태 반영, 교체, 기록) | `REQ-BE-1.9.5`~`REQ-BE-1.9.8`, `REQ-BE-1.2.5`, `REQ-BE-1.2.8`, `REQ-BE-6.1.1` |

### 계약 표면

이벤트 이름은 `indexing.job-state-changed`이고, 본문은 아래 타입이다.

```typescript
export type RagJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'superseded';

export interface JobFailureInfo {
  code: string;
  message: string;
  headingPath: string[] | null;
  placeholderId: string | null;
}

export interface JobResultInfo {
  chunkCount: number;
  fallbackUsed: boolean;
}

/** 색인 작업 상태가 바뀌었음을 알린다. */
export interface IndexJobStateChangedEvent {
  docId: string;
  version: string;
  jobId: string;
  jobState: RagJobState;
  searchableVersion: string | null;
  result: JobResultInfo | null;
  failure: JobFailureInfo | null;
  source: 'notification' | 'reconcile';
}
```

| 필드 | 불변 조건 |
| :--- | :--- |
| `version` | 그 작업이 색인한 문서 버전. 색인을 요청할 때마다 새 버전이므로(`REQ-BE-1.6.3`) 버전 하나에 작업 하나다 |
| `searchableVersion` | 이벤트 시점에 RAG Server에서 검색되는 버전. 없으면 `null` |
| `result` | `jobState`가 `succeeded`일 때만 값이 있다 |
| `failure` | `jobState`가 `failed`일 때만 값이 있다 |
| `source` | 알림에서 왔으면 `notification`, 상태 맞추기에서 왔으면 `reconcile` |

RAG Server가 색인 요청에 이미 같은 색인이 있다고 답한 경우(`REQ-BE-1.9.4`)는 작업이 생기지 않으므로 이벤트를 내지 않는다. documents가 색인 요청 결과로 바로 처리 상태를 완료로 두며, 이때 검색되는 버전은 같은 내용의 이전 버전이다.

### 의무

- **indexing** (생산) — 보장: 루트 `IF-2`의 순번 규칙으로 이미 반영한 순번 이하의 알림은 이벤트로 내지 않는다(`REQ-BE-3.2.4`). `failed`면 RAG Server에서 실패 사유를 받아 `failure`를 채운 뒤 낸다(`REQ-BE-3.2.3`). `succeeded`면 작업 결과를 받아 `result`를 채운다. 금지: 문서 컬렉션에 직접 쓰지 않는다.
- **documents** (소비) — 보장: `version`이 그 문서의 마지막 버전이 아니거나, `jobState`가 `superseded`거나, 문서가 교체됨·삭제됨이면 처리 상태와 검색 상태를 바꾸지 않는다(`REQ-BE-1.9.6`). `queued`·`running`·`succeeded`·`failed`를 처리 상태 색인 대기·색인 중·완료·실패로 바꾸고, `failed`면 `failure`를 실패 사유로 남긴다(`REQ-BE-1.9.5`). `searchableVersion`이 있으면 검색 상태를 검색 가능으로 둔다(`REQ-BE-1.9.7`, `REQ-BE-1.9.8`). 문서가 이 이벤트로 검색 가능이 되면, 같은 판에서 판에 들어온 시각이 이 문서보다 이른 문서를 교체됨으로 바꾸고 그 문서의 청크 삭제를 요청한다(`REQ-BE-1.2.5`, `REQ-BE-1.2.8`). 처리 상태가 실제로 바뀐 경우에만 logs 서비스로 기록한다(`REQ-BE-6.1.1`). 같은 이벤트를 두 번 받아도 결과가 같다. 금지: 교체 여부를 RAG Server의 결과로 정하지 않는다. 교체는 documents가 같은 판과 판에 들어온 시각으로만 정한다.

### 검증

| 검증할 것 | 담당 단위 | 종류 | 대체 경계 |
| :--- | :--- | :--- | :--- |
| 순번 이하 알림 무시, 실패 사유·결과 채우기 | indexing | unit | rag (RAG Server 응답), 저장소 |
| 상태 대응, 이전 버전·대체됨·교체됨·삭제됨 무시, 교체 대상 고르기와 청크 삭제 요청, 바뀐 경우만 기록, 같은 이벤트 두 번 | documents | unit | 저장소, indexing, logs |
