/** 도메인 오류 코드다. API.md 「오류 코드」에서 INTERNAL_ERROR를 뺀 목록과 같다. */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_FILE'
  | 'ANSWER_SPAN_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'DOCUMENT_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'GOLDEN_SET_NOT_FOUND'
  | 'DOCUMENT_LOCKED'
  | 'DOCUMENT_NOT_SEARCHABLE'
  | 'EVALUATION_IN_PROGRESS'
  | 'PAYLOAD_TOO_LARGE'
  | 'RAG_UNAVAILABLE';

/** 경계 밖으로 나가는 오류의 기반이다. */
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;

  constructor(message?: string) {
    super(message);
    // ★ 하위 클래스 이름이 name이 된다 (로그의 errorName, String(err))
    this.name = new.target.name;
  }
}

/** 요청 내용이 계약에 맞지 않을 때 던진다. */
export class InvalidRequestError extends DomainError {
  readonly code = 'INVALID_REQUEST' as const;

  constructor(message = '요청 형식이 올바르지 않습니다') {
    super(message);
  }
}

/** 받지 않는 형식의 파일이 있을 때 던진다. */
export class UnsupportedFileError extends DomainError {
  readonly code = 'UNSUPPORTED_FILE' as const;

  constructor(message = '지원하지 않는 형식의 파일이 있습니다') {
    super(message);
  }
}

/** 업로드 한도를 넘었을 때 던진다. */
export class PayloadTooLargeError extends DomainError {
  readonly code = 'PAYLOAD_TOO_LARGE' as const;

  constructor(message = '업로드 한도를 넘었습니다') {
    super(message);
  }
}

/** 알림 토큰이 없거나 다를 때 던진다. */
export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHORIZED' as const;

  constructor(message = '알림 토큰이 없거나 올바르지 않습니다') {
    super(message);
  }
}

/** 문서가 없거나 삭제됐을 때 던진다. */
export class DocumentNotFoundError extends DomainError {
  readonly code = 'DOCUMENT_NOT_FOUND' as const;

  constructor(message = '문서를 찾을 수 없습니다') {
    super(message);
  }
}

/** 그 이미지가 없을 때 던진다. */
export class AssetNotFoundError extends DomainError {
  readonly code = 'ASSET_NOT_FOUND' as const;

  constructor(message = '이미지를 찾을 수 없습니다') {
    super(message);
  }
}

/** 골든셋이 없을 때 던진다. */
export class GoldenSetNotFoundError extends DomainError {
  readonly code = 'GOLDEN_SET_NOT_FOUND' as const;

  constructor(message = '골든셋을 찾을 수 없습니다') {
    super(message);
  }
}

/** 처리 중이거나 교체된 문서를 바꾸려 할 때 던진다. */
export class DocumentLockedError extends DomainError {
  readonly code = 'DOCUMENT_LOCKED' as const;

  constructor(message = '처리 중이거나 교체된 문서라 바꿀 수 없습니다') {
    super(message);
  }
}

/** 검색 가능이 아닌 문서를 정답 문서로 고를 때 던진다. */
export class DocumentNotSearchableError extends DomainError {
  readonly code = 'DOCUMENT_NOT_SEARCHABLE' as const;

  constructor(message = '검색 가능한 문서만 정답 문서로 고를 수 있습니다') {
    super(message);
  }
}

/** 정답 구간이 색인용 MD에 없을 때 던진다. */
export class AnswerSpanNotFoundError extends DomainError {
  readonly code = 'ANSWER_SPAN_NOT_FOUND' as const;

  constructor(message = '정답 구간을 정답 문서에서 찾을 수 없습니다') {
    super(message);
  }
}

/** 평가 중인 골든셋이 있을 때 던진다. */
export class EvaluationInProgressError extends DomainError {
  readonly code = 'EVALUATION_IN_PROGRESS' as const;

  constructor(message = '평가 중인 골든셋이 있어 전체 다시 평가를 할 수 없습니다') {
    super(message);
  }
}

/** RAG Server가 응답하지 않거나 준비 중일 때 던진다. */
export class RagUnavailableError extends DomainError {
  readonly code = 'RAG_UNAVAILABLE' as const;

  constructor(message = 'RAG Server가 응답하지 않거나 준비 중입니다') {
    super(message);
  }
}
