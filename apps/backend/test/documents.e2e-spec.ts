import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { bootAppHarness } from './support/app-harness';
import type { AppHarness } from './support/app-harness';
import { docRecord, versionRecord } from './support/documents-fixtures';
import { startFakeRagServer } from './support/fake-rag-server';
import type { FakeReply, FakeRagServer, RecordedRequest } from './support/fake-rag-server';
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

/** 로그 비노출 검사용 센티널이다. */
const SENT = {
  name: 'E2E-NAME-SENT-61',
  label: 'E2E-LABEL-SENT-62',
  md: 'E2E-MD-SENT-63',
  file: 'E2E-FILE-SENT-64.md',
  edited: 'E2E-EDITED-SENT-65',
};
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const TABLE_MD = '| a | b |\n| --- | --- |\n| 1 | 2 |';
/** 목록 응답 항목의 키 집합이다. */
const SUMMARY_KEYS = [
  'doc_id',
  'edition',
  'failure_message',
  'name',
  'processing_state',
  'search_state',
  'sibling_editions',
  'stage',
  'updated_at',
  'uploaded_at',
];

let harness: AppHarness;
let fake: FakeRagServer;
let tmpDir: string;
let dbName: string;
let baseUrl: string;
/** 가짜 청크 조회 응답이다. 테스트가 바꾼다 */
let chunksBody: unknown = { version: null, items: [] };
/** 가짜 DELETE 응답 지연이다 */
let deleteDelayMs: number | undefined;

/** 기본 가짜 RAG 라우터다. */
function router(req: RecordedRequest): FakeReply {
  const url = new URL(req.url, 'http://fake');
  const p = url.pathname;
  if (req.method === 'POST' && p === '/v1/captions/table') {
    return { status: 200, json: { summary: '표 요약' } };
  }
  if (req.method === 'POST' && p === '/v1/captions/image') {
    return { status: 200, json: { caption: '이미지 캡션' } };
  }
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
  const job = /^\/v1\/index-jobs\/(.+)$/.exec(p);
  if (req.method === 'GET' && job) {
    const matched = /^job-(.+)-([^-]+)$/.exec(decodeURIComponent(job[1]));
    return {
      status: 200,
      json: {
        job_id: decodeURIComponent(job[1]),
        doc_id: matched?.[1],
        version: matched?.[2],
        state: 'succeeded',
        stage: null,
        failure: null,
        result: { chunk_count: 3, fallback_used: false },
      },
    };
  }
  if (req.method === 'DELETE' && /^\/v1\/documents\/[^/]+$/.test(p)) {
    return { status: 204, delayMs: deleteDelayMs };
  }
  if (req.method === 'PUT' && /^\/v1\/documents\/[^/]+\/metadata$/.test(p)) {
    return { status: 204 };
  }
  if (req.method === 'POST' && p === '/v1/documents/index-states') {
    return { status: 200, json: { items: [] } };
  }
  if (req.method === 'GET' && /^\/v1\/documents\/[^/]+\/chunks$/.test(p)) {
    return { status: 200, json: chunksBody };
  }
  return { status: 404, json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '규칙 없음' } } };
}

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-documents-e2e-'));
  dbName = createTestDbName();
  harness = await bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
      UPLOAD_MAX_FILES: '5',
      UPLOAD_MAX_MD_BYTES: '1000',
      UPLOAD_MAX_IMAGE_BYTES: '2000',
      UPLOAD_MAX_TOTAL_BYTES: '20000',
      // ★ 재요청 주기 작업을 실제 MongoDB로 돌려 보려고 짧게 둔다(T-E2E-RETRY-1)
      RAG_RETRY_INTERVAL_MS: '1500',
    },
    stream: capture.stream,
  });
  baseUrl = `http://127.0.0.1:${harness.port}`;
});

beforeEach(() => {
  capture.clear();
  fake.reset();
  fake.setHandler(router);
  chunksBody = { version: null, items: [] };
  deleteDelayMs = undefined;
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  if (dbName !== undefined) await dropTestDb(dbName);
  if (tmpDir !== undefined) await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 파일 파트 하나다. */
interface Part {
  name: string;
  content: string | Buffer;
}

/** 문서 정보 하나다. */
interface Meta {
  file_name: string;
  name: string;
  edition?: { label: string; edition_date: string } | null;
}

/** 이 테스트만 쓰는 고유 이름을 만든다. */
function uniq(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** 문서를 올린다. */
function upload(parts: Part[], meta: unknown[]): request.Test {
  let req = request(baseUrl).post('/v1/documents');
  for (const part of parts) {
    const buffer = Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content, 'utf8');
    req = req.attach('files', buffer, part.name);
  }
  return req.field('meta', JSON.stringify(meta));
}

/** MD 하나를 올리고 doc_id를 돌려준다. */
async function uploadOne(
  name: string,
  markdown = '# 제목\n\n본문',
  edition?: Meta['edition'],
  fileName = 'a.md',
): Promise<string> {
  const res = await upload(
    [{ name: fileName, content: markdown }],
    [{ file_name: fileName, name, edition }],
  );
  expect(res.status).toBe(201);
  return (res.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
}

/** 조건이 참이 될 때까지 50ms 간격으로 확인한다. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('조건이 시간 안에 참이 되지 않았습니다');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** RAG Server 작업 상태 알림을 보낸다. */
async function notify(
  docId: string,
  version: string,
  state: string,
  searchableVersion: string | null,
  sequence: number,
): Promise<void> {
  const res = await request(baseUrl)
    .post('/v1/internal/rag-events')
    .set('X-Minerva-Token', 'e2e-rag-events-token')
    .send({
      doc_id: docId,
      job_id: `job-${docId}-${version}`,
      version,
      job_state: state,
      index_state: {
        searchable_version: searchableVersion,
        latest_job_id: `job-${docId}-${version}`,
        latest_job_state: state,
        latest_job_stage: null,
      },
      sequence,
    });
  expect(res.status).toBe(204);
}

/** 문서 하나를 읽는다. */
async function getDoc(docId: string): Promise<request.Response> {
  return request(baseUrl).get(`/v1/documents/${docId}`);
}

/** 그 문서의 색인 요청이 가짜 RAG에 올 때까지 기다린다. */
async function waitIndexRequest(docId: string): Promise<void> {
  await waitFor(() =>
    fake.requests.some(
      (r) =>
        r.method === 'POST' &&
        r.url === '/v1/index-jobs' &&
        (JSON.parse(r.body.toString('utf8')) as { doc_id: string }).doc_id === docId,
    ),
  );
}

/** 업로드 → 색인 요청 대기 → 성공 알림 → 완료·검색 가능 확인까지 하고 doc_id를 돌려준다. */
async function makeCompleted(name: string, edition?: Meta['edition']): Promise<string> {
  const docId = await uploadOne(name, '# 제목\n\n본문', edition);
  await waitIndexRequest(docId);
  await notify(docId, '1', 'succeeded', '1', 1);
  await waitFor(async () => {
    const body = (await getDoc(docId)).body as { processing_state: string; search_state: string };
    return body.processing_state === 'completed' && body.search_state === 'searchable';
  });
  return docId;
}

/** 문서·버전 레코드를 Db에 직접 넣는다. docId는 소문자 UUID v4다. */
async function seedDocument(
  over: Partial<DocumentRecord> = {},
  versionOver: Record<string, unknown> = {},
): Promise<DocumentRecord> {
  const doc = docRecord({ docId: randomUUID(), ...over });
  await harness.db.collection('documents').insertOne({ ...doc });
  await harness.db
    .collection('document_versions')
    .insertOne({ ...versionRecord({ docId: doc.docId }), ...versionOver });
  return doc;
}

/** 문서 목록을 읽는다. */
async function listDocs(query: Record<string, string | number>): Promise<{
  status: number;
  items: Array<Record<string, unknown>>;
  total: number;
}> {
  const res = await request(baseUrl).get('/v1/documents').query(query);
  const body = res.body as { items?: Array<Record<string, unknown>>; total?: number };
  return { status: res.status, items: body.items ?? [], total: body.total ?? -1 };
}

/** 응답 객체 안 모든 키 이름을 모은다. */
function allKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      allKeys(child, keys);
    }
  }
  return keys;
}

