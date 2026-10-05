import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { AssetsService } from '../src/assets';
import type { HintContext, UploadedImage } from '../src/assets';
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>', 'utf8');
const TABLE1 = '| 키 | 값 |\n| --- | --- |\n| a | b |';
const TABLE2 = '| x |\n| --- |\n| y |';
/** 표·짝 있는 이미지·표 순서의 문서다. 자리표시 ID는 t1, i1, t2다 */
const HINT_MD = [TABLE1, '![A](a.png)', TABLE2].join('\n\n');
const SENTINELS = {
  cell: 'TBL-SENT-71',
  alt: 'ALT-SENT-72',
  path: 'path-sent-73.png',
  caption: 'CAP-SENT-74',
};

/** 폴더 아래 모든 파일의 상대 경로를 모은다. 폴더가 없으면 빈 목록이다 */
async function listFilesUnder(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory()
        ? (await listFilesUnder(path.join(dir, entry.name))).map((f) => path.join(entry.name, f))
        : [entry.name],
    ),
  );
  return nested.flat();
}

let harness: AppHarness;
let fake: FakeRagServer;
let assets: AssetsService;
let tmpDir: string;
let dbName: string;
let baseUrl: string;
/** 가짜 RAG 응답 순번 */
let counter = 0;

/** 업로드 이미지를 만든다. */
function up(
  fileName: string,
  data: Buffer,
  contentType = 'application/octet-stream',
): UploadedImage {
  return { fileName, contentType, data };
}

/** shouldContinue가 차례로 값을 돌려주는 컨텍스트를 만든다. 다 쓰면 true다. */
function ctx(answers: boolean[] = []): HintContext {
  const queue = [...answers];
  return {
    name: 'e2e 문서',
    editionLabel: null,
    shouldContinue: async () => (queue.length > 0 ? (queue.shift() as boolean) : true),
  };
}

/** 가짜 RAG가 성공 응답을 주게 한다. */
function ragSucceeds(): void {
  fake.setHandler((req) =>
    req.url === '/v1/captions/table'
      ? { status: 200, json: { summary: `표 요약 ${++counter}` } }
      : { status: 200, json: { caption: `캡션 ${++counter}` } },
  );
}

/** 가짜 RAG가 모두 502 CAPTION_FAILED로 실패하게 한다. */
function ragFails(): void {
  fake.setHandler(() => ({
    status: 502,
    json: { error: { code: 'CAPTION_FAILED', message: '실패' } },
  }));
}

/** 이진 응답을 그대로 받는다. */
async function getBinary(urlPath: string): Promise<request.Response> {
  return request(baseUrl)
    .get(urlPath)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-assets-e2e-'));
  dbName = createTestDbName();
  harness = await bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
    },
    stream: capture.stream,
  });
  assets = harness.app.get(AssetsService);
  baseUrl = `http://127.0.0.1:${harness.port}`;
});

