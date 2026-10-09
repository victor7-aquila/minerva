import type { ProcessingState } from '../../common';
import type { RagJobState } from '../../indexing';
import type { DocumentRecord } from '../interfaces/documents.types';

/** 처리 중인 처리 상태다. 교체되면 실패(REPLACED)로 바꾼다(REQ-BE-1.2.8). */
export const IN_PROGRESS_STATES: ReadonlySet<ProcessingState> = new Set<ProcessingState>([
  'uploaded',
  'captioning',
  'queued',
  'indexing',
]);

/** 변경 종류다. */
export type ChangeKind = 'edit' | 'content' | 'reindex' | 'queue';

/** 문서가 그 변경을 받을 수 있는가를 돌려준다. */
export function acceptsChange(
  doc: Pick<DocumentRecord, 'processingState' | 'searchState' | 'queuedVersion' | 'latestVersion'>,
  kind: ChangeKind,
): boolean {
  // ★ 교체된 문서는 어떤 변경도 받지 않는다 (REQ-BE-1.5.6)
  if (doc.searchState === 'replaced') return false;
  const state = doc.processingState;
  const settled = state === 'completed' || state === 'failed';
  switch (kind) {
    case 'queue':
      return state === 'failed';
    case 'reindex':
      // ★ 대기열 문서는 재색인만 거부한다 (REQ-BE-1.5.5)
      return settled;
    case 'edit':
    case 'content':
      return (
        settled ||
        (state === 'queued' &&
          doc.queuedVersion !== null &&
          doc.queuedVersion === doc.latestVersion)
      );
  }
}

/** 목표 처리 상태별로 이벤트를 받을 수 있는 출발 상태다. ★ failed는 어떤 목표의 출발 상태도 아니다(REQ-BE-1.9.5) */
const ALLOWED_FROM: Readonly<Record<ProcessingState, readonly ProcessingState[]>> = {
  uploaded: [],
  captioning: [],
  queued: [],
  indexing: ['queued'],
  completed: ['queued', 'indexing'],
  failed: ['queued', 'indexing'],
};

/** 작업 상태를 처리 상태로 바꾼다. superseded면 null이다. */
export function targetStateOf(jobState: RagJobState): ProcessingState | null {
  switch (jobState) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'indexing';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/** 이벤트로 지금 처리 상태에서 목표 처리 상태로 바꿀 수 있는가를 돌려준다. */
export function canApplyEvent(current: ProcessingState, target: ProcessingState): boolean {
  return ALLOWED_FROM[target].includes(current);
}

/** 이벤트의 검색되는 버전이 지금 값보다 크면 그 값을, 아니면 null을 돌려준다. */
export function newerSearchableVersion(
  current: string | null,
  incoming: string | null,
): string | null {
  if (incoming === null) return null;
  if (current === null || Number(incoming) > Number(current)) return incoming;
  return null;
}

/** 다음 버전 번호를 돌려준다. */
export function nextVersion(version: string): string {
  return String(Number(version) + 1);
}

/** 이전 버전 번호를 돌려준다. 1이면 null이다. */
export function previousVersion(version: string): string | null {
  const n = Number(version);
  return n <= 1 ? null : String(n - 1);
}
