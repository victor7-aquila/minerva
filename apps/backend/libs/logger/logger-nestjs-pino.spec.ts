import { Writable } from 'node:stream';
import { Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { createLoggerParams } from './helpers/logger-options';

// ★ nestjs-pino는 루트 로거를 모듈 레지스트리당 하나만 만든다. 다른 spec의 LoggerModule과 섞이지 않게 파일을 분리했다

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

describe('REQ-BE-8.2.1', () => {
  describe('T-LOG-11 LoggerModule.forRoot(createLoggerParams(stream)) 경로 [C]', () => {
    @Controller('probe2')
    class AssignController {
      constructor(private readonly logger: PinoLogger) {}

      @Post()
      handle() {
        this.logger.assign({ meta: { title: 'ASSIGN-SECRET' }, docId: 'doc-1' });
        this.logger.info({ chars: 4 }, 'probe.assign');
        this.logger.setContext('ProbeContext');
        this.logger.info('probe.context');
        this.logger.logger
          .child({ meta: { token: 'CHILD-SECRET' }, keep: 'k1' })
          .child({ deep: [{ text: 'CHILD2-SECRET' }] })
          .info('probe.child');
        return { ok: true };
      }
    }

    let app: Awaited<ReturnType<typeof createApp>> | undefined;

    /** assign·child 값을 쓰는 컨트롤러가 붙은 앱을 만든다. */
    async function createApp(stream: Writable) {
      const moduleRef = await Test.createTestingModule({
        imports: [LoggerModule.forRoot(createLoggerParams(stream))],
        controllers: [AssignController],
      }).compile();
      const nest = moduleRef.createNestApplication();
      await nest.init();
      return nest;
    }

    afterEach(async () => {
      await app?.close();
    });

    it('PinoLogger.assign·setContext·child 값의 금지 키가 출력에 없다', async () => {
      const { stream, lines } = captureStream();
      app = await createApp(stream);

      await request(app.getHttpServer()).post('/probe2').expect(201);

      // ★ 요청 종료 로그까지 쓰일 때까지 기다린다
      const deadline = Date.now() + 1000;
      const done = () => lines.some((l) => JSON.parse(l).res !== undefined);
      while (!done() && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const joined = lines.join('\n');
      expect(joined).not.toContain('ASSIGN-SECRET');
      expect(joined).not.toContain('CHILD-SECRET');
      expect(joined).not.toContain('CHILD2-SECRET');

      const parsed = lines.map((l) => JSON.parse(l));
      const assigned = parsed.find((o) => o.msg === 'probe.assign');
      expect(assigned.meta.title).toBe('[removed]');
      expect(assigned.docId).toBe('doc-1');
      expect(assigned.chars).toBe(4);

      const context = parsed.find((o) => o.msg === 'probe.context');
      expect(context.context).toBe('ProbeContext');

      const child = parsed.find((o) => o.msg === 'probe.child');
      expect(child.meta.token).toBe('[removed]');
      expect(child.deep[0].text).toBe('[removed]');
      expect(child.keep).toBe('k1');
    });
  });
});
