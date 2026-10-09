import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { bootAppHarness, runScheduledIndex } from './support/app-harness';
import type { AppHarness } from './support/app-harness';
import { startFakeRagServer } from './support/fake-rag-server';
import type { FakeRagServer, FakeReply, RecordedRequest } from './support/fake-rag-server';
import { createLogCapture } from './support/log-capture';
import {
  assertMongoReachable,
  createTestDbName,
  dropTestDb,
  testMongoUri,
} from './support/mongo-test-db';

jest.setTimeout(60_000);

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다. 앱을 두 번 띄워도 같은 stream을 쓴다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

let fake: FakeRagServer;
let tmpDir: string;
let dbName: string;
/** 지금 떠 있는 앱이다. 재시작 테스트가 갈아 끼운다 */
let harness: AppHarness | undefined;

/** 기본 가짜 RAG 라우터다. 표·이미지 요약과 색인 요청만 받는다. */
function router(req: RecordedRequest): FakeReply {
  const p = new URL(req.url, 'http://fake').pathname;
  if (req.method === 'POST' && p === '/v1/index-jobs') {
    const body = JSON.parse(req.body.toString('utf8')) as { doc_id: string; version: string };
    return {
      status: 202,
      json: {
        outcome: 'queued',
        job_id: `job-${body.doc_id}-${body.version}`,
        doc_id: body.doc_id,
        version: body.version,
      },
    };
  }
  if (req.method === 'POST' && p === '/v1/documents/index-states') {
    return { status: 200, json: { items: [] } };
  }
  return { status: 404, json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '규칙 없음' } } };
}

/** 같은 DB·같은 임시 폴더·같은 로그 stream으로 앱을 띄운다. */
function bootApp(): Promise<AppHarness> {
  return bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
    },
    stream: capture.stream,
  });
}

/** 조건이 참이 될 때까지 50ms 간격으로 확인한다. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('조건이 시간 안에 참이 되지 않았습니다');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** 그 문서로 간 색인 요청 수를 센다. */
function indexRequestCount(docId: string): number {
  return fake.requests.filter(
    (r) =>
      r.method === 'POST' &&
      r.url === '/v1/index-jobs' &&
      (JSON.parse(r.body.toString('utf8')) as { doc_id: string }).doc_id === docId,
  ).length;
}

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-schedule-e2e-'));
  dbName = createTestDbName();
});

beforeEach(() => {
  capture.clear();
  fake.reset();
  fake.setHandler(router);
});

afterEach(async () => {
  // ★ 테스트가 끝나면 앱을 닫는다(이미 닫은 앱은 harness를 비워 두었다)
  await harness?.close();
  harness = undefined;
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  if (dbName !== undefined) await dropTestDb(dbName);
  if (tmpDir !== undefined) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('REQ-BE-1.10.8', () => {
  it('T-E2E-RESTART-1 앱을 다시 띄워도 대기열이 남고, 기동만으로는 색인 요청이 없으며, 예약 색인에서 요청된다', async () => {
    harness = await bootApp();
    const first = `http://127.0.0.1:${harness.port}`;
    const upload = await request(first)
      .post('/v1/documents')
      .attach('files', Buffer.from('# 제목\n\n본문', 'utf8'), 'a.md')
      .field('meta', JSON.stringify([{ file_name: 'a.md', name: 'restart-doc' }]));
    expect(upload.status).toBe(201);
    const docId = (upload.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
    await waitFor(async () => {
      const body = (await request(first).get(`/v1/documents/${docId}`)).body as {
        processing_state: string;
        in_index_queue: unknown;
      };
      return body.processing_state === 'queued' && body.in_index_queue === true;
    });
    // 업로드는 대기열에 넣기까지만 한다
    expect(indexRequestCount(docId)).toBe(0);

    // 앱을 닫고 같은 DB로 다시 띄운다
    await harness.close();
    harness = undefined;
    // ★ 첫 앱이 남긴 documents.resume 로그를 지운다. 같은 stream을 쓰므로 안 지우면 아래 대기가 즉시 참이 된다
    capture.clear();
    harness = await bootApp();
    const second = `http://127.0.0.1:${harness.port}`;

    const detail = (await request(second).get(`/v1/documents/${docId}`)).body as {
      processing_state: string;
      in_index_queue: boolean | null;
    };
    expect(detail.processing_state).toBe('queued');
    expect(detail.in_index_queue).toBe(true);

    // ★ 기동 처리는 색인을 요청하지 않는다. 기동 처리가 끝났다는 신호(documents.resume 로그)를 기다린다
    await waitFor(() => capture.parsed().some((line) => line.msg === 'documents.resume'));
    expect(capture.parsed().filter((line) => line.msg === 'documents.resume')).toHaveLength(1);
    expect(indexRequestCount(docId)).toBe(0);
    const row = await harness.db.collection('documents').findOne({ docId });
    expect(row?.queuedVersion).toBe('1');

    await runScheduledIndex(harness);
    await waitFor(() => indexRequestCount(docId) === 1);
    // ★ 가짜 RAG가 요청을 받은 시점은 Backend가 응답을 받아 대기열에서 빼기 전이다. 빠질 때까지 기다린다
    await waitFor(async () => {
      const body = (await request(second).get(`/v1/documents/${docId}`)).body as {
        in_index_queue: boolean | null;
      };
      return body.in_index_queue === false;
    });
    const after = await harness.db.collection('documents').findOne({ docId });
    expect(after?.queuedVersion).toBeNull();
  });
});

describe('REQ-BE-1.10.1', () => {
  it('T-E2E-SCH-1 기동하면 예약 색인 크론 작업이 시작돼 있고 앱을 닫으면 멈춘다', async () => {
    harness = await bootApp();
    const registry = harness.app.get(SchedulerRegistry);
    // 이름은 documents 서비스의 INDEX_SCHEDULE_JOB_NAME과 같다(내부 파일이라 리터럴로 쓴다)
    const job = registry.getCronJob('documents.scheduled_index');
    expect(job.isActive).toBe(true);
    // ★ 일정 사이에는 색인 요청이 가지 않는다
    expect(fake.requests.some((r) => r.url === '/v1/index-jobs')).toBe(false);

    await harness.close();
    harness = undefined;
    expect(job.isActive).toBe(false);
  });
});
