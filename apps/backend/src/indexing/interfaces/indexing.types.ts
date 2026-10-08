import type { RagJobState } from '../../rag';

/** 색인 요청에 담을 문서 버전이다. */
export interface IndexRequestInput {
  docId: string;
  version: string;
  indexingMarkdown: string;
  hints: ReadonlyArray<{ placeholderId: string; text: string }>;
  name: string;
  edition: { label: string; editionDate: string } | null;
  force: boolean;
}

/** RAG Server가 색인 요청을 거부한 오류 코드다. */
export type IndexRejectionCode = 'PAYLOAD_TOO_LARGE' | 'INVALID_REQUEST';

/** 색인 요청의 결과다. */
export type IndexRequestOutcome =
  | { kind: 'accepted'; jobId: string }
  | { kind: 'reused'; jobId: string }
  | { kind: 'rejected'; code: IndexRejectionCode }
  | { kind: 'unreachable' };

/** 작업 상태 알림(루트 IF-2)의 값이다. 알림 컨트롤러가 본문을 옮겨 담는다. */
export interface RagEventNotification {
  docId: string;
  jobId: string;
  version: string;
  jobState: RagJobState;
  searchableVersion: string | null;
  sequence: number;
}

/** 알림 순번 컬렉션 이름이다. ★ indexing 내부 전용 */
export const RAG_EVENT_CURSORS_COLLECTION = 'rag_event_cursors';

/** 알림 순번 레코드다(MODULE.md 「데이터 계약」). ★ indexing 내부 전용 */
export interface RagEventCursorRecord {
  docId: string;
  lastSequence: number;
}