afterEach(() => {
  fake.reset();
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  if (dbName) await dropTestDb(dbName);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('REQ-BE-2.4.1', () => {
  /** e2e-a 문서: png·jpg·svg 이미지, 짝 없는 이미지, 표 하나 */
  const MD_A = [
    '| a | b |\n| - | - |\n| 1 | 2 |',
    '![p](p.png)',
    '![j](j.jpg)',
    '![s](s.svg)',
    '![n](gone.png)',
  ].join('\n\n');

  beforeAll(async () => {
    await assets.prepareVersion('e2e-a', '1', MD_A, [
      up('p.png', PNG),
      up('j.jpg', JPG),
      up('s.svg', SVG),
    ]);
  });

  it('T-E2E-IMG-1 이미지 주소로 GET하면 200과 같은 바이트, 올바른 Content-Type·보안 헤더를 준다', async () => {
    const urls = await assets.imageUrls('e2e-a', '1');
    expect(urls['gone.png']).toBeNull();
    const expected: Array<[string, Buffer, string]> = [
      ['p.png', PNG, 'image/png'],
      ['j.jpg', JPG, 'image/jpeg'],
      ['s.svg', SVG, 'image/svg+xml'],
    ];
    for (const [key, data, type] of expected) {
      const url = urls[key] as string;
      expect(url).toMatch(/^\/v1\//);
      const res = await getBinary(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body as Buffer).equals(data)).toBe(true);
      expect(String(res.headers['content-type']).startsWith(type)).toBe(true);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    }
  });

  it('T-E2E-IMG-2 이어받은 버전의 주소도 원래 바이트를 주고 파일은 복사하지 않는다', async () => {
    await assets.inheritVersion('e2e-a', '1', '2', new Map());
    const res = await getBinary('/v1/documents/e2e-a/versions/2/assets/i1');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).equals(PNG)).toBe(true);
    // 폴더가 없거나, 있어도 그 아래 파일이 없으면 복사하지 않은 것이다
    expect(await listFilesUnder(path.join(tmpDir, 'e2e-a', '2'))).toEqual([]);
  });

  it.each([
    ['없는 자리표시 ID', '/v1/documents/e2e-a/versions/1/assets/i99'],
    ['형식이 틀린 ID', '/v1/documents/e2e-a/versions/1/assets/I-1'],
    ['표 ID', '/v1/documents/e2e-a/versions/1/assets/t1'],
    ['짝 없는 이미지 ID', '/v1/documents/e2e-a/versions/1/assets/i4'],
    ['없는 버전', '/v1/documents/e2e-a/versions/9/assets/i1'],
    ['없는 문서', '/v1/documents/e2e-none/versions/1/assets/i1'],
  ])('T-E2E-IMG-3 %s는 404 ASSET_NOT_FOUND와 한국어 메시지다', async (_label, urlPath) => {
    const res = await request(baseUrl).get(urlPath);
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string; message: string } };
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    expect(body.error.code).toBe('ASSET_NOT_FOUND');
    expect(body.error.message).toMatch(/[가-힣]/);
    for (const secret of [tmpDir, 'e2e-a/1', 'gone.png', 'p.png']) {
      expect(body.error.message).not.toContain(secret);
    }
  });

  it('T-E2E-IMG-3 256자를 넘는 경로 값은 400 INVALID_REQUEST다', async () => {
    const res = await request(baseUrl).get(
      `/v1/documents/e2e-a/versions/1/assets/${'i'.repeat(300)}`,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('T-E2E-IMG-4 레코드는 있는데 파일이 지워졌으면 404 ASSET_NOT_FOUND다', async () => {
    await assets.prepareVersion('e2e-gone', '1', '![p](p.png)', [up('p.png', PNG)]);
    await fs.rm(path.join(tmpDir, 'e2e-gone', '1', 'i1.png'));
    const res = await request(baseUrl).get('/v1/documents/e2e-gone/versions/1/assets/i1');
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('ASSET_NOT_FOUND');
  });

  it('T-E2E-IMG-5 문서·버전 ID에 공백·한글이 들어 있어도 인코딩된 주소로 200을 준다', async () => {
    await assets.prepareVersion('문서 한글', 'v 1', '![p](p.png)', [up('p.png', PNG)]);
    const urls = await assets.imageUrls('문서 한글', 'v 1');
    const res = await getBinary(urls['p.png'] as string);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).equals(PNG)).toBe(true);
  });
});

