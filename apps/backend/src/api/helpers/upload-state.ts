import type { PayloadTooLargeError } from '../../common';
import type { UploadLimits } from './upload-limits';

/** 한 multipart 요청의 한도 검사 상태다. */
export interface UploadState {
  readonly limits: UploadLimits;
  /** 지금까지 만난 files 필드의 파일 수 */
  fileCount: number;
  /** 지금까지 받은 본문 바이트 */
  totalBytes: number;
  /** 한도를 넘어 거부했는가 */
  readonly rejected: boolean;
  /** 한 번만 거부한다. 응답에 Connection: close를 달고 rejection을 이 오류로 끝낸다. */
  reject(error: PayloadTooLargeError): void;
  /** reject가 불리면 거부되는 Promise다. 이행되지 않는다. */
  readonly rejection: Promise<never>;
}

/** 응답 헤더를 다는 데 필요한 멤버다. */
export interface ClosableResponse {
  readonly headersSent: boolean;
  setHeader(name: string, value: string): unknown;
}

// ★ 요청 객체가 사라지면 상태도 함께 사라진다
const states = new WeakMap<object, UploadState>();

/** 요청에 업로드 상태를 열어 붙인다. */
export function openUploadState(
  req: object,
  res: ClosableResponse,
  limits: UploadLimits,
): UploadState {
  let rejectFn: (error: PayloadTooLargeError) => void = () => undefined;
  const rejection = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
  });
  // ★ 경주가 끝난 뒤 거부돼도 처리되지 않은 거부가 생기지 않게 한다
  rejection.catch(() => undefined);

  let rejected = false;
  const state: UploadState = {
    limits,
    fileCount: 0,
    totalBytes: 0,
    get rejected() {
      return rejected;
    },
    reject(error: PayloadTooLargeError): void {
      if (rejected) {
        return;
      }
      rejected = true;
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
      }
      rejectFn(error);
    },
    rejection,
  };
  states.set(req, state);
  return state;
}

/** 요청에 붙은 업로드 상태를 찾는다. */
export function uploadStateOf(req: object): UploadState | undefined {
  return states.get(req);
}