/** 오류 본문이 키 error 하나이고 code가 맞음을 단언한다. */
function expectError(res: request.Response, status: number, code: string): string {
  expect(res.status).toBe(status);
  const body = res.body as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error.code).toBe(code);
  return body.error.message;
}

/** 시드용 시각을 만든다. */
function at(iso: string): Date {
  return new Date(iso);
}

/** 표 칸에 짝 있는 이미지(img/z.png)가 든 GFM 표 문서다. ID는 t1, i1이다. */
const NEST_TABLE_MD = '| 키 | 값 |\n| --- | --- |\n| ![i](img/z.png) | b |';

/** 표 안 이미지 문서를 z.png와 함께 올리고 doc_id를 돌려준다. */
async function uploadNestedTable(name: string): Promise<string> {
  const res = await upload(
    [
      { name: 'a.md', content: NEST_TABLE_MD },
      { name: 'z.png', content: PNG },
    ],
    [{ file_name: 'a.md', name }],
  );
  expect(res.status).toBe(201);
  return (res.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
}

/**
 * 표 안 이미지 문서를 올려 완료·검색 가능까지 흘리고 doc_id를 돌려준다.
 * withChunk면 가짜 RAG의 청크 본문을 표 자리표시 하나로 둔다.
 */
async function makeNestedCompleted(name: string, withChunk = false): Promise<string> {
  const docId = await uploadNestedTable(name);
  await waitIndexRequest(docId);
  if (withChunk) {
    chunksBody = {
      version: '1',
      items: [
        {
          chunk_id: 'c1',
          order: 1,
          kind: 'text',
          heading_path: ['H'],
          title: null,
          summary: null,
          text: '[[minerva:table:t1 | a]]',
          placeholder_ids: ['t1'],
          split_index: null,
          split_total: null,
        },
      ],
    };
  }
  await notify(docId, '1', 'succeeded', '1', 1);
  await waitFor(async () => {
    const body = (await getDoc(docId)).body as { processing_state: string; search_state: string };
    return body.processing_state === 'completed' && body.search_state === 'searchable';
  });
  return docId;
}

/** 응답 본문을 바이트로 받는다. */
async function getBytes(url: string): Promise<{ status: number; body: Buffer }> {
  const res = await request(baseUrl)
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: res.status, body: res.body as Buffer };
}

/** 컬렉션의 인덱스를 이름으로 찾는다. */
async function findIndex(
  collection: string,
  name: string,
): Promise<{ name?: string; unique?: boolean } | undefined> {
  const list = await harness.db.collection(collection).indexes();
  return list.find((index) => index.name === name);
}

describe('REQ-BE-1.1.1', () => {
  it('T-PR3-MOVE-1a documents_doc_id는 고유 인덱스라 같은 ID의 문서가 둘 생기지 않는다', async () => {
    // ★ 근거: MD 하나마다 문서 하나(REQ-BE-1.1.1) — 이 고유 인덱스가 같은 doc_id의 이중 삽입을 막는다
    expect((await findIndex('documents', 'documents_doc_id'))?.unique).toBe(true);
  });

  it('T-E2E-UP-1 MD 둘과 이미지 하나를 올리면 201이고 문서 둘이 생긴다', async () => {
    const res = await upload(
      [
        { name: 'a.md', content: '# A' },
        { name: 'b.md', content: '# B' },
        { name: 'p.png', content: PNG },
      ],
      [
        { file_name: 'a.md', name: uniq('up1') },
        { file_name: 'b.md', name: uniq('up1') },
      ],
    );
    expect(res.status).toBe(201);
    const docs = (res.body as { documents: Array<Record<string, unknown>> }).documents;
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(Object.keys(doc).sort()).toEqual(['doc_id', 'file_name', 'name', 'unmatched_images']);
      expect(doc.doc_id).toMatch(DOC_ID);
      expect((await getDoc(doc.doc_id as string)).status).toBe(200);
    }
  });
});

describe('REQ-BE-1.1.2', () => {
  it('T-E2E-UP-2 받지 않는 형식이 섞이면 400 UNSUPPORTED_FILE이고 문서는 늘지 않는다', async () => {
    const before = (await listDocs({})).total;
    const res = await upload(
      [
        { name: 'a.md', content: '# A' },
        { name: 'x.pdf', content: 'pdf' },
      ],
      [{ file_name: 'a.md', name: uniq('up2') }],
    );
    expect(expectError(res, 400, 'UNSUPPORTED_FILE')).toContain('x.pdf');
    expect((await listDocs({})).total).toBe(before);
  });
});

