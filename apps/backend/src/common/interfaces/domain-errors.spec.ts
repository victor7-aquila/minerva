import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnswerSpanNotFoundError,
  AssetNotFoundError,
  BatchIndexingError,
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

type ErrorFactory = (message?: string) => DomainError;

/** 클래스와 기대 코드다. API.md 「오류 코드」에서 INTERNAL_ERROR·NOT_FOUND를 뺀 목록을 고정한다. */
const CLASS_CASES: [new (message?: string) => DomainError, string][] = [
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

// ★ BatchIndexingError는 생성자 첫 인자가 남은 작업 수라 팩토리로 감싼다
const NAMED_CASES: [string, ErrorFactory, string][] = [
  ...CLASS_CASES.map(([Cls, code]): [string, ErrorFactory, string] => [
    Cls.name,
    (m) => new Cls(m),
    code,
  ]),
  ['BatchIndexingError', (m) => new BatchIndexingError(3, m), 'BATCH_INDEXING'],
];

describe('REQ-BE-8.3.1', () => {
  it.each(NAMED_CASES)('T-ERR-1 %s는 코드와 한국어 기본 메시지를 가진다', (name, make, code) => {
    const err = make();
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.message).not.toBe('');
    expect(err.message).toMatch(/[가-힣]/);
    expect(err.name).toBe(name);
  });

  it.each(NAMED_CASES)('T-ERR-2 %s는 넘긴 메시지를 쓴다', (_name, make) => {
    const message = '판 표기와 판 날짜는 함께 입력해야 합니다';
    expect(make(message).message).toBe(message);
  });

  it('T-ERR-3 코드 목록이 API.md와 같다', () => {
    const codes = NAMED_CASES.map(([, make]) => make().code);
    expect(new Set(codes).size).toBe(13);
    expect(new Set(codes)).toEqual(new Set(NAMED_CASES.map(([, , code]) => code)));
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

  it('T-ERR-7 BatchIndexingError만 details를 가지고 나머지 도메인 오류는 null이다', () => {
    const batch = new BatchIndexingError(3);
    expect(batch.details).toEqual({ remaining_jobs: 3 });
    expect(batch.remainingJobs).toBe(3);

    for (const [name, make] of NAMED_CASES) {
      if (name === 'BatchIndexingError') continue;
      expect(make().details).toBeNull();
    }
  });

  it('T-ERR-4 ErrorCode 타입은 INTERNAL_ERROR를 허용하지 않는다', () => {
    const ok: ErrorCode = 'RAG_UNAVAILABLE';
    // @ts-expect-error INTERNAL_ERROR는 도메인 오류 코드가 아니다
    const _ng: ErrorCode = 'INTERNAL_ERROR';
    expect(ok).toBe('RAG_UNAVAILABLE');
  });
});

describe('REQ-BE-8.3.2', () => {
  it.each(NAMED_CASES)('T-ERR-5 %s의 기본 메시지에 내부 표현이 없다', (_name, make) => {
    const { message } = make();
    expect(message).not.toMatch(/[\\/]/);
    expect(message).not.toMatch(/Error:/);
    expect(message).not.toMatch(/\b(select|insert|update|delete|find|aggregate)\b/i);
    expect(message).not.toMatch(/\$[a-z]+/);
    expect(message).not.toMatch(/[{}]/);
    expect(message).not.toMatch(/\bat\s+\S+\s+\(/);
  });

  it.each(NAMED_CASES)('T-ERR-6 %s는 원인·내부 문자열을 붙이지 않는다', (_name, make) => {
    const err = make();

    // ★ 구현이 cause·원문을 덧붙이면 깨진다
    expect(err.message).toBe(make().message);
    expect('cause' in err).toBe(false);
  });
});

describe('REQ-BE-8.3.2', () => {
  it('T-ERR-8 BatchIndexingError 기본 메시지에 남은 수·코드·경로가 없다', () => {
    const { message } = new BatchIndexingError(7);
    expect(message).toMatch(/[가-힣]/);
    expect(message).not.toContain('7');
    expect(message).not.toContain('BATCH_INDEXING');
    expect(message).not.toContain('/');
  });
});
