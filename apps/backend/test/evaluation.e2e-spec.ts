import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { bootAppHarness } from './support/app-harness';
import type { AppHarness } from './support/app-harness';
import {
  docRecord,
  ed,
  expectSafeKoreanMessage,
  versionRecord,
} from './support/documents-fixtures';
import { DOC_A, DOC_B, INDEXING_MD, SPAN_SENT, waitUntil } from './support/evaluation-fixtures';
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

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

const DOC_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DOC_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let harness: AppHarness;
let fake: FakeRagServer;
let tmpDir: string;
let dbName: string;
let baseUrl: string;

/** 가짜 RAG의 지표 응답(snake_case)을 만든다. */
function wireMetrics(
  rank: number | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const hit = rank !== null;
  return {
    hit_at_1: rank === 1,
    hit_at_3: hit && rank <= 3,
    hit_at_5: hit && rank <= 5,
    hit_at_n: hit,
    rank,
    reciprocal_rank: hit ? 1 / rank : 0,
    coverage: hit ? 1 : 0,
    ...over,
  };
}

/** 질의로 응답을 고르는 가짜 RAG 라우터다. */
function router(req: RecordedRequest): FakeReply {
  if (req.method === 'POST' && req.url === '/v1/documents/index-states') {
    return { status: 200, json: { items: [] } };
  }
  if (req.method === 'POST' && req.url === '/v1/evaluations') {
    const query = (JSON.parse(req.body.toString('utf8')) as { query: string }).query;
    switch (query) {
      case 'Q-HIT1':
        return { status: 200, json: { n: 10, base: wireMetrics(null), expanded: wireMetrics(1) } };
      case 'Q-HIT3':
        return {
          status: 200,
          json: {
            n: 10,
            base: wireMetrics(3),
            expanded: wireMetrics(3, { coverage: 0.5 }),
          },
        };
      case 'Q-MISS':
        return {
          status: 200,
          json: { n: 10, base: wireMetrics(null), expanded: wireMetrics(null) },
        };
      case 'Q-ERR':
        return {
          status: 409,
          json: { error: { code: 'DOCUMENT_NOT_SEARCHABLE', message: 'x' } },
        };
      case 'Q-SLOW':
        return {
          status: 200,
          delayMs: 1500,
          json: { n: 10, base: wireMetrics(1), expanded: wireMetrics(1) },
        };
      default:
        return { status: 200, json: { n: 10, base: wireMetrics(1), expanded: wireMetrics(1) } };
    }
  }
  return { status: 404, json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '규칙 없음' } } };
}

/** 평가 중 기록이 없는지 본다. */
async function noneEvaluating(): Promise<boolean> {
  return (
    (await harness.db
      .collection('evaluation_records')
      .countDocuments({ outcome: 'evaluating' })) === 0
  );
}

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-evaluation-e2e-'));
  dbName = createTestDbName();
  harness = await bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
      RAG_TIMEOUT_MS: '3000',
      LOG_RETENTION_DAYS: '3650',
    },
    stream: capture.stream,
  });
  baseUrl = `http://127.0.0.1:${harness.port}`;
  const documents = harness.db.collection('documents');
  const versions = harness.db.collection('document_versions');
  await documents.insertOne({
    ...docRecord({ docId: DOC_A, name: 'E2E 문서', edition: ed('2025') }),
  });
  await versions.insertOne({
    ...versionRecord({ docId: DOC_A, version: '1', indexingMarkdown: INDEXING_MD }),
  });
  await documents.insertOne({ ...docRecord({ docId: DOC_B, name: 'E2E 판 없음', edition: null }) });
  await versions.insertOne({
    ...versionRecord({ docId: DOC_B, version: '1', indexingMarkdown: INDEXING_MD }),
  });
  await documents.insertOne({
    ...docRecord({
      docId: DOC_C,
      name: 'E2E 검색 불가',
      searchState: 'not_searchable',
      searchableVersion: null,
    }),
  });
  await documents.insertOne({ ...docRecord({ docId: DOC_D, name: 'E2E 삭제', deleted: true }) });
});

