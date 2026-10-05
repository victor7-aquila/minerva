import { PayloadTooLargeError } from '../../common';
import { openUploadState, uploadStateOf } from './upload-state';

const LIMITS = { maxFiles: 2, maxFileBytes: 5, maxTotalBytes: 1000 };

/** 응답 대역을 만든다. */
function fakeRes(headersSent = false): { headersSent: boolean; setHeader: jest.Mock } {
  return { headersSent, setHeader: jest.fn() };
}

/** 한 틱 기다린다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('REQ-BE-7.1.1', () => {
  it('T-ST-1 openUploadState 뒤 uploadStateOf는 같은 객체를, 다른 요청은 undefined를 준다', () => {
    const req = {};
    const state = openUploadState(req, fakeRes(), LIMITS);
    expect(uploadStateOf(req)).toBe(state);
    expect(uploadStateOf({})).toBeUndefined();
  });

  it('T-ST-2 reject는 처음 한 번만 효과가 있다', async () => {
    const res = fakeRes();
    const state = openUploadState({}, res, LIMITS);
    const first = new PayloadTooLargeError('첫째');
    state.reject(first);
    state.reject(new PayloadTooLargeError('둘째'));
    await expect(state.rejection).rejects.toBe(first);
    expect(state.rejected).toBe(true);
    expect(res.setHeader).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close');
  });

  it('T-ST-3 응답 헤더를 이미 보냈으면 헤더를 달지 않고 거부는 한다', async () => {
    const res = fakeRes(true);
    const state = openUploadState({}, res, LIMITS);
    const error = new PayloadTooLargeError('x');
    state.reject(error);
    expect(res.setHeader).not.toHaveBeenCalled();
    await expect(state.rejection).rejects.toBe(error);
  });

  // ★ Jest 샌드박스에서는 process.on('unhandledRejection') 스파이가 호출되지 않는다.
  //   처리되지 않은 거부는 jest-circus가 현재 테스트의 실패로 만든다.
  //   그래서 거부가 날 만큼 기다린(tick) 뒤에 테스트를 끝내는 것으로 검출한다.
  it('T-ST-4 reject를 부르지 않고 끝나면 처리되지 않은 거부가 없다', async () => {
    const state = openUploadState({}, fakeRes(), LIMITS);
    await tick();
    await tick();
    const settled = await Promise.race([
      state.rejection.then(
        () => 'settled',
        () => 'settled',
      ),
      tick().then(() => 'pending'),
    ]);
    expect(settled).toBe('pending');
  });

  it('T-ST-4b reject 뒤 아무도 rejection을 기다리지 않아도 처리되지 않은 거부가 없다', async () => {
    const state = openUploadState({}, fakeRes(), LIMITS);
    const error = new PayloadTooLargeError('x');
    state.reject(error);
    // 아무도 기다리지 않는 채로 거부가 처리될 시간을 준다. 미처리면 jest-circus가 실패시킨다
    await tick();
    await tick();
    await expect(state.rejection).rejects.toBe(error);
  });
});
