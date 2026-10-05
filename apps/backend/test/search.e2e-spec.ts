import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { bootAppHarness } from './support/app-harness';
import type { AppHarness } from './support/app-harness';
import { docRecord, ed } from './support/documents-fixtures';
import { startFakeRagServer } from './support/fake-rag-server';
import type { FakeRagServer, FakeReply, RecordedRequest } from './support/fake-rag-server';
import { createLogCapture } from './support/log-capture';
import {
  assertMongoReachable,
  createTestDbName,
  dropTestDb,
  testMongoUri,
} from './support/mongo-test-db';
import type { DocumentRecord } from '../src/documents/interfaces/documents.types';

jest.setTimeout(30_000);

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

const TABLE_MD = '| a | b |\n| --- | --- |\n| 1 | 2 |';

let harness: AppHarness;
let fake: FakeRagServer;
let tmpDir: string;
let dbName: string;
let baseUrl: string;
/** 가짜 검색 응답의 results다. 테스트가 바꾼다 */
let searchResults: unknown[] = [];

/** 기본 가짜 RAG 라우터다. */
function router(req: RecordedRequest): FakeReply {
  if (req.method === 'POST' && req.url === '/v1/search') {
    return { status: 200, json: { results: searchResults } };
  }
  if (req.method === 'POST' && req.url === '/v1/documents/index-states') {
    return { status: 200, json: { items: [] } };
  }
  return { status: 404, json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '규칙 없음' } } };
}

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-search-e2e-'));
  dbName = createTestDbName();
  harness = await bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
    },
    stream: capture.stream,
  });
  baseUrl = `http://127.0.0.1:${harness.port}`;
});

beforeEach(() => {
  capture.clear();
  fake.reset();
  fake.setHandler(router);
  searchResults = [];
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  if (dbName !== undefined) await dropTestDb(dbName);
  if (tmpDir !== undefined) await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 이 테스트만 쓰는 고유 이름을 만든다. */
function uniqueName(): string {
  return `E2E-S-${randomUUID()}`;
}

/** 문서 레코드를 DB에 넣고 doc_id를 돌려준다. */
async function seedDoc(over: Partial<DocumentRecord> = {}): Promise<string> {
  const docId = over.docId ?? randomUUID();
  await harness.db.collection('documents').insertOne({ ...docRecord({ ...over, docId }) });
  return docId;
}

/** RAG Server의 검색 응답 결과 하나를 만든다(snake_case). */
function wireResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rank: 1,
    score: 0.9,
    doc_id: randomUUID(),
    version: '1',
    heading_path: ['장', '절'],
    name: 'N',
    edition: { label: 'v1', edition_date: '2025-01-01', is_latest: true },
    other_editions_in_results: false,
    chunks: [wireChunk('본문')],
    before: [],
    after: [],
    ...over,
  };
}

/** RAG Server의 검색 결과 청크 하나를 만든다(snake_case). */
function wireChunk(text: string): Record<string, unknown> {
  return {
    chunk_id: `c-${text}`,
    kind: 'text',
    text,
    placeholder_ids: [],
    split_index: null,
    split_total: null,
  };
}

/** 가짜 서버가 받은 검색 요청이다. */
function searchRequests(): RecordedRequest[] {
  return fake.requests.filter((r) => r.method === 'POST' && r.url === '/v1/search');
}

/** 받은 검색 요청의 본문을 JSON으로 읽는다. */
function bodyOf(req: RecordedRequest): Record<string, unknown> {
  return JSON.parse(req.body.toString('utf8')) as Record<string, unknown>;
}

/** 검색을 요청한다. */
function search(body: unknown): request.Test {
  return request(baseUrl)
    .post('/v1/search')
    .send(body as object);
}

/** 오류 응답의 모양과 코드를 확인한다. */
function errorOf(res: request.Response): { code: string; message: string } {
  expect(Object.keys(res.body as object)).toEqual(['error']);
  return (res.body as { error: { code: string; message: string } }).error;
}

