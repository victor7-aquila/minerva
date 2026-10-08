import type { ProcessingState } from '../../common';
import type { RagJobState } from '../../indexing';
import type { DocumentRecord } from '../interfaces/documents.types';

/** 처리 중인 처리 상태다. 이 상태의 문서는 바꿀 수 없다(REQ-BE-1.5.5). */
export const LOCKED_STATES: ReadonlySet<ProcessingState> = new Set<ProcessingState>([
  'uploaded',
  'captioning',
  'queued',
  'indexing',
]);
/** 편집·재색인·내용 다시 올리기를 받는 처리 상태다. */
export const EDITABLE_STATES: readonly ProcessingState[] = ['completed', 'failed'];

/** 시간 제한 등으로 Backend가 정한 실패 코드다. 실제로는 접수됐을 수 있다. */
const UNREACHABLE_CODE = 'RAG_UNREACHABLE';

/** 목표 처리 상태별로 이벤트를 받을 수 있는 출발 상태다. ★ failed*는 별도로 본다 */
const ALLOWED_FROM: Readonly<Record<ProcessingState, readonly ProcessingState[]>> = {
  uploaded: [],
  captioning: [],
  queued: [],
  indexing: ['queued'],
  completed: ['queued', 'indexing'],
  failed: ['queued', 'indexing'],
};
/** failed*에서도 받을 수 있는 목표 상태다. */
const FROM_UNREACHABLE: ReadonlySet<ProcessingState> = new Set<ProcessingState>([
  'queued',
  'indexing',
  'completed',
  'failed',
]);

/** 바꿀 수 없는 문서인가를 돌려준다. 처리 중이거나 교체됨이면 참이다. */
export function isLocked(doc: Pick<DocumentRecord, 'processingState' | 'searchState'>): boolean {
  return LOCKED_STATES.has(doc.processingState) || doc.searchState === 'replaced';
}

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
export function canApplyEvent(
  current: ProcessingState,
  currentFailureCode: string | null,
  target: ProcessingState,
): boolean {
  if (current === 'failed' && currentFailureCode === UNREACHABLE_CODE) {
    return FROM_UNREACHABLE.has(target);
  }
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