describe('REQ-BE-1.1.3', () => {
  it('T-E2E-UP-3 이미지 참조는 원본의 이미지 주소로 내려받을 수 있다', async () => {
    const res = await upload(
      [
        { name: 'a.md', content: '![a](./img/a.png)' },
        { name: 'a.png', content: PNG },
      ],
      [{ file_name: 'a.md', name: uniq('up3') }],
    );
    expect(res.status).toBe(201);
    const docId = (res.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
    const original = await request(baseUrl).get(`/v1/documents/${docId}/original`);
    expect(original.status).toBe(200);
    const url = (original.body as { images: Record<string, string | null> }).images['./img/a.png'];
    expect(url?.startsWith('/v1/')).toBe(true);
    const image = await request(baseUrl)
      .get(url as string)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(image.status).toBe(200);
    expect((image.body as Buffer).equals(PNG)).toBe(true);
  });

  it('T-PR3-E2E-TBL-1 GFM 칸 안 이미지도 짝지어져 원본의 이미지 주소로 내려받을 수 있다', async () => {
    const res = await upload(
      [
        { name: 'a.md', content: NEST_TABLE_MD },
        { name: 'z.png', content: PNG },
      ],
      [{ file_name: 'a.md', name: uniq('tbl1') }],
    );
    expect(res.status).toBe(201);
    const doc = (res.body as { documents: Array<{ doc_id: string; unmatched_images: string[] }> })
      .documents[0];
    expect(doc.unmatched_images).toEqual([]);
    const original = await request(baseUrl).get(`/v1/documents/${doc.doc_id}/original`);
    const url = (original.body as { images: Record<string, string | null> }).images['img/z.png'];
    expect(url).toBe(`/v1/documents/${doc.doc_id}/versions/1/assets/i1`);
    const image = await getBytes(url as string);
    expect(image.status).toBe(200);
    expect(image.body.equals(PNG)).toBe(true);
  });
});

describe('REQ-BE-1.1.4', () => {
  it('T-PR3-E2E-TBL-2 HTML 표 안 짝 없는 이미지는 응답에 담기고 원본에서는 null이다', async () => {
    const res = await upload(
      [{ name: 'a.md', content: '<table><tr><td><img src="b.png"></td></tr></table>' }],
      [{ file_name: 'a.md', name: uniq('tbl2') }],
    );
    expect(res.status).toBe(201);
    const doc = (res.body as { documents: Array<{ doc_id: string; unmatched_images: string[] }> })
      .documents[0];
    expect(doc.unmatched_images).toEqual(['b.png']);
    const original = await request(baseUrl).get(`/v1/documents/${doc.doc_id}/original`);
    expect((original.body as { images: Record<string, unknown> }).images['b.png']).toBeNull();
  });

  it('T-E2E-UP-4 짝 없는 이미지 참조는 응답에 담기고 원본에서는 null이다', async () => {
    const res = await upload(
      [{ name: 'a.md', content: '![m](missing.png)' }],
      [{ file_name: 'a.md', name: uniq('up4') }],
    );
    expect(res.status).toBe(201);
    const doc = (res.body as { documents: Array<{ doc_id: string; unmatched_images: string[] }> })
      .documents[0];
    expect(doc.unmatched_images).toEqual(['missing.png']);
    const original = await request(baseUrl).get(`/v1/documents/${doc.doc_id}/original`);
    expect((original.body as { images: Record<string, unknown> }).images['missing.png']).toBeNull();
  });
});

describe('REQ-BE-1.1.6', () => {
  it('T-E2E-UP-5 이름이 비었거나 판 표기만 있으면 400이고 문서는 늘지 않는다', async () => {
    const before = (await listDocs({})).total;
    const blank = await upload(
      [{ name: 'a.md', content: '# A' }],
      [{ file_name: 'a.md', name: '' }],
    );
    expectError(blank, 400, 'INVALID_REQUEST');
    const labelOnly = await upload(
      [{ name: 'a.md', content: '# A' }],
      [{ file_name: 'a.md', name: 'x', edition: { label: 'v1' } }],
    );
    expectError(labelOnly, 400, 'INVALID_REQUEST');
    expect((await listDocs({})).total).toBe(before);
  });
});

describe('REQ-BE-1.1.8', () => {
  it('T-E2E-UP-6 업로드 직후 검색 안 됨이고 첫 처리 상태 기록이 업로드됨에서 시작한다', async () => {
    const docId = await uploadOne(uniq('up6'));
    const detail = (await getDoc(docId)).body as { search_state: string };
    expect(detail.search_state).toBe('not_searchable');
    await waitFor(async () => {
      const res = await request(baseUrl)
        .get('/v1/logs')
        .query({ doc_id: docId, kind: 'processing_state', order: 'asc' });
      const items = (res.body as { items: Array<{ description: string }> }).items;
      return items.length > 0 && items[0].description.startsWith('처리 상태가 업로드됨에서');
    });
  });
});

describe('REQ-BE-1.1.9', () => {
  it('T-E2E-UP-7 표가 있으면 응답 뒤 표 요약을 요청하고 업로드 기록이 하나다', async () => {
    const docId = await uploadOne(uniq('up7'), `# T\n\n${TABLE_MD}`);
    await waitFor(() =>
      fake.requests.some((r) => r.method === 'POST' && r.url === '/v1/captions/table'),
    );
    const logs = await request(baseUrl).get('/v1/logs').query({ doc_id: docId, kind: 'upload' });
    expect((logs.body as { total: number }).total).toBe(1);
  });
});

describe('REQ-BE-1.1.10', () => {
  it('T-E2E-UP-8 MD 한도(1000바이트)를 넘으면 413이고 한도와 같으면 201이다', async () => {
    const before = (await listDocs({})).total;
    const over = await upload(
      [{ name: 'big.md', content: Buffer.alloc(1001, 97) }],
      [{ file_name: 'big.md', name: uniq('up8') }],
    );
    expect(expectError(over, 413, 'PAYLOAD_TOO_LARGE')).toContain('big.md');
    expect((await listDocs({})).total).toBe(before);
    const ok = await upload(
      [{ name: 'ok.md', content: Buffer.alloc(1000, 97) }],
      [{ file_name: 'ok.md', name: uniq('up8') }],
    );
    expect(ok.status).toBe(201);
  });
});

describe('REQ-BE-1.2.7', () => {
  it('T-E2E-RC-1 같은 판 확인은 같은 이름·판 표기의 문서를 준다', async () => {
    const name = uniq('rc1');
    const edition = { label: 'v1', edition_date: '2026-01-01' };
    const first = await uploadOne(name, '# A', edition);
    const second = await uploadOne(name, '# B', edition);
    const res = await request(baseUrl)
      .get('/v1/documents/replacement-check')
      .query({ name, edition_label: 'v1' });
    expect(res.status).toBe(200);
    const body = res.body as { replaces: Array<Record<string, unknown>> };
    expect(body.replaces.map((item) => item.doc_id).sort()).toEqual([first, second].sort());
    expect(Object.keys(body.replaces[0]).sort()).toEqual(['doc_id', 'edition', 'name']);
    const excluded = await request(baseUrl)
      .get('/v1/documents/replacement-check')
      .query({ name, edition_label: 'v1', exclude_doc_id: first });
    expect((excluded.body as { replaces: unknown[] }).replaces).toHaveLength(1);
    const none = await request(baseUrl)
      .get('/v1/documents/replacement-check')
      .query({ name: uniq('rc1-none'), edition_label: 'v1' });
    expect(none.body).toEqual({ replaces: [] });
  });
});

describe('REQ-BE-1.3.1', () => {
  it('T-E2E-LIST-1 45개 문서를 쪽으로 나눠 주고 허용 밖 크기는 400이다', async () => {
    const name = uniq('e2e-page');
    const docs = Array.from({ length: 45 }, () => ({
      ...docRecord({ docId: randomUUID(), name }),
    }));
    await harness.db.collection('documents').insertMany(docs);
    const third = await listDocs({ name, page_size: 20, page: 3 });
    expect(third.items).toHaveLength(5);
    expect(third.total).toBe(45);
    expect((await listDocs({ name, page_size: 50 })).items).toHaveLength(45);
    expect((await listDocs({ name, page_size: 30 })).status).toBe(400);
  });
});

describe('REQ-BE-1.3.2', () => {
  it('T-E2E-LIST-2 다섯 열을 오름·내림차순으로 정렬하고 기본은 최근 수정순이다', async () => {
    const window = { uploaded_from: '2032-01-01', uploaded_to: '2032-01-31' };
    const a = await seedDocument({
      name: 'b',
      searchState: 'searchable',
      processingState: 'completed',
      uploadedAt: at('2032-01-12T03:00:00Z'),
      updatedAt: at('2032-01-23T03:00:00Z'),
    });
    const b = await seedDocument({
      name: 'a',
      searchState: 'not_searchable',
      searchableVersion: null,
      processingState: 'uploaded',
      uploadedAt: at('2032-01-10T03:00:00Z'),
      updatedAt: at('2032-01-22T03:00:00Z'),
    });
    const c = await seedDocument({
      name: 'c',
      searchState: 'replaced',
      processingState: 'failed',
      uploadedAt: at('2032-01-13T03:00:00Z'),
      updatedAt: at('2032-01-21T03:00:00Z'),
    });
    const d = await seedDocument({
      name: '가',
      searchState: 'searchable',
      processingState: 'queued',
      uploadedAt: at('2032-01-11T03:00:00Z'),
      updatedAt: at('2032-01-20T03:00:00Z'),
    });
    const [A, B, C, D] = [a, b, c, d].map((doc) => doc.docId);
    const expected: Record<string, [string[], string[]]> = {
      name: [
        [B, A, C, D],
        [D, C, A, B],
      ],
      search_state: [
        [A, D, B, C],
        [C, B, A, D],
      ],
      processing_state: [
        [B, D, A, C],
        [C, A, D, B],
      ],
      uploaded_at: [
        [B, D, A, C],
        [C, A, D, B],
      ],
      updated_at: [
        [D, C, B, A],
        [A, B, C, D],
      ],
    };
    for (const [sort, [asc, desc]] of Object.entries(expected)) {
      const up = await listDocs({ ...window, sort, order: 'asc' });
      expect([sort, 'asc', up.items.map((i) => i.doc_id)]).toEqual([sort, 'asc', asc]);
      const down = await listDocs({ ...window, sort, order: 'desc' });
      expect([sort, 'desc', down.items.map((i) => i.doc_id)]).toEqual([sort, 'desc', desc]);
    }
    const byDefault = await listDocs(window);
    expect(byDefault.items.map((i) => i.doc_id)).toEqual([A, B, C, D]);
  });

  it('T-PR3-E2E-LIST-1 처리 상태 25개를 섞어도 상태 열 정렬의 쪽과 total이 맞다', async () => {
    const name = uniq('e2e-state');
    const states = ['uploaded', 'captioning', 'queued', 'indexing', 'completed', 'failed'] as const;
    // ★ 상태가 쪽 경계에 걸리도록 25개를 6종에 돌려 가며 배정한다. 수정 시각은 모두 달라 동점 순서가 정해진다
    const docs = Array.from({ length: 25 }, (_, i) =>
      docRecord({
        docId: randomUUID(),
        name,
        processingState: states[(i * 5) % states.length],
        updatedAt: new Date(Date.UTC(2036, 0, 1, i)),
      }),
    );
    await harness.db.collection('documents').insertMany(docs.map((doc) => ({ ...doc })));
    // 독립 계산: 상태 차례 → 수정 최근순 → 문서 ID 오름차순
    const expected = [...docs]
      .sort(
        (a, b) =>
          states.indexOf(a.processingState as (typeof states)[number]) -
            states.indexOf(b.processingState as (typeof states)[number]) ||
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          (a.docId < b.docId ? -1 : 1),
      )
      .map((doc) => doc.docId);
    const first = await listDocs({ name, sort: 'processing_state', order: 'asc', page_size: 20 });
    const second = await listDocs({
      name,
      sort: 'processing_state',
      order: 'asc',
      page_size: 20,
      page: 2,
    });
    expect(first.total).toBe(25);
    expect(second.total).toBe(25);
    expect(first.items.map((i) => i.doc_id)).toEqual(expected.slice(0, 20));
    expect(second.items.map((i) => i.doc_id)).toEqual(expected.slice(20));
  });
});

describe('REQ-BE-1.3.3', () => {
  it('T-E2E-LIST-3 상태·이름·판 유무·최신판·기간 필터가 각각 그리고 함께 동작한다', async () => {
    const window = { uploaded_from: '2033-01-01', uploaded_to: '2033-12-31' };
    const edition = (label: string, editionDate: string) => ({ label, editionDate });
    const s1 = await seedDocument({
      name: 'N3',
      edition: edition('v22', '2022-01-01'),
      uploadedAt: at('2033-02-01T03:00:00Z'),
    });
    const s2 = await seedDocument({
      name: 'N3',
      edition: edition('v25', '2025-01-01'),
      uploadedAt: at('2033-02-02T03:00:00Z'),
    });
    const s3 = await seedDocument({
      name: 'N3',
      edition: edition('v26', '2026-01-01'),
      searchState: 'not_searchable',
      searchableVersion: null,
      processingState: 'uploaded',
      uploadedAt: at('2033-02-03T03:00:00Z'),
    });
    const s4 = await seedDocument({
      name: 'N3b',
      searchState: 'replaced',
      processingState: 'failed',
      uploadedAt: at('2033-02-04T03:00:00Z'),
    });
    const s5 = await seedDocument({
      name: 'N3',
      processingState: 'indexing',
      uploadedAt: at('2033-02-05T03:00:00Z'),
    });
    const [S1, S2, S3, S4, S5] = [s1, s2, s3, s4, s5].map((doc) => doc.docId);
    const ids = async (query: Record<string, string>): Promise<string[]> =>
      (await listDocs({ ...window, ...query })).items.map((i) => i.doc_id as string).sort();
    const sorted = (...list: string[]): string[] => [...list].sort();

    expect(await ids({ search_state: 'searchable' })).toEqual(sorted(S1, S2, S5));
    expect(await ids({ search_state: 'searchable,replaced' })).toEqual(sorted(S1, S2, S4, S5));
    expect(await ids({ processing_state: 'completed,failed' })).toEqual(sorted(S1, S2, S4));
    expect(await ids({ name: 'N3' })).toEqual(sorted(S1, S2, S3, S5));
    expect(await ids({ has_edition: 'true' })).toEqual(sorted(S1, S2, S3));
    expect(await ids({ has_edition: 'false' })).toEqual(sorted(S4, S5));
    expect(await ids({ latest_only: 'true' })).toEqual(sorted(S2, S4, S5));
    expect(
      await ids({ search_state: 'searchable', has_edition: 'true', latest_only: 'true' }),
    ).toEqual([S2]);
    const range = await listDocs({ uploaded_from: '2033-02-02', uploaded_to: '2033-02-03' });
    expect(range.items.map((i) => i.doc_id as string).sort()).toEqual(sorted(S2, S3));
    const both = await listDocs({
      uploaded_from: '2033-02-02',
      uploaded_to: '2033-02-03',
      search_state: 'searchable',
    });
    expect(both.items.map((i) => i.doc_id)).toEqual([S2]);
  });
});

describe('REQ-BE-1.3.4', () => {
  it('T-E2E-LIST-4 날짜 필터는 한국 시간 하루로 해석한다', async () => {
    const x = await seedDocument({
      name: 'kst-x',
      uploadedAt: at('2034-10-04T14:59:00Z'),
    });
    const y = await seedDocument({
      name: 'kst-y',
      uploadedAt: at('2034-10-04T15:00:00Z'),
    });
    const upTo = await listDocs({ uploaded_from: '2034-10-01', uploaded_to: '2034-10-04' });
    expect(upTo.items.map((i) => i.doc_id)).toEqual([x.docId]);
    const from = await listDocs({ uploaded_from: '2034-10-05', uploaded_to: '2034-10-31' });
    expect(from.items.map((i) => i.doc_id)).toEqual([y.docId]);
  });
});

describe('REQ-BE-1.3.7', () => {
  it('T-E2E-NAME-1 이름 목록은 중복 없이 코드 포인트 순이며 접두사·limit을 받는다', async () => {
    const p = uniq('nm');
    for (const name of [`${p}-b`, `${p}-a`, `${p}-a`, `${p}-가`]) await seedDocument({ name });
    await seedDocument({ name: `${p}-del`, deleted: true });
    const all = await request(baseUrl).get('/v1/document-names').query({ prefix: p });
    expect(all.status).toBe(200);
    expect((all.body as { items: string[] }).items).toEqual([`${p}-a`, `${p}-b`, `${p}-가`]);
    const limited = await request(baseUrl).get('/v1/document-names').query({ prefix: p, limit: 2 });
    expect((limited.body as { items: string[] }).items).toEqual([`${p}-a`, `${p}-b`]);
    const bad = await request(baseUrl).get('/v1/document-names').query({ limit: 51 });
    expectError(bad, 400, 'INVALID_REQUEST');
  });

  it('T-PR3-E2E-NAMES-1 같은 이름이 120개여도 세 이름이 코드 포인트 순으로 나온다', async () => {
    const p = uniq('nmx');
    const make = (name: string) => ({ ...docRecord({ docId: randomUUID(), name }) });
    // ★ 가운데 이름이 묶음 크기(100)를 넘게 이어져도 다음 이름까지 읽어야 한다
    const docs = [
      make(`${p}-c`),
      make(`${p}-a`),
      ...Array.from({ length: 120 }, () => make(`${p}-b`)),
    ];
    await harness.db.collection('documents').insertMany(docs);
    const res = await request(baseUrl).get('/v1/document-names').query({ prefix: p });
    expect(res.status).toBe(200);
    expect((res.body as { items: string[] }).items).toEqual([`${p}-a`, `${p}-b`, `${p}-c`]);
  });

  it('T-PR3-MOVE-1b documents_name 인덱스가 있어 이름 목록이 이름순으로 조회된다', async () => {
    // ★ 근거: 이름 목록은 이름순 묶음 조회(P15)로 이 인덱스를 쓴다 (REQ-BE-1.3.7)
    expect(await findIndex('documents', 'documents_name')).toBeDefined();
  });
});

describe('REQ-BE-1.4.1', () => {
  it('T-E2E-GET-1 상세의 키 집합이 명세와 같고 삭제된 문서·없는 문서는 404다', async () => {
    const docId = await makeCompleted(uniq('get1'));
    const res = await getDoc(docId);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(
      [...SUMMARY_KEYS, 'assets', 'failure', 'file_name', 'result'].sort(),
    );
    expect(allKeys(res.body)).not.toContain('version');
    const del = await request(baseUrl).delete(`/v1/documents/${docId}`);
    expect(del.status).toBe(204);
    expectError(await getDoc(docId), 404, 'DOCUMENT_NOT_FOUND');
    expectError(await getDoc(randomUUID()), 404, 'DOCUMENT_NOT_FOUND');
  });
});

describe('REQ-BE-1.4.3', () => {
  it('T-E2E-GET-2 BOM·CRLF·한글 MD의 원본은 올린 바이트와 같다', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# 제목\r\n한글 본문\r\n', 'utf8'),
    ]);
    const res = await upload(
      [{ name: '한글.md', content: bytes }],
      [{ file_name: '한글.md', name: uniq('get2') }],
    );
    expect(res.status).toBe(201);
    const docId = (res.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
    const original = await request(baseUrl).get(`/v1/documents/${docId}/original`);
    const markdown = (original.body as { markdown: string }).markdown;
    expect(Buffer.from(markdown, 'utf8').equals(bytes)).toBe(true);
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-PR3-E2E-TBL-3 상세의 assets에는 표 하나뿐이고 표 안 이미지 경로가 이미지 주소로 바뀌어 있다', async () => {
    const docId = await uploadNestedTable(uniq('tbl3'));
    const detail = (await getDoc(docId)).body as {
      assets: Array<{ placeholder_id: string; kind: string; table_markdown: string | null }>;
    };
    expect(detail.assets).toHaveLength(1);
    expect(detail.assets[0].kind).toBe('table');
    const markdown = detail.assets[0].table_markdown as string;
    expect(markdown).toContain(`/v1/documents/${docId}/versions/1/assets/i1`);
    expect(markdown).not.toContain('img/z.png');
  });
});

