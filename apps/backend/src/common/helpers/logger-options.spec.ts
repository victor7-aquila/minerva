import { IncomingMessage } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { Body, Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import pino, { stdSerializers } from 'pino';
import request from 'supertest';
import { createLoggerParams, createPinoHttpOptions, scrubForbiddenKeys } from './logger-options';
import { REDACTED_LOG_PATHS } from '../interfaces/log-constants';

/** 금지 키 11개다. 구현에서 가져오지 않고 명세 값을 고정한다. */
const FORBIDDEN_KEYS = [
  'markdown',
  'text',
  'query',
  'answerSpan',
  'answer_span',
  'tableMarkdown',
  'hint',
  'summary',
  'caption',
  'title',
  'token',
];

/** 로그 줄을 모으는 출력이다. */
function captureStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      cb();
    },
  });
  return { stream, lines };
}

/** 캡처 출력으로 쓰는 pino 로거를 만든다. */
function makeLogger() {
  const { stream, lines } = captureStream();
  const logger = pino(createPinoHttpOptions(), stream);
  return { logger, lines };
}

describe('REQ-BE-8.2.1', () => {
  describe('T-LOG-1 금지 키를 모든 깊이에서 지운다 [C]', () => {
    it.each(FORBIDDEN_KEYS)('금지 키 %s를 지우고 허용 필드는 남긴다', (k) => {
      const { logger, lines } = makeLogger();
      logger.info(
        {
          [k]: 'SECRET-0',
          docId: 'doc-1',
          chars: 120,
          nested: { [k]: 'SECRET-1', chunkId: 'c-1' },
          deep: { inner: { [k]: 'SECRET-2' } },
          items: [{ [k]: 'SECRET-3' }],
          d3: { a: { b: { [k]: 'SECRET-4' } } },
          d6: { a: { b: { c: { d: { e: { [k]: 'SECRET-5' } } } } } },
          grid: [[{ [k]: 'SECRET-6' }]],
          list: [{ rows: [{ cell: { [k]: 'SECRET-7' } }] }],
        },
        'common.test',
      );

      expect(lines).toHaveLength(1);
      const raw = lines[0];
      for (let i = 0; i <= 7; i++) {
        expect(raw).not.toContain(`SECRET-${i}`);
      }
      const out = JSON.parse(raw);
      expect(out[k]).toBe('[removed]');
      expect(out.nested[k]).toBe('[removed]');
      expect(out.deep.inner[k]).toBe('[removed]');
      expect(out.items[0][k]).toBe('[removed]');
      expect(out.d3.a.b[k]).toBe('[removed]');
      expect(out.d6.a.b.c.d.e[k]).toBe('[removed]');
      expect(out.grid[0][0][k]).toBe('[removed]');
      expect(out.list[0].rows[0].cell[k]).toBe('[removed]');
      expect(out.docId).toBe('doc-1');
      expect(out.chars).toBe(120);
      expect(out.nested.chunkId).toBe('c-1');
      expect(out.msg).toBe('common.test');
      expect(out.level).toBeDefined();
    });

    it('금지 키와 이름만 비슷한 필드는 지우지 않는다', () => {
      const { logger, lines } = makeLogger();
      logger.info(
        { textLength: 5, queryChars: 7, docTitleId: 'x', nested: { summaryCount: 2 } },
        'common.test',
      );

      const out = JSON.parse(lines[0]);
      expect(out.textLength).toBe(5);
      expect(out.queryChars).toBe(7);
      expect(out.docTitleId).toBe('x');
      expect(out.nested.summaryCount).toBe(2);
    });

    it('금지 키의 값이 객체여도 통째로 지운다', () => {
      const { logger, lines } = makeLogger();
      logger.info({ summary: { text: 'S-OBJ', n: 1 } }, 'common.test');

      expect(lines[0]).not.toContain('S-OBJ');
      expect(JSON.parse(lines[0]).summary).toBe('[removed]');
    });
  });

  describe('T-LOG-2 요청 본문과 토큰 헤더를 지운다', () => {
    it('req.body와 x-minerva-token 헤더를 지우고 나머지는 남긴다', () => {
      const { logger, lines } = makeLogger();
      logger.info(
        {
          req: {
            method: 'POST',
            url: '/v1/search',
            body: { query: 'BODY-SECRET' },
            headers: { 'x-minerva-token': 'HEADER-SECRET', 'content-type': 'application/json' },
          },
        },
        'common.test',
      );

      expect(lines[0]).not.toContain('BODY-SECRET');
      expect(lines[0]).not.toContain('HEADER-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.req.body).toBe('[removed]');
      expect(out.req.headers['x-minerva-token']).toBe('[removed]');
      expect(out.req.method).toBe('POST');
      expect(out.req.headers['content-type']).toBe('application/json');
    });
  });

  describe('T-LOG-11 요청(req) 직렬화는 url·referer의 쿼리와 프래그먼트를 뗀다', () => {
    /** IncomingMessage가 아닌 클래스 인스턴스다. ★ 자기 속성을 복사하는 경로를 탄다 */
    class FakeIncomingMessage {
      method = 'GET';
      url: string | undefined;
      headers: Record<string, unknown> | undefined;
      constructor(url: string | undefined, headers: Record<string, unknown> | undefined) {
        this.url = url;
        this.headers = headers;
      }
    }

    /** 진짜 IncomingMessage를 만든다. ★ 속성이 프로토타입에 있어 표준 직렬화 경로를 탄다 */
    function incoming(
      url: string | undefined,
      headers: Record<string, unknown> | undefined,
    ): IncomingMessage {
      const req = new IncomingMessage(new Socket());
      req.method = 'GET';
      req.url = url;
      if (headers !== undefined) req.headers = headers as IncomingHttpHeaders;
      return req;
    }

    /** req 필드로 한 줄을 남기고 파싱한 req를 돌려준다. */
    function logReq(req: unknown): { out: Record<string, any>; line: string } {
      const { logger, lines } = makeLogger();
      logger.info({ req }, 'common.test');
      return { out: JSON.parse(lines[0]).req, line: lines[0] };
    }

    it('클래스 인스턴스 req의 url에서 ?쿼리와 #프래그먼트를 떼고 나머지는 남긴다', () => {
      const withQuery = logReq(incoming('/v1/search?q=QSECRET&x=1', { host: 'h', accept: 'a' }));
      expect(withQuery.out.url).toBe('/v1/search');
      expect(withQuery.out.method).toBe('GET');
      expect(withQuery.out.headers.host).toBe('h');
      expect(withQuery.line).not.toContain('QSECRET');
      const withFragment = logReq(incoming('/v1/a#FSECRET', {}));
      expect(withFragment.out.url).toBe('/v1/a');
      expect(withFragment.line).not.toContain('FSECRET');
      // IncomingMessage가 아닌 클래스 인스턴스도 같은 규칙이다
      const fake = logReq(new FakeIncomingMessage('/v1/search?q=QSECRET&x=1', { host: 'h' }));
      expect(fake.out.url).toBe('/v1/search');
      expect(fake.out.method).toBe('GET');
      expect(fake.out.headers.host).toBe('h');
      expect(fake.line).not.toContain('QSECRET');
    });

    it.each(['referer', 'referrer'])('headers.%s의 쿼리와 프래그먼트를 뗀다', (name) => {
      const { out, line } = logReq(
        incoming('/v1/a', {
          [name]: 'https://example.test/page?token=RSECRET#FSECRET',
          host: 'h',
        }),
      );
      expect(out.headers[name]).toBe('https://example.test/page');
      expect(out.headers.host).toBe('h');
      expect(line).not.toContain('RSECRET');
      expect(line).not.toContain('FSECRET');
    });

    it('평범한 객체 req도 같은 규칙을 적용하고 원본은 바꾸지 않으며 redact는 유지된다', () => {
      const headers = {
        referer: 'https://example.test/p?k=RSECRET',
        'x-minerva-token': 'HEADER-SECRET',
        'content-type': 'application/json',
      };
      const req = { method: 'POST', url: '/v1/s?q=QSECRET#F', headers, body: { a: 'BODY-SECRET' } };
      const { out, line } = logReq(req);
      expect(out.url).toBe('/v1/s');
      expect(out.headers.referer).toBe('https://example.test/p');
      expect(out.headers['content-type']).toBe('application/json');
      expect(out.headers['x-minerva-token']).toBe('[removed]');
      expect(out.body).toBe('[removed]');
      expect(line).not.toContain('QSECRET');
      expect(line).not.toContain('RSECRET');
      expect(line).not.toContain('HEADER-SECRET');
      expect(line).not.toContain('BODY-SECRET');
      // 원본 불변
      expect(req.url).toBe('/v1/s?q=QSECRET#F');
      expect(headers.referer).toBe('https://example.test/p?k=RSECRET');
      expect(headers['x-minerva-token']).toBe('HEADER-SECRET');
      expect(req.body).toEqual({ a: 'BODY-SECRET' });
    });

    it('url이나 headers가 없어도 던지지 않는다', () => {
      expect(() => logReq({ method: 'GET' })).not.toThrow();
      const noUrl = logReq({ method: 'GET', headers: { host: 'h' } });
      expect(noUrl.out.url).toBeUndefined();
      expect(noUrl.out.headers.host).toBe('h');
      const noHeaders = logReq({ method: 'GET', url: '/v1/a?q=1' });
      expect(noHeaders.out.url).toBe('/v1/a');
      expect(noHeaders.out.headers).toBeUndefined();
      const classNoHeaders = logReq(new FakeIncomingMessage('/v1/a?q=1', undefined));
      expect(classNoHeaders.out.url).toBe('/v1/a');
      const realNoHeaders = logReq(incoming('/v1/a?q=1', undefined));
      expect(realNoHeaders.out.url).toBe('/v1/a');
    });

    it("'#'만 있거나 '#'로 시작하는 url은 빈 문자열이 된다", () => {
      expect(logReq({ method: 'GET', url: '#' }).out.url).toBe('');
      expect(logReq({ method: 'GET', url: '/v1/a#' }).out.url).toBe('/v1/a');
      expect(logReq({ method: 'GET', url: '?' }).out.url).toBe('');
    });
  });

  describe('T-PR3-LOG-1 요청(req) 직렬화는 remoteAddress·remotePort를 남기고 쿼리는 뗀다', () => {
    /** 원격 주소가 있는 진짜 IncomingMessage를 만든다. */
    function incomingWithRemote(): IncomingMessage {
      const socket = new Socket();
      // ★ 연결되지 않은 소켓이라 원격 주소를 자기 속성으로 정의한다
      Object.defineProperty(socket, 'remoteAddress', { value: '10.1.2.3' });
      Object.defineProperty(socket, 'remotePort', { value: 54321 });
      const req = new IncomingMessage(socket);
      req.method = 'GET';
      req.url = '/v1/a?q=QSECRET';
      req.headers = { host: 'h' };
      return req;
    }

    it('이미 직렬화된 req도 remoteAddress·remotePort를 남기고 url의 쿼리를 뗀다', () => {
      // ★ pino-http가 넘기는 모양이다: 표준 serializer를 한 번 거친 객체(IncomingMessage가 아니다)
      const serialized = stdSerializers.req(incomingWithRemote());
      expect(serialized).not.toBeInstanceOf(IncomingMessage);
      const { logger, lines } = makeLogger();
      logger.info({ req: serialized }, 'common.test');
      const out = JSON.parse(lines[0]).req;
      expect(out.remoteAddress).toBe('10.1.2.3');
      expect(out.remotePort).toBe(54321);
      expect(out.url).toBe('/v1/a');
      expect(lines[0]).not.toContain('QSECRET');
    });

    it('IncomingMessage도 한 번만 직렬화해 remoteAddress·remotePort를 남기고 쿼리를 뗀다', () => {
      const { logger, lines } = makeLogger();
      logger.info({ req: incomingWithRemote() }, 'common.test');
      const out = JSON.parse(lines[0]).req;
      expect(out.remoteAddress).toBe('10.1.2.3');
      expect(out.remotePort).toBe(54321);
      expect(out.url).toBe('/v1/a');
      expect(out.headers.host).toBe('h');
      expect(lines[0]).not.toContain('QSECRET');
    });
  });

  describe('T-LOG-3 HTTP 요청 로그 (nestjs-pino + pino-http 통합)', () => {
    @Controller('probe')
    class ProbeController {
      constructor(private readonly logger: PinoLogger) {}

      @Post()
      handle(@Body() _body: unknown) {
        this.logger.info(
          { docId: 'doc-1', payload: { rows: [{ text: 'CTX-SECRET' }] } },
          'probe.handled',
        );
        return { ok: true };
      }
    }

    let app: Awaited<ReturnType<typeof createApp>>['app'];

    /** 테스트용 컨트롤러가 붙은 앱을 만든다. */
    async function createApp(stream: Writable) {
      const moduleRef = await Test.createTestingModule({
        imports: [LoggerModule.forRoot(createLoggerParams(stream))],
        controllers: [ProbeController],
      }).compile();
      const nest = moduleRef.createNestApplication();
      await nest.init();
      return { app: nest };
    }

    afterEach(async () => {
      await app?.close();
    });

    it('본문·토큰 헤더가 로그에 나가지 않고 req·res 직렬화가 유지된다', async () => {
      const { stream, lines } = captureStream();
      ({ app } = await createApp(stream));

      await request(app.getHttpServer())
        .post('/probe')
        .set('x-minerva-token', 'HEADER-SECRET')
        .send({ markdown: 'BODY-SECRET', text: 'BODY-SECRET-2' })
        .expect(201);

      // ★ pino-http는 응답이 끝난 뒤 로그를 쓰므로 조건이 맞을 때까지 기다린다
      const deadline = Date.now() + 1000;
      const hasReqLine = () =>
        lines.some((l) => {
          const o = JSON.parse(l);
          return o.req !== undefined && o.res !== undefined;
        });
      while (!hasReqLine() && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const joined = lines.join('\n');
      expect(joined).not.toContain('HEADER-SECRET');
      expect(joined).not.toContain('BODY-SECRET');
      expect(joined).not.toContain('CTX-SECRET');

      const parsed = lines.map((l) => JSON.parse(l));
      const requestLog = parsed.find((o) => o.req !== undefined && o.res !== undefined);
      expect(requestLog).toBeDefined();
      expect(requestLog.req.headers['x-minerva-token']).toBe('[removed]');
      expect(requestLog.req.method).toBe('POST');
      // ★ pino-http가 이미 직렬화한 req를 다시 직렬화하면 socket이 없어 remoteAddress가 빠진다
      expect(requestLog.req.remoteAddress).toMatch(/127\.0\.0\.1|::1/);
      expect(typeof requestLog.req.remotePort).toBe('number');
      expect(requestLog.res.statusCode).toBe(201);

      const ctxLog = parsed.find((o) => o.msg === 'probe.handled');
      expect(ctxLog).toBeDefined();
      expect(ctxLog.docId).toBe('doc-1');
      expect(ctxLog.req.headers['x-minerva-token']).toBe('[removed]');
    });
  });

  describe('T-LOG-4 경로 목록 형태 [C]', () => {
    it('요청 본문과 토큰 헤더 경로를 담고 중복이 없으며 얼려 있다', () => {
      expect(REDACTED_LOG_PATHS).toContain('req.body');
      expect(REDACTED_LOG_PATHS).toContain('req.headers["x-minerva-token"]');
      expect(new Set(REDACTED_LOG_PATHS).size).toBe(REDACTED_LOG_PATHS.length);
      expect(Object.isFrozen(REDACTED_LOG_PATHS)).toBe(true);
    });

    it('pino-http 옵션이 같은 경로와 censor를 쓰고 formatters를 둔다', () => {
      const options = createPinoHttpOptions();
      const redact = options.redact as { paths: string[]; censor: string };
      expect(redact.paths).toEqual([...REDACTED_LOG_PATHS]);
      expect(redact.censor).toBe('[removed]');
      expect(typeof options.formatters?.log).toBe('function');
      expect(typeof options.formatters?.bindings).toBe('function');
    });
  });

  describe('T-LOG-5 순환 참조에 안전하다 [C]', () => {
    it('순환 참조를 [Circular]로 끊고 금지 키를 지운다', () => {
      const { logger, lines } = makeLogger();
      const c: any = { docId: 'doc-1', inner: { text: 'CYC-SECRET' } };
      c.self = c;
      c.inner.parent = c;
      const arr: any[] = [{ token: 'ARR-CYC' }];
      arr.push(arr);
      c.arr = arr;

      expect(() => logger.info(c, 'common.test')).not.toThrow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('CYC-SECRET');
      expect(lines[0]).not.toContain('ARR-CYC');
      const out = JSON.parse(lines[0]);
      expect(out.self).toBe('[Circular]');
      expect(out.inner.parent).toBe('[Circular]');
      expect(out.arr[1]).toBe('[Circular]');
      expect(out.docId).toBe('doc-1');
    });

    it('순환이 아닌 공유 참조는 [Circular]가 아니다', () => {
      const { logger, lines } = makeLogger();
      const shared = { n: 1 };
      logger.info({ a: shared, b: shared }, 'common.test');

      const out = JSON.parse(lines[0]);
      expect(out.a.n).toBe(1);
      expect(out.b.n).toBe(1);
    });
  });

  describe('T-LOG-6 scrubForbiddenKeys 직접 검사 [C]', () => {
    it('원본을 바꾸지 않고 복사본을 돌려준다', () => {
      const input = { text: 'X', nested: { token: 'Y' } };
      const out = scrubForbiddenKeys(input) as typeof input;

      expect(input.text).toBe('X');
      expect(input.nested.token).toBe('Y');
      expect(out.text).toBe('[removed]');
      expect(out.nested.token).toBe('[removed]');
      expect(out).not.toBe(input);
    });

    it('클래스 인스턴스는 같은 참조로 넘긴다', () => {
      class Probe {
        text = 'P';
      }
      const err = new Error('e');
      const at = new Date(0);
      const buf = Buffer.from('a');
      const probe = new Probe();

      const out = scrubForbiddenKeys({ err, at, buf, probe }) as Record<string, unknown>;
      expect(out.err).toBe(err);
      expect(out.at).toBe(at);
      expect(out.buf).toBe(buf);
      expect(out.probe).toBe(probe);
    });

    it('원시 값·null·undefined는 그대로 둔다', () => {
      const out = scrubForbiddenKeys({ a: null, b: undefined, c: 0, d: false, e: 's' });
      expect(out).toEqual({ a: null, b: undefined, c: 0, d: false, e: 's' });
    });

    it('프로토타입이 null인 객체도 훑는다', () => {
      const o = Object.create(null);
      o.text = 'NP';
      const out = scrubForbiddenKeys({ o }) as { o: { text: string } };
      expect(out.o.text).toBe('[removed]');
    });
  });

  describe('T-LOG-7 자식 로거 바인딩의 금지 키도 지운다 [C]', () => {
    it('child 바인딩 안의 금지 키를 지운다', () => {
      const { logger, lines } = makeLogger();
      logger
        .child({ docId: 'doc-1', meta: { a: { title: 'BIND-SECRET' } } })
        .info({ chars: 3 }, 'common.test');

      expect(lines[0]).not.toContain('BIND-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.meta.a.title).toBe('[removed]');
      expect(out.docId).toBe('doc-1');
      expect(out.chars).toBe(3);
    });
  });

  describe('T-LOG-8 클래스 인스턴스 안의 금지 키도 출력에서 지운다 [C]', () => {
    it('인스턴스 필드의 금지 키를 [removed]로 만들고 비슷한 이름은 남긴다', () => {
      class Doc {
        markdown = 'INST-SECRET-1';
        title = 'INST-SECRET-2';
        textLength = 9;
        inner = { query: 'INST-SECRET-3' };
      }
      const { logger, lines } = makeLogger();
      logger.info({ doc: new Doc(), docId: 'doc-1' }, 'common.test');

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('INST-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.doc.markdown).toBe('[removed]');
      expect(out.doc.title).toBe('[removed]');
      expect(out.doc.inner.query).toBe('[removed]');
      expect(out.doc.textLength).toBe(9);
      expect(out.docId).toBe('doc-1');
    });

    it('배열 안의 클래스 인스턴스도 지운다', () => {
      class Row {
        text = 'ROW-SECRET';
        n = 1;
      }
      const { logger, lines } = makeLogger();
      logger.info({ rows: [new Row()] }, 'common.test');

      expect(lines[0]).not.toContain('ROW-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.rows[0].text).toBe('[removed]');
      expect(out.rows[0].n).toBe(1);
    });
  });

  describe('T-LOG-9 logger.unparseable 대체 경로 [C]', () => {
    const streamWrite = createPinoHttpOptions().hooks?.streamWrite as (line: string) => string;

    it.each(['{"text":"RAW-SECRET"', 'not json RAW-SECRET', '{"text":"RAW-SECRET"}}'])(
      '파싱할 수 없는 줄 %s은 원문 없이 고정 줄로 바뀐다',
      (input) => {
        const out = streamWrite(`${input}\n`);

        expect(out).not.toContain('RAW-SECRET');
        expect(out.endsWith('\n')).toBe(true);
        const parsed = JSON.parse(out);
        expect(parsed.msg).toBe('logger.unparseable');
        expect(parsed.level).toBe(50);
      },
    );

    it('파싱할 수 있는 줄은 금지 키를 지운 JSON 한 줄로 낸다', () => {
      const out = streamWrite('{"level":30,"text":"OK-SECRET","docId":"d"}\n');

      expect(out).not.toContain('OK-SECRET');
      expect(out.endsWith('\n')).toBe(true);
      expect(JSON.parse(out)).toEqual({ level: 30, text: '[removed]', docId: 'd' });
    });
  });

  describe('T-LOG-10 중첩 child·순환 참조·배열 안 객체 [C]', () => {
    it('child의 child 바인딩에서 금지 키를 지우고 pino 고유 필드는 남긴다', () => {
      const { logger, lines } = makeLogger();
      logger
        .child({ a: { token: 'CH1-SECRET' }, docId: 'doc-1' })
        .child({ b: [{ summary: 'CH2-SECRET' }] })
        .info({ chars: 3 }, 'common.test');

      expect(lines[0]).not.toContain('CH1-SECRET');
      expect(lines[0]).not.toContain('CH2-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.a.token).toBe('[removed]');
      expect(out.b[0].summary).toBe('[removed]');
      expect(out.docId).toBe('doc-1');
      expect(out.chars).toBe(3);
      expect(out.msg).toBe('common.test');
      expect(out.level).toBe(30);
      expect(typeof out.time).toBe('number');
    });

    it('child 바인딩의 순환 참조도 안전하게 처리한다', () => {
      const { logger, lines } = makeLogger();
      const ctx: any = { caption: 'CYC-CH-SECRET', docId: 'doc-1' };
      ctx.self = ctx;

      expect(() => logger.child({ ctx }).info('common.test')).not.toThrow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('CYC-CH-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.ctx.caption).toBe('[removed]');
      expect(out.ctx.self).toBe('[Circular]');
    });

    it('순환 참조 안 클래스 인스턴스와 배열 안 객체의 금지 키를 지운다', () => {
      class Node {
        text = 'NODE-SECRET';
        peer: unknown;
      }
      const node = new Node();
      node.peer = { hint: 'PEER-SECRET', list: [{ query: 'LIST-SECRET' }] };
      const { logger, lines } = makeLogger();

      expect(() => logger.info({ node }, 'common.test')).not.toThrow();
      expect(lines[0]).not.toContain('NODE-SECRET');
      expect(lines[0]).not.toContain('PEER-SECRET');
      expect(lines[0]).not.toContain('LIST-SECRET');
      const out = JSON.parse(lines[0]);
      expect(out.node.peer.hint).toBe('[removed]');
      expect(out.node.peer.list[0].query).toBe('[removed]');
    });
  });
});
