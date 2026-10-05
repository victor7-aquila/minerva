import type { RagJobState } from '../../rag';

// ★ IF-BE-1(apps/backend/INTERFACES.md)의 계약 표면 그대로다. 필드를 더하거나 빼지 않는다
export type { RagJobState };

/** IF-BE-1 이벤트 이름이다. */
export const INDEX_JOB_STATE_CHANGED = 'indexing.job-state-changed';

/** 작업 실패 사유다. */
export interface JobFailureInfo {
  code: string;
  message: string;
  headingPath: string[] | null;
  placeholderId: string | null;
}

/** 작업 결과다. */
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
