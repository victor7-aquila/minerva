import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { INDEX_JOB_STATE_CHANGED } from '../src/indexing';
import { IndexingCrudService } from '../src/indexing/services/indexing-crud.service';
import type { IndexJobStateChangedEvent } from '../src/indexing';
import { bootAppHarness } from './support/app-harness';
import type { AppHarness } from './support/app-harness';
import { startFakeRagServer } from './support/fake-rag-server';
import type { FakeRagServer } from './support/fake-rag-server';
import { createLogCapture } from './support/log-capture';
import {
  assertMongoReachable,
  createTestDbName,
  dropTestDb,
  testMongoUri,
} from './support/mongo-test-db';

jest.setTimeout(30_000);

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

/** test-env.ts 기본 알림 토큰이다. */
const TOKEN = 'e2e-rag-events-token';
/** 로그 비노출 검사용 센티널이다. */
const TOKEN_SENT = 'TOKEN-SENT-87';
const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
const UNAUTHORIZED_MESSAGE = '알림 토큰이 없거나 올바르지 않습니다';

let harness: AppHarness;
let fake: FakeRagServer;
let tmpDir: string;
let dbName: string;
let baseUrl: string;
const received: IndexJobStateChangedEvent[] = [];
/** 리스너 동작을 테스트마다 바꾼다. 기본은 아무것도 안 한다 */
let onEvent: (event: IndexJobStateChangedEvent) => unknown = () => undefined;

/** 앱의 이벤트 발행기에 기록용 리스너를 단다. */
function attachListener(app: AppHarness['app']): void {
  app.get(EventEmitter2).on(INDEX_JOB_STATE_CHANGED, (event: IndexJobStateChangedEvent) => {
    received.push(event);
    return onEvent(event);
  });
}

/** 앱을 띄운다. */
async function boot(): Promise<AppHarness> {
  return bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
    },
    stream: capture.stream,
  });
}

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-indexing-e2e-'));
  dbName = createTestDbName();
  harness = await boot();
  baseUrl = `http://127.0.0.1:${harness.port}`;
  attachListener(harness.app);
});

beforeEach(() => {
  capture.clear();
  fake.reset();
  received.length = 0;
  onEvent = () => undefined;
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  if (dbName !== undefined) await dropTestDb(dbName);
  if (tmpDir !== undefined) await fs.rm(tmpDir, { recursive: true, force: true });
});

/** IF-2 알림 본문(snake_case)을 만든다. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: 'e2e-doc',
    job_id: 'e2e-job',
    version: '3',
    job_state: 'running',
    index_state: {
      searchable_version: null,
      latest_job_id: 'e2e-job',
      latest_job_state: 'running',
      latest_job_stage: 'embedding',
    },
    sequence: 1,
    ...over,
  };
}

/** 알림을 보낸다. token이 undefined면 헤더를 넣지 않는다. */
function post(b: unknown, token?: string): request.Test {
  const req = request(baseUrl).post('/v1/internal/rag-events');
  if (token !== undefined) req.set('X-Minerva-Token', token);
  return req.send(b as object);
}

/** 문서의 순번 레코드를 읽는다. */
async function cursorOf(docId: string): Promise<Record<string, unknown> | null> {
  return (await harness.db.collection('rag_event_cursors').findOne({ docId })) as Record<
    string,
    unknown
  > | null;
}

/** 오류 본문이 키 `error` 하나이고 그 안이 code·message 둘뿐임을 단언한다. */
function expectErrorShape(res: request.Response, code: string, message?: string): void {
  const typed = res.body as { error: { code: string; message: string } };
  expect(Object.keys(typed)).toEqual(['error']);
  expect(Object.keys(typed.error).sort()).toEqual(['code', 'message']);
  expect(typed.error.code).toBe(code);
  expect(typed.error.message).toMatch(/[가-힣]/);
  if (message !== undefined) expect(typed.error.message).toBe(message);
}