describe('REQ-BE-1.5.5', () => {
  it('T-E2E-LOCK-1 처리 중인 문서는 편집·재색인·내용 다시 올리기가 409다', async () => {
    for (const state of ['uploaded', 'captioning', 'queued', 'indexing'] as const) {
      const doc = await seedDocument({ name: uniq('lock'), processingState: state });
      const patch = await request(baseUrl)
        .patch(`/v1/documents/${doc.docId}`)
        .send({ name: '새이름' });
      expectError(patch, 409, 'DOCUMENT_LOCKED');
      const reindex = await request(baseUrl).post(`/v1/documents/${doc.docId}/reindex`);
      expectError(reindex, 409, 'DOCUMENT_LOCKED');
      const contents = await request(baseUrl)
        .post(`/v1/documents/${doc.docId}/contents`)
        .attach('files', Buffer.from('# x'), 'a.md');
      expectError(contents, 409, 'DOCUMENT_LOCKED');
    }
  });

  it('T-E2E-LOCK-2 완료 문서에 다른 이름의 편집을 동시에 보내도 결과는 일관된다', async () => {
    const docId = await makeCompleted(uniq('lock2'));
    const names = ['이름1', '이름2'];
    const results = await Promise.all(
      names.map((name) => request(baseUrl).patch(`/v1/documents/${docId}`).send({ name })),
    );
    // ★ 서버가 요청을 어떤 순서로 처리하든 성립하는 불변식만 본다(순서는 단위 테스트가 결정적으로 본다)
    const statuses = results.map((r) => r.status);
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    for (const lost of results.filter((r) => r.status === 409)) {
      expect((lost.body as { error: { code: string } }).error.code).toBe('DOCUMENT_LOCKED');
    }
    const winners = names.filter((_, i) => results[i].status === 200);
    const finalName = (await getDoc(docId)).body.name as string;
    expect(winners).toContain(finalName);
    const logs = await request(baseUrl).get('/v1/logs').query({ doc_id: docId, kind: 'edit' });
    expect((logs.body as { total: number }).total).toBe(winners.length);
  });
});

