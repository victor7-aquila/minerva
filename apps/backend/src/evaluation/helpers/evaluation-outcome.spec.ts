import { RagUnavailableError } from '../../common';
import { RagRequestError } from '../../rag';
import { ragEvalResult, ragMetrics, missMetrics } from '../../../test/support/evaluation-fixtures';
import { EVALUATION_MESSAGES } from '../interfaces/evaluation.types';
import { failureMessageOf, outcomeOf } from './evaluation-outcome';

describe('REQ-BE-5.2.6', () => {
  it('T-OUT-1 확장 후 Hit@N만으로 적중·놓침을 정한다', () => {
    expect(outcomeOf(ragEvalResult({ base: missMetrics(), expanded: ragMetrics() }))).toBe('hit');
    expect(outcomeOf(ragEvalResult({ base: ragMetrics(), expanded: missMetrics() }))).toBe('miss');
    expect(outcomeOf(ragEvalResult({ base: ragMetrics(), expanded: ragMetrics() }))).toBe('hit');
    expect(outcomeOf(ragEvalResult({ base: missMetrics(), expanded: missMetrics() }))).toBe('miss');
  });
});

describe('REQ-BE-5.2.3', () => {
  it('T-OUT-2 실패를 한국어 사유로 바꾸고 오류 정보를 싣지 않는다', () => {
    const messages = [
      failureMessageOf(new RagUnavailableError()),
      failureMessageOf(new RagRequestError(409, 'DOCUMENT_NOT_SEARCHABLE')),
      failureMessageOf(new RagRequestError(500, 'VECTOR_DIMENSION_MISMATCH')),
      failureMessageOf(new RagRequestError(400, 'INVALID_REQUEST')),
      failureMessageOf(new RagRequestError(401, 'UNAUTHORIZED')),
      failureMessageOf(new RagRequestError(404, 'SECRET-CODE-76')),
      failureMessageOf(new RagRequestError(500, 'INTERNAL_ERROR')),
      failureMessageOf(new RagRequestError(502, 'CAPTION_FAILED')),
      failureMessageOf(new Error('boom C:\\x at f:1')),
      failureMessageOf('문자열'),
      failureMessageOf(undefined),
    ];
    expect(messages).toEqual([
      EVALUATION_MESSAGES.ragUnreachable,
      EVALUATION_MESSAGES.notSearchable,
      EVALUATION_MESSAGES.vectorMismatch,
      EVALUATION_MESSAGES.ragRejected,
      EVALUATION_MESSAGES.ragRejected,
      EVALUATION_MESSAGES.ragRejected,
      EVALUATION_MESSAGES.ragFailed,
      EVALUATION_MESSAGES.ragFailed,
      EVALUATION_MESSAGES.unexpected,
      EVALUATION_MESSAGES.unexpected,
      EVALUATION_MESSAGES.unexpected,
    ]);
    expect(EVALUATION_MESSAGES.ragUnreachable).toBe('RAG Server에 연결할 수 없습니다');
    expect(EVALUATION_MESSAGES.notSearchable).toBe('정답 문서가 검색되지 않습니다');
    for (const message of messages) {
      expect(message).not.toContain('SECRET-CODE-76');
      expect(message).not.toContain('boom');
      expect(message).not.toMatch(/INTERNAL_ERROR|CAPTION_FAILED|INVALID_REQUEST|UNAUTHORIZED/);
    }
  });
});