/** pino-http가 요청 컨텍스트로 붙이는 필드다. 가드·서비스가 넘긴 payload가 아니므로 비교에서 뺀다. */
const HTTP_CONTEXT = ['req', 'res', 'responseTime'];

/** msg가 같은 로그 줄에서 pino 기본 필드와 pino-http 요청 컨텍스트를 뺀 payload를 모은다. */
function payloads(msg: string): Record<string, unknown>[] {
  return capture
    .parsed()
    .filter((line) => line.msg === msg)
    .map((line) =>
      Object.fromEntries(
        Object.entries(line).filter(
          ([key]) => !PINO_BASE.includes(key) && !HTTP_CONTEXT.includes(key),
        ),
      ),
    );
}

/** msg가 같은 로그 줄의 pino-http 요청 컨텍스트(req)를 모은다. */
function requestContexts(msg: string): Record<string, unknown>[] {
  return capture
    .parsed()
    .filter((line) => line.msg === msg)
    .map((line) => line.req as Record<string, unknown>);
}

/** 이 알림이 만드는 작업 조회 요청만 모은다. 다른 단계의 백그라운드 RAG 호출은 보지 않는다. */
function jobLookups(): typeof fake.requests {
  return fake.requests.filter((r) => r.url.startsWith('/v1/index-jobs/'));
}

describe('REQ-BE-3.2.5', () => {
  it('T-E2E-AUTH-1 토큰이 없으면 401이고 아무것도 반영하지 않는다', async () => {
    const res = await post(body({ doc_id: 'e2e-auth-1' }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: UNAUTHORIZED_MESSAGE } });
    expectErrorShape(res, 'UNAUTHORIZED', UNAUTHORIZED_MESSAGE);
    expect(received).toHaveLength(0);
    expect(await cursorOf('e2e-auth-1')).toBeNull();
    expect(jobLookups()).toHaveLength(0);
    expect(payloads('indexing.event_unauthorized')).toEqual([{ tokenPresent: false }]);
  });

  it('T-E2E-AUTH-2 틀린 토큰이면 401이고 조회·로그 노출이 없다', async () => {
    const res = await post(body({ doc_id: 'e2e-auth-2', job_state: 'succeeded' }), TOKEN_SENT);
    expect(res.status).toBe(401);
    expectErrorShape(res, 'UNAUTHORIZED', UNAUTHORIZED_MESSAGE);
    expect(received).toHaveLength(0);
    expect(await cursorOf('e2e-auth-2')).toBeNull();
    expect(jobLookups()).toHaveLength(0);
    expect(payloads('indexing.event_unauthorized')).toEqual([{ tokenPresent: true }]);
    // ★ pino-http의 req 안 토큰 헤더는 원문이 아니라 [removed]여야 한다
    const [req] = requestContexts('indexing.event_unauthorized');
    expect((req.headers as Record<string, unknown>)['x-minerva-token']).toBe('[removed]');
    const text = capture.lines.join('\n');
    expect(text).not.toContain(TOKEN_SENT);
    expect(text).not.toContain(TOKEN);
  });

  it('T-E2E-AUTH-3 토큰이 없으면 잘못된 본문도 400이 아니라 401이다', async () => {
    const res = await post({ foo: 1 });
    expect(res.status).toBe(401);
    expectErrorShape(res, 'UNAUTHORIZED');
  });

  it('T-E2E-AUTH-4 토큰의 앞부분이나 대소문자만 다른 값은 거부한다', async () => {
    for (const token of ['e2e-rag-events-toke', 'E2E-RAG-EVENTS-TOKEN']) {
      const res = await post(body({ doc_id: 'e2e-auth-4' }), token);
      expect(res.status).toBe(401);
    }
    expect(received).toHaveLength(0);
  });
});