describe('REQ-BE-2.1.3', () => {
  it('T-E2E-DB-1 assets에 고유 인덱스가 있고 같은 키의 문서를 두 번 넣으면 두 번째가 실패한다', async () => {
    const collection = harness.db.collection('assets');
    const indexes = await collection.indexes();
    const found = indexes.find((index) => index.name === 'assets_doc_version_placeholder');
    expect(found).toBeDefined();
    expect(found?.unique).toBe(true);
    expect(found?.key).toEqual({ docId: 1, version: 1, placeholderId: 1 });

    await collection.insertOne({ docId: 'e2e-dup', version: '1', placeholderId: 't1' });
    await expect(
      collection.insertOne({ docId: 'e2e-dup', version: '1', placeholderId: 't1' }),
    ).rejects.toThrow();
  });

  it('T-E2E-DB-6 실제 MongoDB에서 같은 버전을 다시 준비하면 두 번째 결과만 남는다', async () => {
    const collection = harness.db.collection('assets');
    await assets.prepareVersion('e2e-redo', '1', [TABLE1, '![a](a.png)'].join('\n\n'), [
      up('a.png', PNG),
    ]);
    // 두 번째 문서가 더 짧다
    await assets.prepareVersion('e2e-redo', '1', '![b](b.png)', [up('b.png', JPG)]);
    expect(await collection.countDocuments({ docId: 'e2e-redo', version: '1' })).toBe(1);
    const views = await assets.listViews('e2e-redo', '1');
    expect(views.map((view) => view.placeholderId)).toEqual(['i1']);
    // 같은 문서로 한 번 더 해도 한 번 한 것과 같다
    await assets.prepareVersion('e2e-redo', '1', '![b](b.png)', [up('b.png', JPG)]);
    expect(await collection.countDocuments({ docId: 'e2e-redo', version: '1' })).toBe(1);
    expect(await assets.listViews('e2e-redo', '1')).toEqual(views);
  });

  it('T-E2E-DB-7 실제 MongoDB에서 같은 인자로 이어받기를 두 번 해도 한 번 한 것과 같다', async () => {
    ragSucceeds();
    const collection = harness.db.collection('assets');
    await assets.prepareVersion('e2e-twice', '1', HINT_MD, [up('a.png', PNG)]);
    await assets.generateHints('e2e-twice', '1', ctx());
    const changed = new Map([['t1', '새 요약']]);
    await assets.inheritVersion('e2e-twice', '1', '2', changed);
    const once = await assets.listViews('e2e-twice', '2');
    const countOnce = await collection.countDocuments({ docId: 'e2e-twice', version: '2' });
    await assets.inheritVersion('e2e-twice', '1', '2', changed);
    expect(await collection.countDocuments({ docId: 'e2e-twice', version: '2' })).toBe(countOnce);
    expect(countOnce).toBe(3);
    expect(await assets.listViews('e2e-twice', '2')).toEqual(once);
    expect(once.find((view) => view.placeholderId === 't1')?.text).toBe('새 요약');
  });
});

describe('REQ-BE-2.3.6', () => {
  it('T-E2E-DB-2 실제 MongoDB로 멈춘 뒤 이어서 하면 남은 것만 요청하고 모두 문장이 된다', async () => {
    ragSucceeds();
    await assets.prepareVersion('e2e-hint', '1', HINT_MD, [up('a.png', PNG)]);
    const first = await assets.generateHints('e2e-hint', '1', ctx([true, true, false]));
    expect(first).toMatchObject({ generated: 2, stopped: true });
    expect(fake.requests.map((req) => req.url)).toEqual([
      '/v1/captions/table',
      '/v1/captions/image',
    ]);

    const second = await assets.generateHints('e2e-hint', '1', ctx());
    expect(second).toMatchObject({ generated: 1, stopped: false });
    expect(fake.requests.map((req) => req.url)).toEqual([
      '/v1/captions/table',
      '/v1/captions/image',
      '/v1/captions/table',
    ]);
    const hints = await assets.hintsFor('e2e-hint', '1');
    expect(hints.map((hint) => hint.placeholderId)).toEqual(['t1', 'i1', 't2']);
    for (const hint of hints) expect(hint.text).toMatch(/^(표 요약|캡션) \d+$/);
  });
});

