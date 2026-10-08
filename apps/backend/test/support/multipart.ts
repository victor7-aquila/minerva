import * as http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

/** multipart 파트 하나다. filename이 있으면 파일 파트다. */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  content: Buffer | string;
}

/** 파트 목록으로 multipart 본문을 만든다. ★ filename은 UTF-8 그대로 쓴다. end가 false면 닫는 경계를 넣지 않는다. */
export function buildMultipart(boundary: string, parts: MultipartPart[], end = true): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.filename !== undefined || part.contentType !== undefined) {
      head += `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n`;
    }
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  if (end) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/** 날 HTTP 요청 결과다. */
export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

/**
 * 127.0.0.1:port로 요청을 보낸다. body를 쓰고 endRequest가 false면 요청을 끝내지 않는다(멈춘 클라이언트).
 * 응답이 오면 소켓을 끊는다. 응답 뒤 쓰기 오류(EPIPE·ECONNRESET)는 무시한다. timeoutMs 안에 응답이 없으면 실패한다.
 */
export function rawRequest(
  port: number,
  opts: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
    endRequest: boolean;
    timeoutMs?: number;
  },
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    // ★ 타이머는 어떤 경로로 끝나도 반드시 지운다(Jest 열린 핸들 방지)
    const timer = setTimeout(() => {
      finish(new Error(`${opts.timeoutMs ?? 5000}ms 안에 응답이 오지 않았습니다`));
    }, opts.timeoutMs ?? 5000);

    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method,
      path: opts.path,
      headers: opts.headers,
      // ★ 연결을 재사용하지 않는다. 끊은 소켓이 다음 요청에 섞이지 않게 한다
      agent: false,
    });

    /** 결과를 한 번만 내보내고 정리한다. */
    function finish(result: Error | RawResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    req.on('error', (error) => {
      // 응답 이전의 오류만 실패로 본다. 응답 뒤 EPIPE·ECONNRESET은 무시한다
      if (!gotResponse) finish(error);
    });
    req.on('response', (res) => {
      gotResponse = true;
      const chunks: Buffer[] = [];
      /** 모은 본문으로 결과를 만든다. */
      const done = (): void => {
        const body = Buffer.concat(chunks).toString('utf8');
        finish({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json: () => JSON.parse(body) as unknown,
        });
      };
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', done);
      res.on('error', done);
      res.on('close', done);
    });

    if (opts.body !== undefined) req.write(opts.body);
    if (opts.endRequest) req.end();
    else req.flushHeaders();
  });
}