describe('REQ-BE-3.2.1', () => {
  it('T-E2E-OK-1 올바른 토큰의 running 알림은 204이고 이벤트로 넘어간다', async () => {
    const res = await post(body({ doc_id: 'e2e-ok-1' }), TOKEN);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(received).toEqual([
      {
        docId: 'e2e-ok-1',
        version: '3',
        jobId: 'e2e-job',
        jobState: 'running',
        searchableVersion: null,
        result: null,
        failure: null,
        source: 'notification',
      },
    ]);
    expect((await cursorOf('e2e-ok-1'))?.lastSequence).toBe(1);
  });

  it('T-E2E-OK-2 오래된 순번과 같은 순번은 204이지만 이벤트가 없다', async () => {
    for (const sequence of [3, 2, 3]) {
      const res = await post(body({ doc_id: 'e2e-ok-2', sequence }), TOKEN);
      expect(res.status).toBe(204);
    }
    expect(received).toHaveLength(1);
    expect((await cursorOf('e2e-ok-2'))?.lastSequence).toBe(3);
  });

  it('T-E2E-OK-3 succeeded 알림은 작업을 조회해 결과를 싣는다', async () => {
    fake.setHandler((req) =>
      req.method === 'GET' && req.url === '/v1/index-jobs/e2e-job-s'
        ? {
            status: 200,
            json: {
              job_id: 'e2e-job-s',
              doc_id: 'e2e-ok-3',
              version: '3',
              state: 'succeeded',
              stage: null,
              failure: null,
              result: { chunk_count: 7, fallback_used: true },
            },
          }
        : { status: 404, json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '규칙 없음' } } },
    );
    const res = await post(
      body({
        doc_id: 'e2e-ok-3',
        job_id: 'e2e-job-s',
        job_state: 'succeeded',
        index_state: {
          searchable_version: '3',
          latest_job_id: 'e2e-job-s',
          latest_job_state: 'succeeded',
          latest_job_stage: null,
        },
      }),
      TOKEN,
    );
    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].result).toEqual({ chunkCount: 7, fallbackUsed: true });
    const jobCalls = fake.requests.filter(
      (r) => r.method === 'GET' && r.url === '/v1/index-jobs/e2e-job-s',
    );
    expect(jobCalls).toHaveLength(1);
  });

  it('T-E2E-OK-4 받는 쪽이 실패해도 204이고 순번은 올라간다', async () => {
    onEvent = () => {
      throw new Error('LISTENER-SECRET');
    };
    const res = await post(body({ doc_id: 'e2e-ok-4' }), TOKEN);
    expect(res.status).toBe(204);
    expect((await cursorOf('e2e-ok-4'))?.lastSequence).toBe(1);
    expect(payloads('indexing.event_dispatch_failed')).toHaveLength(1);
    expect(capture.lines.join('\n')).not.toContain('LISTENER-SECRET');
  });

  it('T-E2E-OK-5 실패 사유 조회가 503이면 대체 사유로 이벤트를 낸다', async () => {
    fake.setHandler(() => ({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: '불가' } },
    }));
    const res = await post(
      body({
        doc_id: 'e2e-ok-5',
        job_state: 'failed',
        index_state: {
          searchable_version: null,
          latest_job_id: 'e2e-job',
          latest_job_state: 'failed',
          latest_job_stage: null,
        },
      }),
      TOKEN,
    );
    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0].failure?.code).toBe('RAG_UNREACHABLE');
  });
});

