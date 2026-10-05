import type { ErrorCode } from '../../common';

/** 도메인 오류 코드별 HTTP 상태다. API.md 「오류 코드」와 같다. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  INVALID_REQUEST: 400,
  UNSUPPORTED_FILE: 400,
  ANSWER_SPAN_NOT_FOUND: 400,
  UNAUTHORIZED: 401,
  DOCUMENT_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  GOLDEN_SET_NOT_FOUND: 404,
  DOCUMENT_LOCKED: 409,
  DOCUMENT_NOT_SEARCHABLE: 409,
  EVALUATION_IN_PROGRESS: 409,
  PAYLOAD_TOO_LARGE: 413,
  RAG_UNAVAILABLE: 503,
});

/** 예상하지 못한 서버 오류의 코드·상태·메시지다. ★ DomainError가 아니다 (필터 전용) */
export const INTERNAL_ERROR = Object.freeze({
  code: 'INTERNAL_ERROR',
  status: 500,
  message: '서버에서 예상하지 못한 오류가 발생했습니다',
});

/** 없는 경로의 코드·상태·메시지다. ★ DomainError가 아니다 (필터 전용, ErrorCode에 넣지 않는다) */
export const NOT_FOUND = Object.freeze({
  code: 'NOT_FOUND',
  status: 404,
  message: '요청한 경로를 찾을 수 없습니다',
});
