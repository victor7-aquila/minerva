import { Writable } from 'node:stream';

/** 로그 줄을 모으는 출력과 조회 함수다. */
export interface LogCapture {
  readonly stream: Writable;
  /** 지금까지 모인 원문 줄 */
  readonly lines: string[];
  /** 줄을 JSON으로 파싱한 목록 */
  parsed(): Record<string, unknown>[];
  /** 모인 줄을 비운다 */
  clear(): void;
}

/** 로그 줄을 모으는 출력을 만든다. */
export function createLogCapture(): LogCapture {
  // ★ clear가 같은 배열을 비운다. 배열을 바꿔 끼우면 stream이 옛 배열에 쓴다
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      callback();
    },
  });
  return {
    stream,
    lines,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    clear: () => {
      lines.length = 0;
    },
  };
}
