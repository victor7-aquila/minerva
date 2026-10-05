import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnswerSpanNotFoundError,
  AssetNotFoundError,
  DocumentLockedError,
  DocumentNotFoundError,
  DocumentNotSearchableError,
  DomainError,
  EvaluationInProgressError,
  GoldenSetNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
  RagUnavailableError,
  UnauthorizedError,
  UnsupportedFileError,
} from './domain-errors';
import type { ErrorCode } from './domain-errors';

/** 클래스와 기대 코드다. API.md 「오류 코드」에서 INTERNAL_ERROR·NOT_FOUND를 뺀 목록을 고정한다. */
const CASES: [new (message?: string) => DomainError, string][] = [
  [InvalidRequestError, 'INVALID_REQUEST'],
  [UnsupportedFileError, 'UNSUPPORTED_FILE'],
  [PayloadTooLargeError, 'PAYLOAD_TOO_LARGE'],
  [UnauthorizedError, 'UNAUTHORIZED'],
  [DocumentNotFoundError, 'DOCUMENT_NOT_FOUND'],
  [AssetNotFoundError, 'ASSET_NOT_FOUND'],
  [GoldenSetNotFoundError, 'GOLDEN_SET_NOT_FOUND'],
  [DocumentLockedError, 'DOCUMENT_LOCKED'],
  [DocumentNotSearchableError, 'DOCUMENT_NOT_SEARCHABLE'],
  [AnswerSpanNotFoundError, 'ANSWER_SPAN_NOT_FOUND'],
  [EvaluationInProgressError, 'EVALUATION_IN_PROGRESS'],
  [RagUnavailableError, 'RAG_UNAVAILABLE'],
];

const NAMED_CASES: [string, new (message?: string) => DomainError, string][] = CASES.map(
  ([cls, code]) => [cls.name, cls, code],
);

describe('REQ-BE-8.3.1', () => {
  it.each(NAMED_CASES)('T-ERR-1 %s는 코드와 한국어 기본 메시지를 가진다', (name, Cls, code) => {
    const err = new Cls();
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.message).not.toBe('');
    expect(err.message).toMatch(/[가-힣]/);
    expect(err.name).toBe(name);
  });

  it.each(NAMED_CASES)('T-ERR-2 %s는 넘긴 메시지를 쓴다', (_name, Cls) => {
    const message = '판 표기와 판 날짜는 함께 입력해야 합니다';
    expect(new Cls(message).message).toBe(message);
  });

  it('T-ERR-3 코드 목록이 API.md와 같다', () => {
    const codes = CASES.map(([Cls]) => new Cls().code);
    expect(new Set(codes).size).toBe(12);
    expect(new Set(codes)).toEqual(new Set(CASES.map(([, code]) => code)));
    expect(codes).not.toContain('INTERNAL_ERROR');
    expect(codes).not.toContain('NOT_FOUND');

    // ★ API.md 「오류 코드」 표에서 INTERNAL_ERROR·NOT_FOUND(api가 프레임워크 오류에만 쓰는 코드)를 뺀 집합이 클래스 코드 집합과 양방향으로 같다
    const api = readFileSync(join(__dirname, '..', '..', '..', 'API.md'), 'utf-8');
    const section = api.slice(api.indexOf('## 오류 코드'));
    const documented = [...section.matchAll(/^\| `([A-Z_]+)` \| `\d{3}` \|/gm)]
      .map((m) => m[1])
      .filter((c) => c !== 'INTERNAL_ERROR' && c !== 'NOT_FOUND');
    expect(new Set(documented)).toEqual(new Set(codes));
    expect(documented).toHaveLength(codes.length);
  });

  it('T-ERR-4 ErrorCode 타입은 INTERNAL_ERROR를 허용하지 않는다', () => {
    const ok: ErrorCode = 'RAG_UNAVAILABLE';
    // @ts-expect-error INTERNAL_ERROR는 도메인 오류 코드가 아니다
    const _ng: ErrorCode = 'INTERNAL_ERROR';
    expect(ok).toBe('RAG_UNAVAILABLE');
  });
});

describe('REQ-BE-8.3.2', () => {
  it.each(NAMED_CASES)('T-ERR-5 %s의 기본 메시지에 내부 표현이 없다', (_name, Cls) => {
    const { message } = new Cls();
    expect(message).not.toMatch(/[\\/]/);
    expect(message).not.toMatch(/Error:/);
    expect(message).not.toMatch(/\b(select|insert|update|delete|find|aggregate)\b/i);
    expect(message).not.toMatch(/\$[a-z]+/);
    expect(message).not.toMatch(/[{}]/);
    expect(message).not.toMatch(/\bat\s+\S+\s+\(/);
  });

  it.each(NAMED_CASES)('T-ERR-6 %s는 원인·내부 문자열을 붙이지 않는다', (_name, Cls) => {
    const err = new Cls();

    // ★ 생성자는 메시지 하나만 받는다. 구현이 cause·원문을 덧붙이면 깨진다
    expect(err.message).toBe(new Cls().message);
    expect('cause' in err).toBe(false);
  });
});
