import { PassThrough } from 'node:stream';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { firstValueFrom, of } from 'rxjs';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import { DocumentLockedError, InvalidRequestError, PayloadTooLargeError } from '../../common';
import { MultipartLimitInterceptor, UPLOAD_FILES_INTERCEPTOR } from './multipart-limit.interceptor';
import { uploadStateOf } from '../helpers/upload-state';

// ★ 로그 캡처는 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

/** 내부 FilesInterceptor 대역이다. */
const inner = { intercept: jest.fn() };

/** 가짜 요청이다. PassThrough에 headers를 붙인다. */
type FakeReq = PassThrough & { headers: Record<string, string> };

/** 가짜 요청을 만든다. */
function fakeReq(headers: Record<string, string>): FakeReq {
  const req = new PassThrough() as FakeReq;
  req.headers = headers;
  return req;
}

/** 가짜 컨텍스트를 만든다. */
function fakeContext(req: object, res: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of('handled') };
const MULTIPART = { 'content-type': 'multipart/form-data; boundary=x' };
const TOTAL_MESSAGE = '요청 전체 크기 한도(100바이트)를 넘었습니다';

let interceptor: MultipartLimitInterceptor;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      createTestCommonModule(
        {
          UPLOAD_MAX_FILES: 2,
          UPLOAD_MAX_MD_BYTES: 5,
          UPLOAD_MAX_IMAGE_BYTES: 5,
          UPLOAD_MAX_TOTAL_BYTES: 100,
        },
        capture.stream,
      ),
    ],
    providers: [MultipartLimitInterceptor, { provide: UPLOAD_FILES_INTERCEPTOR, useValue: inner }],
  }).compile();
  interceptor = moduleRef.get(MultipartLimitInterceptor);
});

beforeEach(() => {
  inner.intercept.mockReset();
});

/** 인터셉터를 실행해 방출 값을 돌려준다. 동기·비동기 던짐을 모두 거부로 바꾼다. */
async function run(req: object, res: object): Promise<unknown> {
  const observable = await interceptor.intercept(fakeContext(req, res), next);
  return firstValueFrom(observable);
}

/** 제어 가능한 Promise다. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 한 틱 기다린다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('REQ-BE-7.1.1', () => {
  it('T-MP-1 multipart가 아닌 요청은 내부 인터셉터 없이 그대로 넘긴다', async () => {
    const req = fakeReq({ 'content-type': 'application/json' });
    const res = { headersSent: false, setHeader: jest.fn() };
    expect(await run(req, res)).toBe('handled');
    expect(inner.intercept).not.toHaveBeenCalled();
  });

  it('T-MP-2 Content-Length가 한도를 넘으면 본문을 읽지 않고 413으로 막는다', async () => {
    const req = fakeReq({ ...MULTIPART, 'content-length': '101' });
    const res = { headersSent: false, setHeader: jest.fn() };
    const error = await run(req, res).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect((error as Error).message).toBe(TOTAL_MESSAGE);
    expect(inner.intercept).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    expect(req.listenerCount('data')).toBe(0);
  });

  it('T-MP-3 Content-Length가 한도와 같으면 받아들인다', async () => {
    inner.intercept.mockResolvedValue(of('handled'));
    const req = fakeReq({ ...MULTIPART, 'content-length': '100' });
    const res = { headersSent: false, setHeader: jest.fn() };
    await run(req, res);
    expect(inner.intercept).toHaveBeenCalledTimes(1);
  });

  it('T-MP-4 길이 헤더가 없어도 파싱이 끝나면 넘기고 data 리스너를 걷는다', async () => {
    inner.intercept.mockResolvedValue(of('handled'));
    const req = fakeReq(MULTIPART);
    const res = { headersSent: false, setHeader: jest.fn() };
    expect(await run(req, res)).toBe('handled');
    expect(req.listenerCount('data')).toBe(0);
  });

  it('T-MP-5 파싱 중 받은 바이트가 한도를 넘으면 바로 413으로 끝내고 늦은 실패는 삼킨다', async () => {
    // ★ Jest 안에서는 unhandledRejection 스파이가 호출되지 않는다. 늦은 실패(parsing.reject)를
    //   삼키지 못하면 jest-circus가 처리되지 않은 거부를 이 테스트의 실패로 만든다
    {
      const parsing = deferred<unknown>();
      inner.intercept.mockReturnValue(parsing.promise);
      const req = fakeReq(MULTIPART);
      const res = { headersSent: false, setHeader: jest.fn() };
      const running = run(req, res).catch((e: unknown) => e);
      await tick();
      req.write(Buffer.alloc(101));
      const error = await running;
      expect(error).toBeInstanceOf(PayloadTooLargeError);
      expect((error as Error).message).toBe(TOTAL_MESSAGE);
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
      parsing.reject(new Error('late'));
      await tick();
      await tick();
    }
  });

  it('T-MP-6 업로드 상태가 거부하면 그 오류로 끝난다', async () => {
    const parsing = deferred<unknown>();
    inner.intercept.mockReturnValue(parsing.promise);
    const req = fakeReq(MULTIPART);
    const res = { headersSent: false, setHeader: jest.fn() };
    const running = run(req, res).catch((e: unknown) => e);
    await tick();
    const cause = new PayloadTooLargeError('x');
    uploadStateOf(req)?.reject(cause);
    expect(await running).toBe(cause);
    parsing.resolve(of('late'));
  });

  it('T-MP-7 multer의 요청 형식 오류는 입력을 담지 않은 InvalidRequestError로 바꾼다', async () => {
    inner.intercept.mockRejectedValue(
      new BadRequestException('Unexpected file field - SECRET-7f3a'),
    );
    const req = fakeReq(MULTIPART);
    const res = { headersSent: false, setHeader: jest.fn() };
    const error = await run(req, res).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as Error).message).toBe('업로드 요청 형식이 올바르지 않습니다');
    expect(JSON.stringify(error)).not.toContain('SECRET-7f3a');
    expect((error as Error).message).not.toContain('SECRET-7f3a');
  });

  it('T-MP-8 Nest의 413 예외는 common PayloadTooLargeError로 바꾼다', async () => {
    inner.intercept.mockRejectedValue(new PayloadTooLargeException('x'));
    const req = fakeReq(MULTIPART);
    const res = { headersSent: false, setHeader: jest.fn() };
    const error = await run(req, res).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect((error as Error).message).toBe(new PayloadTooLargeError().message);
  });

  it('T-MP-9 도메인 오류는 같은 객체로 다시 던진다', async () => {
    const cause = new DocumentLockedError();
    inner.intercept.mockRejectedValue(cause);
    const req = fakeReq(MULTIPART);
    const res = { headersSent: false, setHeader: jest.fn() };
    expect(await run(req, res).catch((e: unknown) => e)).toBe(cause);
  });

  it('T-MP-10 그 밖의 오류는 같은 Error로 다시 던진다', async () => {
    const cause = new Error('boom');
    inner.intercept.mockRejectedValue(cause);
    const req = fakeReq(MULTIPART);
    const res = { headersSent: false, setHeader: jest.fn() };
    expect(await run(req, res).catch((e: unknown) => e)).toBe(cause);
  });
});