describe('REQ-BE-1.7.1', () => {
  it('T-E2E-DB-3 실제 MongoDB의 필터로 임시 설명 중 다시 만들 수 있는 것만 센다', async () => {
    const md = [TABLE1, '![A](a.png)', '![B](gone.png)', TABLE2].join('\n\n');
    await assets.prepareVersion('e2e-tmp', '1', md, [up('a.png', PNG)]);
    ragFails();
    const first = await assets.generateHints('e2e-tmp', '1', ctx());
    expect(first).toEqual({ generated: 4, temporary: 4, stopped: false });
    // 짝 없는 이미지는 RAG 요청이 없다
    expect(fake.requests).toHaveLength(3);

    // 짝 없는 이미지를 뺀 임시 수다
    expect(await assets.markTemporaryForRegeneration('e2e-tmp', '1')).toBe(3);

    ragSucceeds();
    const second = await assets.generateHints('e2e-tmp', '1', ctx());
    expect(second).toEqual({ generated: 3, temporary: 0, stopped: false });
    const views = await assets.listViews('e2e-tmp', '1');
    expect(views.map((view) => view.isTemporary)).toEqual([false, false, true, false]);
  });
});

describe('REQ-BE-2.5.1', () => {
  it('T-E2E-DB-4 실제 MongoDB로 복원하면 표 원문과 이미지 주소가 나오고 주소로 GET하면 200이다', async () => {
    ragSucceeds();
    const prepared = await assets.prepareVersion('e2e-rst', '1', HINT_MD, [up('a.png', PNG)]);
    await assets.generateHints('e2e-rst', '1', ctx());
    const restored = await assets.restore('e2e-rst', '1', prepared.indexingMarkdown);
    expect(restored).toContain(TABLE1);
    expect(restored).toContain(TABLE2);
    const match = /!\[캡션 \d+\]\((\/v1\/[^)]+)\)/.exec(restored);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('/v1/documents/e2e-rst/versions/1/assets/i1');
    const res = await getBinary(match?.[1] as string);
    expect(res.status).toBe(200);
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-E2E-DB-5 deleteDocument는 그 문서의 레코드·파일만 지운다', async () => {
    await assets.prepareVersion('e2e-del', '1', '![p](p.png)', [up('p.png', PNG)]);
    await assets.prepareVersion('e2e-keep', '1', '![p](p.png)', [up('p.png', PNG)]);
    await assets.deleteDocument('e2e-del');
    expect(await harness.db.collection('assets').countDocuments({ docId: 'e2e-del' })).toBe(0);
    // 빈 폴더 잔존은 명세 밖이다: 폴더가 없거나, 있어도 그 아래 파일이 없으면 통과
    expect(await listFilesUnder(path.join(tmpDir, 'e2e-del'))).toEqual([]);
    expect(await harness.db.collection('assets').countDocuments({ docId: 'e2e-keep' })).toBe(1);
    await expect(fs.access(path.join(tmpDir, 'e2e-keep', '1', 'i1.png'))).resolves.toBeUndefined();
  });
});

describe('REQ-BE-8.2.1', () => {
  // ★ 이 파일의 마지막 테스트다. 앞선 모든 테스트가 남긴 로그도 함께 본다
  it('T-E2E-LOG-1 표 칸·대체 텍스트·캡션·이미지 경로가 로그에 나오지 않는다', async () => {
    fake.setHandler((req) =>
      req.url === '/v1/captions/table'
        ? { status: 200, json: { summary: SENTINELS.caption } }
        : { status: 200, json: { caption: SENTINELS.caption } },
    );
    const md = [
      `| h |\n| --- |\n| ${SENTINELS.cell} |`,
      `![${SENTINELS.alt}](${SENTINELS.path})`,
    ].join('\n\n');
    const prepared = await assets.prepareVersion('e2e-sent', '1', md, [up(SENTINELS.path, PNG)]);
    await assets.generateHints('e2e-sent', '1', ctx());
    await assets.restore('e2e-sent', '1', prepared.indexingMarkdown);
    const urls = await assets.imageUrls('e2e-sent', '1');
    const res = await getBinary(urls[SENTINELS.path] as string);
    expect(res.status).toBe(200);

    expect(capture.lines.length).toBeGreaterThan(0);
    const all = capture.lines.join('\n');
    for (const sentinel of [SENTINELS.cell, SENTINELS.alt, SENTINELS.caption, 'path-sent-73']) {
      expect(all).not.toContain(sentinel);
    }
  });
});
