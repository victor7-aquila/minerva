import { RagUnavailableError } from '../../common';
import { RagRequestError } from '../../rag';
import type { RagEvaluationResult } from '../../rag';
import { EVALUATION_MESSAGES } from '../interfaces/evaluation.types';
import type { OutcomeFilter } from '../interfaces/evaluation.types';

/** 확장 후 Hit@N으로 적중·놓침을 정한다. */
export function outcomeOf(result: RagEvaluationResult): OutcomeFilter {
  // ★ base는 보지 않는다 (REQ-BE-5.2.6)
  return result.expanded.hitAtN ? 'hit' : 'miss';
}

/** 평가 실패의 한국어 사유를 정한다. 오류 메시지·코드를 사유에 넣지 않는다. */
export function failureMessageOf(error: unknown): string {
  if (error instanceof RagUnavailableError) return EVALUATION_MESSAGES.ragUnreachable;
  if (error instanceof RagRequestError) {
    if (error.code === 'DOCUMENT_NOT_SEARCHABLE') return EVALUATION_MESSAGES.notSearchable;
    if (error.code === 'VECTOR_DIMENSION_MISMATCH') return EVALUATION_MESSAGES.vectorMismatch;
    return error.status < 500 ? EVALUATION_MESSAGES.ragRejected : EVALUATION_MESSAGES.ragFailed;
  }
  return EVALUATION_MESSAGES.unexpected;
}
