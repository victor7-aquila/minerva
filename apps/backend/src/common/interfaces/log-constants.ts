/** 값이 로그에 나가면 안 되는 필드 이름이다 (MODULE.md REQ-BE-8.2.1). */
export const FORBIDDEN_LOG_KEYS: ReadonlySet<string> = new Set([
  'markdown',
  'text',
  'query',
  'answerSpan',
  'answer_span',
  'tableMarkdown',
  'hint',
  'summary',
  'caption',
  'title',
  'token',
]);

/** 지운 값 자리에 넣는 문자열이다. */
export const REMOVED = '[removed]';
/** 순환 참조 자리에 넣는 문자열이다. */
export const CIRCULAR = '[Circular]';

// ★ 이 목록은 pino redact 경로이며 serializer를 거친 요청(req)의 본문·토큰 헤더만 지운다. 금지 키 전반의 최종 방어선은 아니다.
//   금지 키는 출력 직전 hooks.streamWrite가 모든 깊이에서 지운다. formatters.log는 로그 호출 필드에 먼저 적용하는 보조 단계다
/** 로그에서 값을 지우는 경로다. */
export const REDACTED_LOG_PATHS: readonly string[] = Object.freeze([
  'req.body',
  'req.headers["x-minerva-token"]',
]);
