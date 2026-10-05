import * as http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 가짜 서버가 받은 요청 한 건이다. */
export interface RecordedRequest {
  method: string;
  /** 경로와 쿼리. ★ 인코딩을 풀지 않은 원문(req.url) */
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** 가짜 서버의 응답 한 건이다. */
export interface FakeReply {
  status: number;
  /** 있으면 JSON.stringify해 application/json으로 보낸다 */
  json?: unknown;
  /** json 대신 보낼 원문. contentType을 함께 준다 */
  raw?: string;
  contentType?: string;
  /** 추가 응답 헤더(예: location) */
  headers?: Record<string, string>;
  /** 응답 헤더를 보내기 전에 기다리는 시간(ms) */
  delayMs?: number;
  /** 헤더와 본문 앞 1바이트를 보낸 뒤 나머지를 보내기 전에 기다리는 시간(ms) */
  stallBodyMs?: number;
  /** true면 헤더와 본문 앞 1바이트만 보내고 연결을 끊는다(본문 읽기 중 연결 끊김) */
  dropBody?: boolean;
}

/** 요청을 받아 응답을 정한다. */
export type FakeHandler = (req: RecordedRequest) => FakeReply;

/** 실행 중인 가짜 RAG Server다. */
export interface FakeRagServer {
  /** http://127.0.0.1:<포트> (끝 '/' 없음) */
  readonly baseUrl: string;
  /** 받은 요청. 도착 순서 */
  readonly requests: RecordedRequest[];
  /** 응답 규칙을 바꾼다 */
  setHandler(handler: FakeHandler): void;
  /** 받은 요청을 비우고, 대기 중인 타이머를 지우고, 응답 규칙을 기본(404 JSON 오류)으로 되돌린다 */
  reset(): void;
  /** 대기 중인 타이머를 모두 지우고 연결을 끊은 뒤 닫는다 */
  close(): Promise<void>;
}

/** 기본 응답이다. 규칙이 없는 요청은 404로 답한다. */
const DEFAULT_HANDLER: FakeHandler = () => ({
  status: 404,
  json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '가짜 서버에 규칙이 없습니다' } },
});

/** 127.0.0.1의 빈 포트에 가짜 RAG Server를 띄운다. */
export async function startFakeRagServer(): Promise<FakeRagServer> {
  const requests: RecordedRequest[] = [];
  let handler: FakeHandler = DEFAULT_HANDLER;
  // ★ 만든 타이머를 모두 모아 close()가 지운다. 남기면 Jest가 열린 핸들로 멈춘다
  const timers = new Set<NodeJS.Timeout>();

  /** 타이머를 만들고 기록한다. */
  const later = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  /** 응답을 보낸다. */
  const send = (res: http.ServerResponse, reply: FakeReply): void => {
    const payload = reply.raw ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const contentType =
      reply.contentType ?? (reply.json === undefined ? undefined : 'application/json');
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };
    if (contentType !== undefined) headers['content-type'] = contentType;
    // ★ 바이트 단위로 자른다. 문자 단위로 자르면 비ASCII 본문에서 바이트 경계와 어긋난다
    const bytes = Buffer.from(payload, 'utf8');
    const emit = (): void => {
      if (res.destroyed) return;
      if (reply.dropBody === true && bytes.length > 1) {
        // 길이를 실제보다 크게 알린 뒤 일부만 보내고 끊어 본문 읽기를 실패시킨다
        res.writeHead(reply.status, { ...headers, 'content-length': String(bytes.length + 100) });
        res.write(bytes.subarray(0, 1));
        later(20, () => res.destroy());
        return;
      }
      if (reply.stallBodyMs !== undefined && bytes.length > 0) {
        res.writeHead(reply.status, headers);
        res.write(bytes.subarray(0, 1));
        later(reply.stallBodyMs, () => {
          if (!res.destroyed) res.end(bytes.subarray(1));
        });
        return;
      }
      res.writeHead(reply.status, headers);
      res.end(bytes);
    };
    if (reply.delayMs !== undefined) later(reply.delayMs, emit);
    else emit();
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      send(res, handler(recorded));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (next) => {
      handler = next;
    },
    reset: () => {
      // ★ 이전 테스트의 지연 응답 타이머가 다음 테스트로 넘어가지 않게 지운다
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      requests.length = 0;
      handler = DEFAULT_HANDLER;
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 지금 아무도 듣지 않는 포트 번호를 얻는다(포트 0으로 열었다 바로 닫는다). */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 기록된 multipart 요청 본문을 FormData로 읽는다. */
export function readMultipart(req: RecordedRequest): Promise<FormData> {
  return new Response(new Uint8Array(req.body), {
    headers: { 'content-type': String(req.headers['content-type']) },
  }).formData();
}
