import { Readable } from 'node:stream';
import { PayloadTooLargeError } from '../../common';
import { createMulterOptions } from './multer-options';
import { openUploadState } from './upload-state';
import type { UploadState } from './upload-state';

/** 파일 필터 콜백 모양이다. */
type FilterCallback = (error: Error | null, accept?: boolean) => void;
/** 저장 엔진 콜백 모양이다. */
type StoreCallback = (error?: unknown, info?: { buffer: Buffer; size: number }) => void;

/** 옵션에서 꺼낸 필터·엔진을 느슨한 타입으로 다룬다. */
interface LooseOptions {
  defParamCharset?: string;
  limits?: Record<string, unknown>;
  fileFilter(req: object, file: object, cb: FilterCallback): void;
  storage: {
    _handleFile(req: object, file: object, cb: StoreCallback): void;
    _removeFile(req: object, file: object, cb: (error: unknown) => void): void;
  };
}

const LIMITS = { maxFiles: 2, maxFileBytes: 5, maxTotalBytes: 1000 };

/** 요청·응답·상태·옵션 준비물을 만든다. */
function setup(): {
  req: object;
  res: { headersSent: boolean; setHeader: jest.Mock };
  state: UploadState;
  opts: LooseOptions;
} {
  const req = {};
  const res = { headersSent: false, setHeader: jest.fn() };
  const state = openUploadState(req, res, LIMITS);
  const opts = createMulterOptions() as unknown as LooseOptions;
  return { req, res, state, opts };
}

/** 스트림을 가진 가짜 파일을 만든다. */
function fakeFile(
  chunks: Buffer[],
  originalname = 'a.md',
): { originalname: string; stream: Readable } {
  return { originalname, stream: Readable.from(chunks) };
}

/** 필터를 실행하고 accept 값을 돌려준다. */
function runFilter(opts: LooseOptions, req: object): Promise<boolean | undefined> {
  return new Promise((resolve, reject) => {
    opts.fileFilter(req, { originalname: 'a.md' }, (error, accept) =>
      error ? reject(error) : resolve(accept),
    );
  });
}

/** 저장 엔진 `_handleFile`을 실행하고 콜백 인자를 돌려준다. */
function runStore(
  opts: LooseOptions,
  req: object,
  file: object,
): Promise<{ error?: unknown; info?: { buffer: Buffer; size: number } }> {
  return new Promise((resolve) => {
    opts.storage._handleFile(req, file, (error, info) => resolve({ error, info }));
  });
}

describe('REQ-BE-7.1.1', () => {
  it('T-MO-1 파일 이름은 utf8로 읽고 multer 기본 한도(files·fileSize)는 두지 않는다', () => {
    const opts = createMulterOptions() as unknown as LooseOptions;
    expect(opts.defParamCharset).toBe('utf8');
    expect(opts.limits?.files).toBeUndefined();
    expect(opts.limits?.fileSize).toBeUndefined();
    expect(Object.keys(opts.limits ?? {})).not.toContain('files');
    expect(Object.keys(opts.limits ?? {})).not.toContain('fileSize');
  });

  it('T-MO-2 한도 안의 파일은 받고 개수를 센다', async () => {
    const { req, state, opts } = setup();
    expect(await runFilter(opts, req)).toBe(true);
    expect(await runFilter(opts, req)).toBe(true);
    expect(state.fileCount).toBe(2);
    expect(state.rejected).toBe(false);
  });

  it('T-MO-3 한도를 넘는 파일은 건너뛰고 상태를 거부하며 연결을 닫게 한다', async () => {
    const { req, res, state, opts } = setup();
    await runFilter(opts, req);
    await runFilter(opts, req);
    expect(await runFilter(opts, req)).toBe(false);
    expect(state.rejected).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
    const rejection = await state.rejection.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PayloadTooLargeError);
    expect((rejection as Error).message).toContain('파일은 한 요청에 2개까지');
  });

  it('T-MO-4 거부된 뒤에는 개수를 더 세지 않고 헤더도 다시 달지 않는다', async () => {
    const { req, res, state, opts } = setup();
    await runFilter(opts, req);
    await runFilter(opts, req);
    await runFilter(opts, req);
    const countBefore = state.fileCount;
    const callsBefore = res.setHeader.mock.calls.length;
    expect(await runFilter(opts, req)).toBe(false);
    expect(state.fileCount).toBe(countBefore);
    expect(res.setHeader.mock.calls.length).toBe(callsBefore);
  });

  it('T-MO-5 한도와 같은 크기(5바이트)의 파일은 받는다', async () => {
    const { req, state, opts } = setup();
    const file = fakeFile([Buffer.from([1, 2]), Buffer.from([3, 4, 5])]);
    const { error, info } = await runStore(opts, req, file);
    expect(error).toBeNull();
    expect(info?.size).toBe(5);
    expect(info?.buffer.equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true);
    expect(state.rejected).toBe(false);
  });

  it('T-MO-6 한도를 넘는 파일은 파일 이름이 담긴 메시지로 거부하고 빈 결과를 낸다', async () => {
    const { req, state, opts } = setup();
    const file = fakeFile([Buffer.alloc(6, 1)], '큰 문서.md');
    const { info } = await runStore(opts, req, file);
    expect(state.rejected).toBe(true);
    const rejection = await state.rejection.catch((error: unknown) => error);
    expect((rejection as Error).message).toBe(
      '파일 하나의 크기 한도(5바이트)를 넘었습니다: 큰 문서.md',
    );
    expect(info?.buffer.length).toBe(0);
    expect(info?.size).toBe(0);
  });

  it('T-MO-7 이미 거부된 상태에서는 바이트를 모으지 않고 size 0으로 끝난다', async () => {
    const { req, state, opts } = setup();
    state.reject(new PayloadTooLargeError('먼저'));
    const { info } = await runStore(opts, req, fakeFile([Buffer.from('abc')]));
    expect(info?.buffer.length).toBe(0);
    expect(info?.size).toBe(0);
  });

  it('T-MO-8 스트림 오류는 콜백 오류로 전달한다', async () => {
    const { req, opts } = setup();
    const stream = new Readable({ read() {} });
    const pending = runStore(opts, req, { originalname: 'a.md', stream });
    const failure = new Error('스트림 오류');
    stream.destroy(failure);
    const { error } = await pending;
    expect(error).toBe(failure);
  });

  it('T-MO-9 업로드 상태가 없는 요청은 필터·엔진 모두 오류 인자를 준다', async () => {
    const opts = createMulterOptions() as unknown as LooseOptions;
    await expect(runFilter(opts, {})).rejects.toBeInstanceOf(Error);
    const { error } = await runStore(opts, {}, fakeFile([Buffer.from('a')]));
    expect(error).toBeInstanceOf(Error);
  });

  it('T-MO-10 _removeFile은 버퍼를 비우고 성공으로 끝난다', async () => {
    const opts = createMulterOptions() as unknown as LooseOptions;
    const file: { buffer?: Buffer } = { buffer: Buffer.from('a') };
    const result = await new Promise<unknown>((resolve) => {
      opts.storage._removeFile({}, file, resolve);
    });
    expect(result).toBeNull();
    expect(file.buffer).toBeUndefined();
  });
});