describe('REQ-BE-1.6.1', () => {
  it('T-PR3-MOVE-1c document_versions_doc_version은 고유 인덱스라 같은 번호의 버전이 둘 생기지 않는다', async () => {
    // ★ 근거: 새 버전 만들기(REQ-BE-1.6.1)는 같은 번호 버전을 이중으로 쓰지 않는다 — replaceVersion의 전제다
    expect((await findIndex('document_versions', 'document_versions_doc_version'))?.unique).toBe(
      true,
    );
  });

  it('T-E2E-CONT-1 내용 다시 올리기: 잘못된 요청은 거부하고 올바른 요청은 202로 새 원본을 만든다', async () => {
    const docId = await makeCompleted(uniq('cont1'));
    const url = `/v1/documents/${docId}/contents`;
    expectError(
      await request(baseUrl).post(url).attach('files', Buffer.from('x'), 'x.pdf'),
      400,
      'UNSUPPORTED_FILE',
    );
    expectError(
      await request(baseUrl).post(url).attach('files', Buffer.alloc(1001, 97), 'big.md'),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    expectError(
      await request(baseUrl)
        .post(url)
        .attach('files', Buffer.from('a'), 'a.md')
        .attach('files', Buffer.from('b'), 'b.md'),
      400,
      'INVALID_REQUEST',
    );
    const ok = await request(baseUrl).post(url).attach('files', Buffer.from('# 새 내용'), 'new.md');
    expect(ok.status).toBe(202);
    expect(Object.keys(ok.body as object).sort()).toEqual([
      'doc_id',
      'file_name',
      'name',
      'unmatched_images',
    ]);
    const original = await request(baseUrl).get(`/v1/documents/${docId}/original`);
    expect((original.body as { markdown: string }).markdown).toBe('# 새 내용');
    await waitFor(async () => {
      const logs = await request(baseUrl)
        .get('/v1/logs')
        .query({ doc_id: docId, kind: 'content_upload' });
      return (logs.body as { total: number }).total === 1;
    });
  });
});

describe('REQ-BE-1.6.4', () => {
  it('T-E2E-SHAPE-1 어떤 응답에도 version 키가 없고 이미지 주소에만 /versions/가 있다', async () => {
    const name = uniq('shape');
    const res = await upload(
      [
        { name: 'a.md', content: '![a](./a.png)\n\n앞' },
        { name: 'a.png', content: PNG },
      ],
      [{ file_name: 'a.md', name, edition: { label: 'v1', edition_date: '2026-01-01' } }],
    );
    expect(res.status).toBe(201);
    const docId = (res.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
    await waitIndexRequest(docId);
    await notify(docId, '1', 'succeeded', '1', 1);
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
    chunksBody = {
      version: '1',
      items: [
        {
          chunk_id: 'c1',
          order: 1,
          kind: 'text',
          heading_path: ['H'],
          title: null,
          summary: null,
          text: '앞',
          placeholder_ids: [],
          split_index: null,
          split_total: null,
        },
      ],
    };
    const responses: unknown[] = [
      res.body,
      (await request(baseUrl).get('/v1/documents').query({ name })).body,
      (await getDoc(docId)).body,
      (await request(baseUrl).get(`/v1/documents/${docId}/original`)).body,
      (await request(baseUrl).get(`/v1/documents/${docId}/chunks`)).body,
      (
        await request(baseUrl)
          .get('/v1/documents/replacement-check')
          .query({ name, edition_label: 'v1' })
      ).body,
      (
        await request(baseUrl)
          .patch(`/v1/documents/${docId}`)
          .send({ name: uniq('shape2') })
      ).body,
    ];
    for (const body of responses) expect(allKeys(body)).not.toContain('version');
    const original = (responses[3] as { images: Record<string, string | null> }).images;
    expect(original['./a.png']).toContain('/versions/');
    const contents = await request(baseUrl)
      .post(`/v1/documents/${docId}/contents`)
      .attach('files', Buffer.from('# 새'), 'n.md');
    expect(allKeys(contents.body)).not.toContain('version');
  });
});

describe('REQ-BE-1.8.1', () => {
  it('T-E2E-DEL-1 RAG Server 삭제가 느려도 204가 바로 오고 이후 로그는 삭제된 문서로 표시된다', async () => {
    const docId = await makeCompleted(uniq('del1'));
    deleteDelayMs = 3000;
    const started = Date.now();
    const del = await request(baseUrl).delete(`/v1/documents/${docId}`);
    expect(del.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(1500);
    expectError(await getDoc(docId), 404, 'DOCUMENT_NOT_FOUND');
    const logs = await request(baseUrl).get('/v1/logs').query({ doc_id: docId });
    const items = (logs.body as { items: Array<{ document_deleted: boolean }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.document_deleted)).toBe(true);
    // ★ 지연된 삭제 응답이 끝날 때까지 기다린다(종료 때 남은 요청이 닫기를 막지 않게 한다)
    await waitFor(async () => {
      const row = await harness.db.collection('documents').findOne({ docId });
      return row?.purged === true;
    }, 10_000);
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-PR3-E2E-FS-1 문서 데이터를 지운 뒤 그 문서의 파일 폴더까지 없다', async () => {
    // ★ 표 안 이미지 기능과 무관하게 폴더가 생기도록 일반 이미지 문서를 쓴다
    const res = await upload(
      [
        { name: 'a.md', content: '![a](a.png)' },
        { name: 'a.png', content: PNG },
      ],
      [{ file_name: 'a.md', name: uniq('fs1') }],
    );
    expect(res.status).toBe(201);
    const docId = (res.body as { documents: Array<{ doc_id: string }> }).documents[0].doc_id;
    await waitIndexRequest(docId);
    await notify(docId, '1', 'succeeded', '1', 1);
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
    // ★ 지우기 전에는 폴더가 있어야 "없다"가 의미를 갖는다
    await expect(fs.stat(path.join(tmpDir, docId))).resolves.toBeDefined();
    expect((await request(baseUrl).delete(`/v1/documents/${docId}`)).status).toBe(204);
    await waitFor(async () => {
      const row = await harness.db.collection('documents').findOne({ docId });
      return row?.purged === true;
    }, 10_000);
    await expect(fs.stat(path.join(tmpDir, docId))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('REQ-BE-2.5.4', () => {
  it('T-PR3-E2E-TBL-4 청크 복원의 표 안 이미지 경로가 이미지 주소로 바뀐다', async () => {
    const docId = await makeNestedCompleted(uniq('tbl4'), true);
    const chunks = await request(baseUrl).get(`/v1/documents/${docId}/chunks`);
    expect(chunks.status).toBe(200);
    const markdown = (chunks.body as { items: Array<{ markdown: string }> }).items[0].markdown;
    expect(markdown).toContain(`/v1/documents/${docId}/versions/1/assets/i1`);
    expect(markdown).not.toContain('img/z.png');
    expect(markdown).not.toContain('[[minerva');
  });
});

describe('REQ-BE-1.9.7', () => {
  it('T-E2E-FLOW-1 표가 있는 문서가 업로드부터 완료·청크 복원까지 흐른다', async () => {
    const docId = await uploadOne(uniq('flow1'), `# 문서\n\n앞\n\n${TABLE_MD}\n\n뒤`);
    await waitIndexRequest(docId);
    const request1 = fake.requests.find(
      (r) =>
        r.url === '/v1/index-jobs' &&
        (JSON.parse(r.body.toString('utf8')) as { doc_id: string }).doc_id === docId,
    );
    const sent = JSON.parse(request1?.body.toString('utf8') ?? '{}') as {
      assets: Array<{ placeholder_id: string; text: string }>;
    };
    expect(sent.assets).toContainEqual({ placeholder_id: 't1', text: '표 요약' });

    await notify(docId, '1', 'succeeded', '1', 1);
    chunksBody = {
      version: '1',
      items: [
        {
          chunk_id: 'c1',
          order: 1,
          kind: 'text',
          heading_path: ['H'],
          title: null,
          summary: null,
          text: '앞 [[minerva:table:t1 | 표]] 뒤',
          placeholder_ids: ['t1'],
          split_index: null,
          split_total: null,
        },
      ],
    };
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
    const detail = (await getDoc(docId)).body as Record<string, unknown>;
    expect(detail.search_state).toBe('searchable');
    expect(detail.result).toEqual({ chunk_count: 3, fallback_used: false });
    const chunks = await request(baseUrl).get(`/v1/documents/${docId}/chunks`);
    expect(chunks.status).toBe(200);
    const markdown = (chunks.body as { items: Array<{ markdown: string }> }).items[0].markdown;
    expect(markdown).toContain('| a | b |');
    expect(markdown).not.toContain('[[minerva');
  });
});

describe('REQ-BE-1.2.5', () => {
  it('T-E2E-FLOW-2 같은 이름·판 표기의 문서가 나중에 완료되면 먼저 문서는 교체되고 청크가 지워진다', async () => {
    const name = uniq('flow2');
    const edition = { label: 'v1', edition_date: '2026-01-01' };
    const first = await makeCompleted(name, edition);
    const second = await makeCompleted(name, edition);
    expect(second).not.toBe(first);
    const detail = (await getDoc(first)).body as { search_state: string };
    expect(detail.search_state).toBe('replaced');
    await waitFor(() =>
      fake.requests.some((r) => r.method === 'DELETE' && r.url === `/v1/documents/${first}`),
    );
    const logs = await request(baseUrl).get('/v1/logs').query({ doc_id: first, kind: 'replace' });
    expect((logs.body as { total: number }).total).toBe(1);
  });
});

/** 그 문서로 간 색인 요청 본문들이다. */
function indexRequestsOf(docId: string): Array<{
  version: string;
  force: boolean;
  assets: Array<{ placeholder_id: string; text: string }>;
}> {
  return fake.requests
    .filter((r) => r.method === 'POST' && r.url === '/v1/index-jobs')
    .map((r) => JSON.parse(r.body.toString('utf8')) as { doc_id: string })
    .filter((body) => body.doc_id === docId) as never;
}

describe('REQ-BE-1.7.1', () => {
  it('T-E2E-RIX-1 재색인은 202이고 새 버전을 강제로 색인 요청해 완료되면 검색 가능을 유지한다', async () => {
    const docId = await makeCompleted(uniq('rix1'));
    const res = await request(baseUrl).post(`/v1/documents/${docId}/reindex`);
    expect(res.status).toBe(202);
    await waitFor(() => indexRequestsOf(docId).some((req) => req.version === '2'));
    expect(indexRequestsOf(docId).find((req) => req.version === '2')?.force).toBe(true);
    await notify(docId, '2', 'succeeded', '2', 2);
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
    expect((await getDoc(docId)).body.search_state).toBe('searchable');
    // 선점이 끝난 뒤에는 다시 재색인할 수 있다(조건부 갱신이 상태를 되돌려 놓았다)
    expect((await request(baseUrl).post(`/v1/documents/${docId}/reindex`)).status).toBe(202);
  });
});

describe('REQ-BE-1.5.4', () => {
  it('T-E2E-EDIT-1 요약·캡션 편집은 새 버전을 색인 요청에 담고 색인 대기가 된다', async () => {
    const docId = await uploadOne(
      uniq('edit1'),
      `# 문서

${TABLE_MD}`,
    );
    await waitIndexRequest(docId);
    await notify(docId, '1', 'succeeded', '1', 1);
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
    const detail = (await getDoc(docId)).body as { assets: Array<{ placeholder_id: string }> };
    const placeholder = detail.assets[0].placeholder_id;
    const res = await request(baseUrl)
      .patch(`/v1/documents/${docId}`)
      .send({ assets: [{ placeholder_id: placeholder, text: '직접 고친 요약' }] });
    expect(res.status).toBe(200);
    expect(res.body.processing_state).toBe('queued');
    await waitFor(() => indexRequestsOf(docId).some((req) => req.version === '2'));
    const sent = indexRequestsOf(docId).find((req) => req.version === '2');
    expect(sent?.force).toBe(false);
    expect(sent?.assets).toContainEqual({ placeholder_id: placeholder, text: '직접 고친 요약' });
    await notify(docId, '2', 'succeeded', '2', 2);
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
  });
});

describe('REQ-BE-1.8.4', () => {
  it('T-E2E-RETRY-1 표시가 남은 문서를 주기 작업이 실제 MongoDB 조건으로 찾아 다시 요청하고 표시를 지운다', async () => {
    const meta = await seedDocument({
      name: uniq('retry-meta'),
      pendingRag: { deleteChunks: false, metadata: true },
    });
    const gone = await seedDocument({
      name: uniq('retry-del'),
      deleted: true,
      pendingRag: { deleteChunks: true, metadata: false },
    });
    await waitFor(
      () =>
        fake.requests.some(
          (r) => r.method === 'PUT' && r.url === `/v1/documents/${meta.docId}/metadata`,
        ),
      10_000,
    );
    await waitFor(
      () =>
        fake.requests.some((r) => r.method === 'DELETE' && r.url === `/v1/documents/${gone.docId}`),
      10_000,
    );
    await waitFor(async () => {
      const a = await harness.db.collection('documents').findOne({ docId: meta.docId });
      const b = await harness.db.collection('documents').findOne({ docId: gone.docId });
      return a?.pendingRag?.metadata === false && b?.purged === true;
    }, 10_000);
  });
});

describe('REQ-BE-7.1.2', () => {
  it('T-E2E-VAL-1 doc_id 형식이 틀리면 400이고 replacement-check는 경로 파라미터로 잡히지 않는다', async () => {
    const message = expectError(
      await request(baseUrl).get('/v1/documents/e2e-doc'),
      400,
      'INVALID_REQUEST',
    );
    expect(message).toContain('doc_id');
    const check = await request(baseUrl)
      .get('/v1/documents/replacement-check')
      .query({ name: 'x' });
    expect(check.status).toBe(200);
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-E2E-LOGH-1 이름·판 표기·MD·파일 이름·편집 값이 로그에 남지 않는다', async () => {
    const docId = await uploadOne(
      SENT.name,
      `# ${SENT.md}\n\n${SENT.md}`,
      { label: SENT.label, edition_date: '2026-01-01' },
      SENT.file,
    );
    await waitIndexRequest(docId);
    await notify(docId, '1', 'succeeded', '1', 1);
    await waitFor(async () => (await getDoc(docId)).body.processing_state === 'completed');
    const edit = await request(baseUrl).patch(`/v1/documents/${docId}`).send({ name: SENT.edited });
    expect(edit.status).toBe(200);
    await waitFor(() =>
      fake.requests.some((r) => r.method === 'PUT' && r.url === `/v1/documents/${docId}/metadata`),
    );
    expect((await request(baseUrl).delete(`/v1/documents/${docId}`)).status).toBe(204);
    await waitFor(() =>
      fake.requests.some((r) => r.method === 'DELETE' && r.url === `/v1/documents/${docId}`),
    );
    const text = capture.lines.join('\n');
    for (const sentinel of Object.values(SENT)) expect(text).not.toContain(sentinel);
  });
});