beforeEach(async () => {
  // ★ 앞 테스트의 평가가 끝나기 전에 비우거나 fake.reset()을 부르지 않는다
  await waitUntil(noneEvaluating, 15_000);
  await harness.db.collection('golden_sets').deleteMany({});
  await harness.db.collection('evaluation_records').deleteMany({});
  fake.reset();
  fake.setHandler(router);
  capture.clear();
});

afterAll(async () => {
  if (harness !== undefined) await waitUntil(noneEvaluating, 15_000);
  await harness?.close();
  await fake?.close();
  if (dbName !== undefined) await dropTestDb(dbName);
  if (tmpDir !== undefined) await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 골든셋 추가를 요청한다. */
function addGolden(body: unknown): request.Test {
  return request(baseUrl)
    .post('/v1/golden-sets')
    .send(body as object);
}

/** 정상 본문으로 골든셋을 추가한다. */
function addQuery(query: string, over: Record<string, unknown> = {}): request.Test {
  return addGolden({ query, doc_id: DOC_A, answer_span: SPAN_SENT, ...over });
}

/** 목록을 가져온다. */
function listGolden(queryString = ''): request.Test {
  return request(baseUrl).get(`/v1/golden-sets${queryString}`);
}

/** 목록 항목 하나의 모양이다. */
interface ListItem {
  golden_set_id: string;
  query: string;
  latest: {
    outcome: string;
    n: number | null;
    expanded: { rank: number | null } | null;
  };
}

/** 목록 응답 본문이다. */
interface ListBody {
  items: ListItem[];
  total: number;
  page: number;
  page_size: number;
}

/** 오류 응답의 모양과 코드를 확인한다. */
function expectError(res: request.Response, status: number, code: string): string {
  expect(res.status).toBe(status);
  const body = res.body as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  expect(body.error.code).toBe(code);
  return body.error.message;
}

/** 평가 요청으로 가짜 서버가 받은 것이다. */
function evaluationRequests(): RecordedRequest[] {
  return fake.requests.filter((r) => r.method === 'POST' && r.url === '/v1/evaluations');
}

/** 평가가 모두 끝날 때까지 기다린다. */
async function waitAllDone(): Promise<void> {
  await waitUntil(noneEvaluating, 15_000);
}

/** Q-SLOW 하나만 평가 중이 될 때까지 기다린다(나머지는 끝났다). */
async function waitOnlySlowEvaluating(): Promise<void> {
  await waitUntil(async () => {
    const body = (await listGolden()).body as ListBody;
    return (
      body.items.length === 5 &&
      body.items.filter((item) => item.latest.outcome === 'evaluating').length === 1
    );
  }, 15_000);
}

/** 다섯 질의를 모두 추가한다. */
async function addFive(): Promise<void> {
  for (const query of ['Q-HIT1', 'Q-HIT3', 'Q-MISS', 'Q-ERR', 'Q-SLOW']) {
    expect((await addQuery(query)).status).toBe(201);
  }
}

describe('REQ-BE-5.1.1', () => {
  it('T-E2E-ADD-1 추가하면 201과 평가 중 응답을 주고 평가를 시작해 결과를 채운다', async () => {
    const res = await addQuery('Q-HIT1');
    expect(res.status).toBe(201);
    const body = res.body as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual([
      'answer',
      'answer_span',
      'created_at',
      'edition_only',
      'golden_set_id',
      'latest',
      'query',
    ]);
    expect(body.latest.outcome).toBe('evaluating');
    expect(body.answer.name).toBe('E2E 문서');
    expect(body.answer.edition.label).toBe('2025');
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await waitUntil(() => evaluationRequests().length === 1);
    const sent = evaluationRequests()[0];
    const sentBody = JSON.parse(sent.body.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(sentBody).sort()).toEqual([
      'answer_span',
      'doc_id',
      'edition_only',
      'query',
    ]);
    expect(sentBody.edition_only).toBe(false);
    expect(sent.headers['x-minerva-token']).toBeDefined();
    await waitUntil(async () => {
      const list = (await listGolden()).body as ListBody;
      return list.items[0]?.latest.outcome === 'hit';
    });
  });

  it('T-E2E-ADD-2 없는 문서와 삭제된 문서는 404 DOCUMENT_NOT_FOUND다', async () => {
    for (const docId of [randomUUID(), DOC_D, 'not-a-uuid']) {
      const res = await addGolden({ query: 'Q-HIT1', doc_id: docId, answer_span: SPAN_SENT });
      expectError(res, 404, 'DOCUMENT_NOT_FOUND');
    }
    expect(((await listGolden()).body as ListBody).total).toBe(0);
  });

  it('T-E2E-ADD-3 판 정보가 없는 문서에 edition_only를 주면 400이다', async () => {
    const res = await addGolden({
      query: 'Q-HIT1',
      doc_id: DOC_B,
      answer_span: SPAN_SENT,
      edition_only: true,
    });
    expectSafeKoreanMessage(expectError(res, 400, 'INVALID_REQUEST'));
    expect(((await listGolden()).body as ListBody).total).toBe(0);
  });

  it('T-E2E-ADD-4 본문 형식이 틀리면 400 INVALID_REQUEST다', async () => {
    expectError(await addQuery('  '), 400, 'INVALID_REQUEST');
    expectError(await addGolden({ query: 'Q-HIT1', doc_id: DOC_A }), 400, 'INVALID_REQUEST');
    expectError(await addQuery('Q-HIT1', { edition_only: 'yes' }), 400, 'INVALID_REQUEST');
  });
});

describe('REQ-BE-5.1.2', () => {
  it('T-E2E-ADD-5 검색 가능이 아닌 문서는 409 DOCUMENT_NOT_SEARCHABLE이다', async () => {
    const res = await addGolden({ query: 'Q-HIT1', doc_id: DOC_C, answer_span: SPAN_SENT });
    expectError(res, 409, 'DOCUMENT_NOT_SEARCHABLE');
    expect(((await listGolden()).body as ListBody).total).toBe(0);
  });
});

describe('REQ-BE-5.1.5', () => {
  it('T-E2E-ADD-6 표 설명이나 본문에 없는 구간은 400 ANSWER_SPAN_NOT_FOUND다', async () => {
    expectError(
      await addQuery('Q-HIT1', { answer_span: '인증서 종류별 유효 기간 표' }),
      400,
      'ANSWER_SPAN_NOT_FOUND',
    );
    expectError(
      await addQuery('Q-HIT1', { answer_span: '본문에 없는 문장' }),
      400,
      'ANSWER_SPAN_NOT_FOUND',
    );
    const ok = await addQuery('Q-HIT1', { answer_span: SPAN_SENT.replace(/ /g, '\n') });
    expect(ok.status).toBe(201);
    await waitAllDone();
  });
});

describe('REQ-BE-5.1.3', () => {
  it('T-E2E-FIX-1 고치는 라우트가 없어 PATCH·PUT은 404 NOT_FOUND다', async () => {
    const created = await addQuery('Q-HIT1');
    const id = (created.body as { golden_set_id: string }).golden_set_id;
    const patch = await request(baseUrl).patch(`/v1/golden-sets/${id}`).send({ query: '바꿈' });
    expectError(patch, 404, 'NOT_FOUND');
    const put = await request(baseUrl).put(`/v1/golden-sets/${id}`).send({ query: '바꿈' });
    expectError(put, 404, 'NOT_FOUND');
    const list = (await listGolden()).body as ListBody;
    expect(list.items[0].query).toBe('Q-HIT1');
    await waitAllDone();
  });
});

describe('REQ-BE-5.1.4', () => {
  it('T-E2E-DEL-1 지우면 204이고 기록도 지워지며 다시 지우면 404다', async () => {
    const created = await addQuery('Q-HIT1');
    const id = (created.body as { golden_set_id: string }).golden_set_id;
    await waitAllDone();
    const deleted = await request(baseUrl).delete(`/v1/golden-sets/${id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
    expect(((await listGolden()).body as ListBody).total).toBe(0);
    expect(
      await harness.db.collection('evaluation_records').countDocuments({ goldenSetId: id }),
    ).toBe(0);
    const again = await request(baseUrl).delete(`/v1/golden-sets/${id}`);
    expectError(again, 404, 'GOLDEN_SET_NOT_FOUND');
  });
});

describe('REQ-BE-5.3.1', () => {
  it('T-E2E-LIST-1 결과 거르기·정렬·페이지·잘못된 값', async () => {
    await addFive();
    await waitOnlySlowEvaluating();

    const hit = (await listGolden('?outcome=hit')).body as ListBody;
    expect(hit.total).toBe(2);
    expect(hit.items.every((item) => item.latest.outcome === 'hit')).toBe(true);

    const asc = (await listGolden('?sort=rank&order=asc')).body as ListBody;
    expect(asc.items.slice(0, 2).map((item) => item.latest.expanded?.rank)).toEqual([1, 3]);
    const ascTail = asc.items.slice(2);
    expect(ascTail).toHaveLength(3);
    expect(
      ascTail.every((item) => item.latest.expanded === null || item.latest.expanded.rank === null),
    ).toBe(true);
    expect(ascTail.some((item) => item.latest.outcome === 'evaluating')).toBe(true);

    const desc = (await listGolden('?sort=rank&order=desc')).body as ListBody;
    expect(desc.items.slice(0, 2).map((item) => item.latest.expanded?.rank)).toEqual([3, 1]);
    const descTail = desc.items.slice(2);
    expect(descTail).toHaveLength(3);
    expect(
      descTail.every((item) => item.latest.expanded === null || item.latest.expanded.rank === null),
    ).toBe(true);
    expect(descTail.some((item) => item.latest.outcome === 'evaluating')).toBe(true);

    const paged = (await listGolden('?page=1&page_size=20')).body as ListBody;
    expect(paged.total).toBe(5);
    expect(paged.page).toBe(1);
    expect(paged.page_size).toBe(20);

    expectError(await listGolden('?outcome=evaluating'), 400, 'INVALID_REQUEST');
    await waitAllDone();
  });
});

describe('REQ-BE-5.3.3', () => {
  it('T-E2E-SUM-1 요약은 끝난 적중·놓침 기록만 분모로 계산한다', async () => {
    await addFive();
    await waitAllDone();
    const res = await request(baseUrl).get('/v1/evaluation-summary');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual([
      'base',
      'evaluating_count',
      'expanded',
      'golden_set_count',
      'last_evaluated_at',
      'n',
    ]);
    expect(body.golden_set_count).toBe(5);
    expect(body.evaluating_count).toBe(0);
    expect(body.n).toBe(10);
    // ★ 적중 셋·놓침 하나가 분모 4이고 실패는 뺀다
    expect(body.expanded.hit_at_n).toBe(0.75);
    expect(typeof body.last_evaluated_at).toBe('string');
  });
});

describe('REQ-BE-5.2.4', () => {
  it('T-E2E-ONE-1 한 건 다시 평가는 202이고 그 골든셋에 새 기록이 하나 더 남는다', async () => {
    const added = await addQuery('Q-HIT1');
    expect(added.status).toBe(201);
    const id = (added.body as { golden_set_id: string }).golden_set_id;
    await waitAllDone();
    const res = await request(baseUrl).post(`/v1/golden-sets/${id}/evaluate`);
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    await waitAllDone();
    expect(
      await harness.db.collection('evaluation_records').countDocuments({ goldenSetId: id }),
    ).toBe(2);
    expect(evaluationRequests()).toHaveLength(2);
  });
});

describe('REQ-BE-5.2.5', () => {
  it('T-E2E-ALL-1 전체 다시 평가는 202이고 곧바로 한 번 더 하면 409다', async () => {
    await addQuery('Q-SLOW');
    await waitAllDone();
    const first = await request(baseUrl).post('/v1/golden-sets/evaluate-all');
    expect(first.status).toBe(202);
    expect(first.text).toBe('');
    const second = await request(baseUrl).post('/v1/golden-sets/evaluate-all');
    expectError(second, 409, 'EVALUATION_IN_PROGRESS');
    await waitAllDone();
    expect(await harness.db.collection('evaluation_records').countDocuments({})).toBe(2);
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-E2E-LOG-1 평가 끝 로그가 있고 질의·정답 구간 원문은 어느 줄에도 없다', async () => {
    await addQuery('Q-HIT1');
    await waitAllDone();
    await waitUntil(() => capture.parsed().some((line) => line.msg === 'evaluation.done'));
    expect(capture.parsed().some((line) => line.msg === 'evaluation.done')).toBe(true);
    for (const line of capture.lines) {
      expect(line).not.toContain('SPAN-SENT-72');
      expect(line).not.toContain('Q-HIT1');
    }
  });
});
