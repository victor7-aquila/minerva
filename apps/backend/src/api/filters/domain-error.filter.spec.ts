import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import {
  AnswerSpanNotFoundError,
  AssetNotFoundError,
  DocumentLockedError,
  DocumentNotFoundError,
  DocumentNotSearchableError,
  EvaluationInProgressError,
  GoldenSetNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
  RagUnavailableError,
  UnauthorizedError,
  UnsupportedFileError,
  toIsoUtc,
} from '../../common';
import type { DomainError } from '../../common';
import { DomainErrorFilter } from './domain-error.filter';
import { ERROR_STATUS, INTERNAL_ERROR, NOT_FOUND } from '../interfaces/error-status';
import { RequestValidationError } from '../helpers/validation';

// ★ 로그 캡처는 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

/** API.md 「오류 코드」 상태 표다. */
const STATUS_TABLE: Record<string, number> = {
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
};

const INTERNAL_MESSAGE = '서버에서 예상하지 못한 오류가 발생했습니다';

/** 가짜 응답이다. */
interface FakeRes {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  setHeader(key: string, value: string): void;
}

/** 가짜 ArgumentsHost를 만든다. */
function fakeHost(url = '/v1/logs?name=SECRET-7f3a'): { host: ArgumentsHost; res: FakeRes } {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    headersSent: false,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
  };
  const req = { method: 'GET', originalUrl: url, url, path: url.split('?')[0] };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  };
  return { host: host as unknown as ArgumentsHost, res };
}

let filter: DomainErrorFilter;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({}, capture.stream)],
    providers: [DomainErrorFilter],
  }).compile();
  filter = moduleRef.get(DomainErrorFilter);
});

beforeEach(() => {
  capture.clear();
});

/** 필터를 실행하고 응답과 `api.` 로그를 돌려준다. */
function handle(
  exception: unknown,
  url?: string,
  prepare?: (res: FakeRes) => void,
): { res: FakeRes; logs: Record<string, unknown>[]; lines: string[] } {
  const { host, res } = fakeHost(url);
  prepare?.(res);
  filter.catch(exception, host);
  const lines = capture.lines.filter((line) => line.includes('"msg":"api.'));
  const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { res, logs, lines };
}

/** 오류 본문 모양을 단언한다. */
function expectErrorBody(body: unknown, code: string, message?: string): void {
  const typed = body as { error: { code: string; message: string } };
  expect(Object.keys(typed)).toEqual(['error']);
  expect(Object.keys(typed.error).sort()).toEqual(['code', 'message']);
  expect(typed.error.code).toBe(code);
  if (message !== undefined) expect(typed.error.message).toBe(message);
  expect(typed.error.message).toMatch(/[가-힣]/);
}

/** 12개 common 오류 클래스다. */
const DOMAIN_CLASSES: Array<[string, new () => DomainError]> = [
  ['InvalidRequestError', InvalidRequestError],
  ['UnsupportedFileError', UnsupportedFileError],
  ['AnswerSpanNotFoundError', AnswerSpanNotFoundError],
  ['UnauthorizedError', UnauthorizedError],
  ['DocumentNotFoundError', DocumentNotFoundError],
  ['AssetNotFoundError', AssetNotFoundError],
  ['GoldenSetNotFoundError', GoldenSetNotFoundError],
  ['DocumentLockedError', DocumentLockedError],
  ['DocumentNotSearchableError', DocumentNotSearchableError],
  ['EvaluationInProgressError', EvaluationInProgressError],
  ['PayloadTooLargeError', PayloadTooLargeError],
  ['RagUnavailableError', RagUnavailableError],
];