describe('REQ-BE-4.1.1', () => {
  it('T-E2E-REQ-1 모든 조건이 RAG Server 요청으로 대응되고 상태 코드는 200이다', async () => {
    const n = uniqueName();
    const d1 = await seedDoc({ name: n, edition: ed('v1') });
    const d2 = await seedDoc({ name: n, edition: ed('v2') });
    searchResults = [wireResult({ doc_id: d1, name: n })];
    const res = await search({
      query: 'q',
      top_n: 5,
      names: [n],
      edition_scope: 'specific',
      edition: { name: n, label: 'v1' },
      expand_neighbors: true,
    });
    expect(res.status).toBe(200);
    expect(searchRequests()).toHaveLength(1);
    const sent = searchRequests()[0];
    const body = bodyOf(sent);
    expect(Object.keys(body).sort()).toEqual([
      'doc_ids',
      'edition',
      'edition_scope',
      'expand_neighbors',
      'query',
      'top_n',
    ]);
    expect(body.top_n).toBe(5);
    expect(body.edition_scope).toBe('specific');
    expect(body.edition).toEqual({ name: n, label: 'v1' });
    expect(body.expand_neighbors).toBe(true);
    expect(new Set(body.doc_ids as string[])).toEqual(new Set([d1, d2]));
    expect(sent.headers['x-minerva-token']).toBe('e2e-rag-api-token');
    expect((res.body as { results: unknown[] }).results).toHaveLength(1);
  });

  it('T-E2E-REQ-2 빠진 선택 필드는 기본값(all·false)으로 보내고 top_n은 보내지 않는다', async () => {
    const res = await search({ query: 'q' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    const body = bodyOf(searchRequests()[0]);
    expect(Object.keys(body).sort()).toEqual(['edition_scope', 'expand_neighbors', 'query']);
    expect(body.edition_scope).toBe('all');
    expect(body.expand_neighbors).toBe(false);
  });

  it('T-E2E-VAL-1 top_n이 1~50 정수가 아니면 400이고 RAG Server를 부르지 않는다', async () => {
    for (const value of [51, 0, '5']) {
      const res = await search({ query: 'q', top_n: value });
      expect(res.status).toBe(400);
      const error = errorOf(res);
      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.message).toContain('top_n');
    }
    expect(searchRequests()).toHaveLength(0);
  });

  it('T-E2E-VAL-2 specific인데 edition이 없으면 400이다', async () => {
    const res = await search({ query: 'q', edition_scope: 'specific' });
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.message).toContain('edition');
    expect(searchRequests()).toHaveLength(0);
  });

  it('T-E2E-VAL-3 query가 없거나 공백뿐이거나 모르는 필드가 있으면 400이다', async () => {
    for (const body of [{}, { query: '   ' }, { query: 'q', doc_ids: ['x'] }]) {
      const res = await search(body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_REQUEST');
    }
    expect(searchRequests()).toHaveLength(0);
  });
});

describe('REQ-BE-4.1.2', () => {
  it('T-E2E-NAME-1 이름에 맞는 문서가 없으면 RAG Server를 부르지 않고 빈 결과다', async () => {
    const res = await search({ query: 'q', names: [`E2E-없는-이름-${randomUUID()}`] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(searchRequests()).toHaveLength(0);
  });
});

describe('REQ-BE-4.2.1', () => {
  it('T-E2E-RES-1 결과의 version으로 표와 이미지 자리표시를 복원한다', async () => {
    const d = await seedDoc();
    const common = {
      docId: d,
      version: '3',
      hint: null,
      hintStatus: 'done',
      isTemporary: false,
    };
    await harness.db.collection('assets').insertMany([
      {
        ...common,
        placeholderId: 't1',
        kind: 'table',
        order: 1,
        tableMarkdown: TABLE_MD,
        imagePath: null,
        alt: null,
        fileKey: null,
        contentType: null,
        description: '표',
        hint: '표 요약',
      },
      {
        ...common,
        placeholderId: 'i1',
        kind: 'image',
        order: 2,
        tableMarkdown: null,
        imagePath: 'a.png',
        alt: 'A',
        fileKey: `${d}/3/i1.png`,
        contentType: 'image/png',
        description: '그림',
        hint: '캡션E2E',
      },
    ]);
    searchResults = [
      wireResult({
        doc_id: d,
        version: '3',
        chunks: [
          wireChunk('앞 [[minerva:table:t1 | 표]]'),
          wireChunk('[[minerva:image:i1 | 그림]] 뒤'),
        ],
      }),
    ];
    const res = await search({ query: 'q' });
    expect(res.status).toBe(200);
    const results = (res.body as { results: Array<Record<string, unknown>> }).results;
    expect(results).toHaveLength(1);
    expect(results[0].markdown).toBe(
      '앞 ' + TABLE_MD + '\n' + '![캡션E2E](/v1/documents/' + d + '/versions/3/assets/i1) 뒤',
    );
    expect(Object.keys(results[0])).not.toContain('version');
  });
});

describe('REQ-BE-4.2.2', () => {
  it('T-E2E-VIS-1 교체됨·삭제됨 문서의 결과를 빼고 순위를 다시 매긴다', async () => {
    const a = await seedDoc();
    const b = await seedDoc({ searchState: 'replaced' });
    const c = await seedDoc({ deleted: true });
    searchResults = [
      wireResult({ rank: 1, score: 0.4, doc_id: a }),
      wireResult({ rank: 2, score: 0.3, doc_id: b }),
      wireResult({ rank: 3, score: 0.2, doc_id: a }),
      wireResult({ rank: 4, score: 0.1, doc_id: c }),
    ];
    const res = await search({ query: 'q' });
    expect(res.status).toBe(200);
    const results = (res.body as { results: Array<Record<string, unknown>> }).results;
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
    expect(results.map((r) => r.doc_id)).toEqual([a, a]);
    expect(results.map((r) => r.score)).toEqual([0.4, 0.2]);
  });
});

describe('REQ-BE-10.1.2', () => {
  it('T-E2E-ERR-1 RAG Server가 실패하면 503 RAG_UNAVAILABLE이다', async () => {
    const replies: FakeReply[] = [
      { status: 503, json: { error: { code: 'SERVER_NOT_READY', message: 'x' } } },
      { status: 500, json: { error: { code: 'VECTOR_DIMENSION_MISMATCH', message: 'x' } } },
    ];
    for (const reply of replies) {
      fake.setHandler(() => reply);
      const res = await search({ query: 'q' });
      expect(res.status).toBe(503);
      expect(errorOf(res).code).toBe('RAG_UNAVAILABLE');
    }
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-E2E-LOG-1 search.done을 남기고 질의와 본문은 로그에 없다', async () => {
    const d = await seedDoc();
    searchResults = [wireResult({ doc_id: d, chunks: [wireChunk('E2E-CHUNK-SENT-89')] })];
    const res = await search({ query: 'E2E-QUERY-SENT-88' });
    expect(res.status).toBe(200);
    const done = capture.parsed().filter((line) => line.msg === 'search.done');
    expect(done).toHaveLength(1);
    const all = capture.lines.join('\n');
    expect(all).not.toContain('E2E-QUERY-SENT-88');
    expect(all).not.toContain('E2E-CHUNK-SENT-89');
  });
});
