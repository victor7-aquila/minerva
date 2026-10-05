import type { ProcessingState } from '../../common';

/** 기록 종류다. */
export type LogKind =
  'upload' | 'content_upload' | 'captioning' | 'processing_state' | 'edit' | 'delete' | 'replace';

/** 문장 틀에 넣는 값이다. 모두 코드·개수·상태 이름이다. */
export interface LogDetail {
  fromState?: ProcessingState;
  toState?: ProcessingState;
  reasonCode?: string;
  count?: number;
  failedCount?: number;
  changedFields?: ReadonlyArray<'name' | 'edition' | 'hints'>;
  replacedByDocId?: string;
}

/** 기록 하나의 입력이다. 자유 문장은 받지 않는다. */
export interface LogInput {
  kind: LogKind;
  docId: string;
  name: string;
  editionLabel: string | null;
  outcome: 'success' | 'failure';
  detail?: LogDetail;
}

/** 기록 종류 전체다. */
export const LOG_KINDS = [
  'upload',
  'content_upload',
  'captioning',
  'processing_state',
  'edit',
  'delete',
  'replace',
] as const satisfies readonly LogKind[];

/** 기록 결과다. */
export type LogOutcome = LogInput['outcome'];

/** 정렬할 수 있는 열이다. */
export type LogSortColumn = 'occurred_at' | 'kind' | 'outcome';

/** 응답의 문서 참조다. */
export interface LogDocumentRef {
  doc_id: string;
  name: string;
  edition_label: string | null;
}

/** 응답의 기록 하나다. */
export interface LogEntry {
  log_id: string;
  occurred_at: string;
  kind: LogKind;
  document: LogDocumentRef;
  document_deleted: boolean;
  outcome: LogOutcome;
  description: string;
}

/** logs 컬렉션 이름이다. */
export const LOGS_COLLECTION = 'logs';

/** MongoDB logs에 저장하는 기록이다. */
export interface LogRecord {
  logId: string;
  occurredAt: Date;
  kind: LogKind;
  docId: string;
  name: string;
  editionLabel: string | null;
  outcome: LogOutcome;
  description: string;
}