describe('REQ-BE-8.3.1', () => {
  it.each(DOMAIN_CLASSES)(
    'T-FLT-1 %s는 표의 상태와 {error:{code,message}} 본문이 된다',
    (_name, Cls) => {
      const error = new Cls();
      const { res } = handle(error);
      expect(res.statusCode).toBe(STATUS_TABLE[error.code]);
      expectErrorBody(res.body, error.code, error.message);
    },
  );

  it('T-FLT-2 ERROR_STATUS는 12개 코드의 상태 표와 같고 필터 전용 코드를 담지 않는다', () => {
    expect({ ...ERROR_STATUS }).toEqual(STATUS_TABLE);
    expect(Object.keys(ERROR_STATUS)).not.toContain('NOT_FOUND');
    expect(Object.keys(ERROR_STATUS)).not.toContain('INTERNAL_ERROR');
    expect(INTERNAL_ERROR).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(NOT_FOUND).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('T-FLT-3 메시지를 준 PayloadTooLargeError는 413과 그 메시지로 응답한다', () => {
    const { res } = handle(new PayloadTooLargeError('파일은 한 요청에 3개까지 올릴 수 있습니다'));
    expect(res.statusCode).toBe(413);
    expectErrorBody(res.body, 'PAYLOAD_TOO_LARGE', '파일은 한 요청에 3개까지 올릴 수 있습니다');
  });

  it('T-FLT-9 업무 도메인 오류는 api 로그를 남기지 않는다', () => {
    const first = handle(new DocumentNotFoundError());
    expect(first.res.statusCode).toBe(404);
    expect(first.logs).toHaveLength(0);
    const second = handle(new InvalidRequestError('날짜는 YYYY-MM-DD 형식이어야 합니다'));
    expect(second.res.statusCode).toBe(400);
    expectErrorBody(second.res.body, 'INVALID_REQUEST', '날짜는 YYYY-MM-DD 형식이어야 합니다');
    expect(second.logs).toHaveLength(0);
  });

  it('T-FLT-11 앞 단계가 단 Connection: close 헤더를 지우지 않는다', () => {
    const { res } = handle(new PayloadTooLargeError(), undefined, (r) =>
      r.setHeader('Connection', 'close'),
    );
    expect(res.statusCode).toBe(413);
    expect(res.headers.connection).toBe('close');
  });
});

describe('REQ-BE-8.3.2', () => {
  it('T-FLT-4 일반 Error는 500 고정 문장이고 입력·경로·스택 첫 줄이 응답과 로그에 없다', () => {
    const { res, logs, lines } = handle(new Error('SECRET-7f3a C:\\secret\\path SELECT * FROM x'));
    expect(res.statusCode).toBe(500);
    expectErrorBody(res.body, 'INTERNAL_ERROR', INTERNAL_MESSAGE);
    const body = JSON.stringify(res.body);
    for (const forbidden of ['SECRET-7f3a', 'Error:', 'at ', '\\', '/']) {
      expect(body).not.toContain(forbidden);
    }
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.msg).toBe('api.unhandled');
    expect(log.level).toBe(50);
    expect(log.path).toBe('/v1/logs');
    expect(log.errorName).toBe('Error');
    expect(typeof log.stack).toBe('string');
    expect(log.stack as string).toContain('at ');
    expect(log.stack as string).not.toContain('SECRET-7f3a');
    expect(lines.join('\n')).not.toContain('SECRET-7f3a');
  });

  it('T-FLT-4b 여러 줄 message의 Error도 stack은 첫 프레임부터이고 메시지 줄이 로그에 없다', () => {
    const error = new Error(
      'SECRET-7f3a\nSECOND-LINE SECRET-7f3a\n    at fake (SECRET-7f3a.ts:1:1)',
    );
    const { logs, lines } = handle(error);
    expect(logs).toHaveLength(1);
    const stack = logs[0].stack as string;
    expect(typeof stack).toBe('string');
    expect(stack.startsWith('    at ')).toBe(true);
    expect(stack).not.toContain('SECOND-LINE');
    expect(lines.join('\n')).not.toContain('SECOND-LINE');
  });

  it('T-FLT-4c 프레임 줄이 없는 스택이면 stack은 빈 문자열이고 로그에 메시지가 없다', () => {
    const error = new Error('SECRET-7f3a');
    error.stack = 'Error: SECRET-7f3a';
    const { logs, lines } = handle(error);
    expect(logs).toHaveLength(1);
    expect(logs[0].stack).toBe('');
    expect(lines.join('\n')).not.toContain('SECRET-7f3a');
  });

  it('T-FLT-5 RangeError·TypeError도 500이고 errorName이 남는다', () => {
    let rangeError: unknown;
    try {
      toIsoUtc(new Date(NaN));
    } catch (error) {
      rangeError = error;
    }
    expect(rangeError).toBeInstanceOf(RangeError);
    const range = handle(rangeError);
    expect(range.res.statusCode).toBe(500);
    expectErrorBody(range.res.body, 'INTERNAL_ERROR', INTERNAL_MESSAGE);
    expect(range.logs[0].errorName).toBe('RangeError');
    capture.clear();
    const type = handle(new TypeError('x'));
    expect(type.res.statusCode).toBe(500);
    expect(type.logs[0].errorName).toBe('TypeError');
  });

  it.each([['SECRET-7f3a'], [undefined], [{ message: 'SECRET-7f3a' }]])(
    'T-FLT-6 Error가 아닌 값(%p)은 UnknownError로 500이고 stack 필드가 없다',
    (thrown) => {
      const { res, logs, lines } = handle(thrown);
      expect(res.statusCode).toBe(500);
      expectErrorBody(res.body, 'INTERNAL_ERROR', INTERNAL_MESSAGE);
      expect(logs).toHaveLength(1);
      expect(logs[0].errorName).toBe('UnknownError');
      expect('stack' in logs[0]).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
      expect(lines.join('\n')).not.toContain('SECRET-7f3a');
    },
  );

  it('T-FLT-7e 5xx HttpException은 500 INTERNAL_ERROR이고 api.unhandled를 남긴다', () => {
    for (const exception of [
      new HttpException('SECRET-7f3a', 503),
      new InternalServerErrorException('SECRET-7f3a'),
    ]) {
      capture.clear();
      const { res, logs, lines } = handle(exception);
      expect(res.statusCode).toBe(500);
      expectErrorBody(res.body, 'INTERNAL_ERROR', INTERNAL_MESSAGE);
      expect(logs.map((log) => log.msg)).toEqual(['api.unhandled']);
      expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
      expect(lines.join('\n')).not.toContain('SECRET-7f3a');
    }
  });

  it('T-FLT-7f 4xx가 아니거나 expose가 아닌 일반 객체는 500이다', () => {
    for (const exception of [
      { status: 413, expose: false },
      { status: 302, expose: true },
    ]) {
      const { res } = handle(exception);
      expect(res.statusCode).toBe(500);
      expectErrorBody(res.body, 'INTERNAL_ERROR', INTERNAL_MESSAGE);
    }
  });

  it('T-FLT-10 이미 헤더를 보낸 응답에는 쓰지 않고 예외도 밖으로 내지 않는다', () => {
    const generic = handle(new Error('x'), undefined, (r) => {
      r.headersSent = true;
    });
    expect(generic.res.statusCode).toBe(0);
    expect(generic.res.body).toBeUndefined();
    expect(generic.logs.map((log) => log.msg)).toEqual(['api.unhandled']);
    capture.clear();
    const domain = handle(new DocumentNotFoundError(), undefined, (r) => {
      r.headersSent = true;
    });
    expect(domain.res.statusCode).toBe(0);
    expect(domain.res.body).toBeUndefined();
    expect(domain.logs).toHaveLength(0);
  });
});

describe('REQ-BE-7.1.1', () => {
  it('T-FLT-7a 없는 경로 예외는 404 NOT_FOUND 고정 문장이고 로그가 없다', () => {
    const { res, logs } = handle(new NotFoundException('Cannot GET /v1/nope?q=SECRET-7f3a'));
    expect(res.statusCode).toBe(404);
    expectErrorBody(res.body, 'NOT_FOUND', '요청한 경로를 찾을 수 없습니다');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SECRET-7f3a');
    expect(body).not.toContain('Cannot');
    expect(logs).toHaveLength(0);
  });
});

describe('REQ-BE-7.1.2', () => {
  it('T-FLT-7b 잘못된 JSON 예외는 400 INVALID_REQUEST 기본 문장이고 로그가 없다', () => {
    const { res, logs } = handle(
      new BadRequestException('Unexpected token \'S\', "{\\"a\\": SECRET-7f3a" is not valid JSON'),
    );
    expect(res.statusCode).toBe(400);
    expectErrorBody(res.body, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
    expect(logs).toHaveLength(0);
  });

  it('T-FLT-7c body-parser 모양의 413 오류는 PAYLOAD_TOO_LARGE 고정 문장이다', () => {
    const exception = Object.assign(new Error('request entity too large'), {
      name: 'PayloadTooLargeError',
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const { res } = handle(exception);
    expect(res.statusCode).toBe(413);
    // ★ 이름이 같아도 common 클래스로 보지 않는다
    expectErrorBody(res.body, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다');
  });

  it('T-FLT-7d 그 밖의 4xx는 400 INVALID_REQUEST이고 입력을 담지 않는다', () => {
    for (const exception of [new HttpException('SECRET-7f3a', 415), new HttpException('x', 405)]) {
      const { res } = handle(exception);
      expect(res.statusCode).toBe(400);
      expectErrorBody(res.body, 'INVALID_REQUEST');
      expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
    }
  });

  it('T-FLT-8 검증 오류는 필드 이름만 응답과 api.request_invalid 로그에 남긴다', () => {
    const { res, logs, lines } = handle(
      new RequestValidationError(['page_size', 'foo']),
      '/v1/logs?page_size=SECRET-7f3a&foo=1',
    );
    expect(res.statusCode).toBe(400);
    expectErrorBody(res.body, 'INVALID_REQUEST');
    const message = (res.body as { error: { message: string } }).error.message;
    expect(message).toContain('page_size');
    expect(message).toContain('foo');
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe('api.request_invalid');
    expect(logs[0].level).toBe(40);
    expect(logs[0].path).toBe('/v1/logs');
    expect(logs[0].fields).toEqual(['page_size', 'foo']);
    expect(lines.join('\n')).not.toContain('SECRET-7f3a');
  });
});