describe('REQ-BE-3.2.4', () => {
  it('T-E2E-SEQ-1 같은 알림을 동시에 보내도 이벤트와 순번 문서는 하나다', async () => {
    const payload = body({ doc_id: 'e2e-seq-1', sequence: 4 });
    const results = await Promise.all([post(payload, TOKEN), post(payload, TOKEN)]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    expect(received).toHaveLength(1);
    const rows = await harness.db
      .collection('rag_event_cursors')
      .find({ docId: 'e2e-seq-1' })
      .toArray();
    expect(rows).toHaveLength(1);
  });

  it('T-E2E-SEQ-4 실제 MongoDB에서 순번 저장소의 경합이 하나로 정리된다', async () => {
    const repo = harness.app.get(IndexingCrudService);
    // ★ 같은 순번을 동시에: 실제 드라이버의 E11000(code 11000)과 matchedCount 재판정을 지난다
    const same = await Promise.all([repo.advance('e2e-race-a', 5), repo.advance('e2e-race-a', 5)]);
    expect(same.filter((r) => r)).toHaveLength(1);
    expect((await cursorOf('e2e-race-a'))?.lastSequence).toBe(5);
    // 다른 순번을 동시에: 인터리빙과 무관하게 큰 순번이 참이고 값은 줄지 않는다
    const mixed = await Promise.all([repo.advance('e2e-race-b', 4), repo.advance('e2e-race-b', 5)]);
    expect(mixed[1]).toBe(true);
    expect((await cursorOf('e2e-race-b'))?.lastSequence).toBe(5);
    const rows = await harness.db
      .collection('rag_event_cursors')
      .find({ docId: { $in: ['e2e-race-a', 'e2e-race-b'] } })
      .toArray();
    expect(rows).toHaveLength(2);
  });

  it('T-E2E-SEQ-3 저장된 순번을 기준으로 거른다', async () => {
    await harness.db
      .collection('rag_event_cursors')
      .insertOne({ docId: 'e2e-seeded', lastSequence: 7 });
    await post(body({ doc_id: 'e2e-seeded', sequence: 7 }), TOKEN);
    expect(received).toHaveLength(0);
    await post(body({ doc_id: 'e2e-seeded', sequence: 8 }), TOKEN);
    expect(received).toHaveLength(1);
  });

  it('T-E2E-IDX-1 기동할 때 docId 고유 인덱스를 만든다', async () => {
    const indexes = await harness.db.collection('rag_event_cursors').indexes();
    const found = indexes.find((index) => index.name === 'rag_event_cursors_doc_id');
    expect(found).toBeDefined();
    expect(found?.key).toEqual({ docId: 1 });
    expect(found?.unique).toBe(true);
  });
});

describe('REQ-BE-3.2.2', () => {
  it('T-E2E-VAL-1 본문이 계약과 다르면 400이고 아무것도 반영하지 않는다', async () => {
    const withoutSequence = body({ doc_id: 'e2e-val-a' });
    delete withoutSequence.sequence;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['e2e-val-a', withoutSequence],
      ['e2e-val-b', body({ doc_id: 'e2e-val-b', job_state: 'done' })],
      ['e2e-val-c', body({ doc_id: 'e2e-val-c', extra: 1 })],
      [
        'e2e-val-d',
        body({
          doc_id: 'e2e-val-d',
          index_state: {
            searchable_version: null,
            latest_job_id: 'e2e-job',
            latest_job_state: 'running',
            latest_job_stage: 'x',
          },
        }),
      ],
    ];
    for (const [docId, payload] of cases) {
      const res = await post(payload, TOKEN);
      expect(res.status).toBe(400);
      expectErrorShape(res, 'INVALID_REQUEST');
      expect(await cursorOf(docId)).toBeNull();
    }
    expect(received).toHaveLength(0);
  });
});

describe('REQ-BE-3.2.4', () => {
  // ★ 파일 마지막에 둔다 — 같은 파일에서 앱을 다시 띄운다
  it('T-E2E-SEQ-2 재기동 뒤에도 순번이 MongoDB에 남아 이어진다', async () => {
    const first = await post(body({ doc_id: 'e2e-restart', sequence: 3 }), TOKEN);
    expect(first.status).toBe(204);
    expect(received).toHaveLength(1);

    await harness.close();
    harness = await boot();
    baseUrl = `http://127.0.0.1:${harness.port}`;
    attachListener(harness.app);
    received.length = 0;

    const again = await post(body({ doc_id: 'e2e-restart', sequence: 3 }), TOKEN);
    expect(again.status).toBe(204);
    expect(received).toHaveLength(0);
    const next = await post(body({ doc_id: 'e2e-restart', sequence: 4 }), TOKEN);
    expect(next.status).toBe(204);
    expect(received).toHaveLength(1);
  });
});
