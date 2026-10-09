import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Body, Controller, Get, Param, Post, UploadedFiles } from '@nestjs/common';
import { IsInt, IsString } from 'class-validator';
import request from 'supertest';
import { LogsService } from '../src/logs';
import {
  AnswerSpanNotFoundError,
  AssetNotFoundError,
  DocumentLockedError,
  DocumentNotFoundError,
  DocumentNotSearchableError,
  EvaluationInProgressError,
  GoldenSetNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
  RagUnavailableError,
  UnauthorizedError,
  UnsupportedFileError,
} from '../src/common';
import type { DomainError } from '../src/common';
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
import { buildMultipart, rawRequest } from './support/multipart';

jest.setTimeout(30_000);

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

/** 파일 객체 모양이다. */
interface ProbeFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const probeCalls: string[] = [];

class ProbeBodyDto {
  @IsString() name!: string;
  @IsInt() count!: number;
}

/** 12개 코드와 그 common 오류 클래스다. */
const CODE_CLASSES: Record<string, new () => DomainError> = {
  INVALID_REQUEST: InvalidRequestError,
  UNSUPPORTED_FILE: UnsupportedFileError,
  ANSWER_SPAN_NOT_FOUND: AnswerSpanNotFoundError,
  UNAUTHORIZED: UnauthorizedError,
  DOCUMENT_NOT_FOUND: DocumentNotFoundError,
  ASSET_NOT_FOUND: AssetNotFoundError,
  GOLDEN_SET_NOT_FOUND: GoldenSetNotFoundError,
  DOCUMENT_LOCKED: DocumentLockedError,
  DOCUMENT_NOT_SEARCHABLE: DocumentNotSearchableError,
  EVALUATION_IN_PROGRESS: EvaluationInProgressError,
  PAYLOAD_TOO_LARGE: PayloadTooLargeError,
  RAG_UNAVAILABLE: RagUnavailableError,
};

/** API.md 「오류 코드」 상태 표다. */
const STATUS_TABLE: Record<string, number> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_FILE: 400,
  ANSWER_SPAN_NOT_FOUND: 400,
  UNAUTHORIZED: 401,
  DOCUMENT_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  GOLDEN_SET_NOT_FOUND: 404,
  DOCUMENT_LOCKED: 409,
  DOCUMENT_NOT_SEARCHABLE: 409,
  EVALUATION_IN_PROGRESS: 409,
  PAYLOAD_TOO_LARGE: 413,
  RAG_UNAVAILABLE: 503,
};

/** 테스트 전용 컨트롤러다. ★ src/에 두지 않는다 */
@Controller('v1/__e2e__')
class ApiProbeController {
  /** multipart 탐침: 받은 파일을 요약해 돌려준다. */
  @Post('multipart')
  multipart(
    @UploadedFiles() files: ProbeFile[] | undefined,
    // ★ 메타타입이 Object라 전역 ValidationPipe가 검증하지 않는다
    @Body() body: Record<string, unknown>,
  ) {
    probeCalls.push('multipart');
    return {
      count: files?.length ?? 0,
      files: (files ?? []).map((f) => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        bufferLength: f.buffer.length,
      })),
      meta: body.meta ?? null,
    };
  }

  /** 검증 탐침 */
  @Post('validate')
  validate(@Body() body: ProbeBodyDto) {
    probeCalls.push('validate');
    return { ok: true, body };
  }

  /** 도메인 오류 탐침: kind에 맞는 오류를 던진다. */
  @Get('throw/:kind')
  throwIt(@Param('kind') kind: string): never {
    const Cls = CODE_CLASSES[kind];
    if (Cls !== undefined) throw new Cls();
    throw new Error('SECRET-7f3a C:\\secret\\path SELECT * FROM t');
  }
}

interface ApiEndpoint {
  method: string;
  path: string;
  module: string;
  list?: true;
}

/** API.md 「엔드포인트 목록」. 경로 변수는 e2e용 값으로 채운다. */
/** list: true는 API.md에서 page·page_size를 받는 목록 엔드포인트다(BOOT-3이 API.md와 대조한다) */
const API_ENDPOINTS: readonly ApiEndpoint[] = [
  { method: 'POST', path: '/v1/documents', module: 'documents' },
  { method: 'GET', path: '/v1/documents', module: 'documents', list: true },
  { method: 'GET', path: '/v1/document-names', module: 'documents' },
  { method: 'GET', path: '/v1/documents/replacement-check?name=e2e', module: 'documents' },
  { method: 'GET', path: '/v1/documents/e2e-doc', module: 'documents' },
  { method: 'GET', path: '/v1/documents/e2e-doc/original', module: 'documents' },
  { method: 'GET', path: '/v1/documents/e2e-doc/chunks', module: 'documents' },
  { method: 'GET', path: '/v1/documents/e2e-doc/versions/1/assets/e2e-ph', module: 'assets' },
  { method: 'PATCH', path: '/v1/documents/e2e-doc', module: 'documents' },
  { method: 'POST', path: '/v1/documents/e2e-doc/contents', module: 'documents' },
  { method: 'POST', path: '/v1/documents/e2e-doc/reindex', module: 'documents' },
  { method: 'DELETE', path: '/v1/documents/e2e-doc', module: 'documents' },
  { method: 'POST', path: '/v1/search', module: 'search' },
  { method: 'GET', path: '/v1/golden-sets', module: 'evaluation', list: true },
  { method: 'POST', path: '/v1/golden-sets', module: 'evaluation' },
  { method: 'DELETE', path: '/v1/golden-sets/e2e-gs', module: 'evaluation' },
  { method: 'POST', path: '/v1/golden-sets/e2e-gs/evaluate', module: 'evaluation' },
  { method: 'POST', path: '/v1/golden-sets/evaluate-all', module: 'evaluation' },
  { method: 'GET', path: '/v1/evaluation-summary', module: 'evaluation' },
  { method: 'GET', path: '/v1/logs', module: 'logs', list: true },
  { method: 'POST', path: '/v1/internal/rag-events', module: 'indexing' },
];

/** ★ 아직 AppModule에 없는 모듈이다. 지금은 없다 */
const PENDING_MODULES = new Set<string>();

/** 살아 있는(AppModule에 들어온) 목록 엔드포인트다. ★ 모듈이 들어오면 PENDING_MODULES에서 빼면 자동으로 포함된다 */
const LIST_ENDPOINTS = API_ENDPOINTS.filter(
  (row) => row.list === true && !PENDING_MODULES.has(row.module),
).map((row) => row.path);

const INTERNAL_MESSAGE = '서버에서 예상하지 못한 오류가 발생했습니다';

let harness: AppHarness;
let fake: FakeRagServer;
let tmpDir: string;
let dbName: string;
let baseUrl: string;

beforeAll(async () => {
  await assertMongoReachable();
  fake = await startFakeRagServer();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-api-e2e-'));
  dbName = createTestDbName();
  // ★ overrideModule(CommonModule)로(설정과 로거를 함께) .env·process.env를 막고 로그를 캡처한다
  harness = await bootAppHarness({
    env: {
      MONGODB_URI: testMongoUri(dbName),
      RAG_SERVER_URL: fake.baseUrl,
      FILE_STORAGE_DIR: tmpDir,
      LOG_RETENTION_DAYS: '3650',
      UPLOAD_MAX_FILES: '3',
      UPLOAD_MAX_MD_BYTES: '1000',
      UPLOAD_MAX_IMAGE_BYTES: '2000',
      UPLOAD_MAX_TOTAL_BYTES: '20000',
    },
    stream: capture.stream,
    controllers: [ApiProbeController],
  });
  baseUrl = `http://127.0.0.1:${harness.port}`;
});

beforeEach(() => {
  capture.clear();
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  if (dbName !== undefined) await dropTestDb(dbName);
  if (tmpDir !== undefined) await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 오류 본문이 키 `error` 하나이고 그 안이 code·message 둘뿐임을 단언한다. */
function expectErrorShape(body: unknown, code: string, message?: string): void {
  const typed = body as { error: { code: string; message: string } };
  expect(Object.keys(typed)).toEqual(['error']);
  expect(Object.keys(typed.error).sort()).toEqual(['code', 'message']);
  expect(typed.error.code).toBe(code);
  expect(typed.error.message).toMatch(/[가-힣]/);
  if (message !== undefined) expect(typed.error.message).toBe(message);
}

/** `api.`로 시작하는 로그 줄만 JSON으로 읽는다. ★ pino-http 요청 줄은 쿼리가 있어 뺀다 */
function apiLogs(): Record<string, unknown>[] {
  return capture
    .parsed()
    .filter((line) => typeof line.msg === 'string' && line.msg.startsWith('api.'));
}

/** 지정 크기의 파일 파트다. */
function filePart(filename: string, size: number, name = 'files') {
  return {
    name,
    filename,
    contentType: 'application/octet-stream',
    content: Buffer.alloc(size, 97),
  };
}

describe('REQ-BE-7.1.1', () => {
  it('T-E2E-BOOT-1 지금 있는 엔드포인트는 모두 경로가 있고 목록은 21행이다', async () => {
    expect(API_ENDPOINTS).toHaveLength(21);
    const live = API_ENDPOINTS.filter((row) => !PENDING_MODULES.has(row.module));
    expect(live.length).toBeGreaterThanOrEqual(1);
    // ★ 아직 없는 모듈은 404 NOT_FOUND여야 한다. 모듈이 들어오면 이 단언이 깨져 PENDING_MODULES 갱신을 강제한다
    for (const row of API_ENDPOINTS.filter((r) => PENDING_MODULES.has(r.module))) {
      const res = await request(baseUrl)[row.method.toLowerCase() as 'get'](row.path);
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'NOT_FOUND');
    }
    for (const row of live) {
      const res = await request(baseUrl)[row.method.toLowerCase() as 'get'](row.path);
      const notFound =
        res.status === 404 &&
        (res.body as { error?: { code?: string } }).error?.code === 'NOT_FOUND';
      expect(notFound).toBe(false);
      if (row.path === '/v1/logs') expect(res.status).toBe(200);
      // ★ indexing은 토큰 가드가 먼저 막으므로 토큰 없는 알림은 실제 401이다
      if (row.path === '/v1/internal/rag-events') {
        expect(res.status).toBe(401);
        expectErrorShape(res.body, 'UNAUTHORIZED');
      }
      // ★ 본문 없는 검색은 검증 오류다
      if (row.path === '/v1/search') {
        expect(res.status).toBe(400);
        expectErrorShape(res.body, 'INVALID_REQUEST');
      }
      // ★ 평가 엔드포인트의 기대 상태다
      if (row.method === 'GET' && row.path === '/v1/golden-sets') expect(res.status).toBe(200);
      if (row.method === 'POST' && row.path === '/v1/golden-sets') {
        expect(res.status).toBe(400);
        expectErrorShape(res.body, 'INVALID_REQUEST');
      }
      if (row.method === 'DELETE' && row.path === '/v1/golden-sets/e2e-gs') {
        expect(res.status).toBe(404);
        expectErrorShape(res.body, 'GOLDEN_SET_NOT_FOUND');
      }
      if (row.method === 'POST' && row.path === '/v1/golden-sets/e2e-gs/evaluate') {
        expect(res.status).toBe(404);
        expectErrorShape(res.body, 'GOLDEN_SET_NOT_FOUND');
      }
      if (row.method === 'POST' && row.path === '/v1/golden-sets/evaluate-all') {
        expect(res.status).toBe(202);
      }
      if (row.method === 'GET' && row.path === '/v1/evaluation-summary') {
        expect(res.status).toBe(200);
      }
    }
  });

  it('T-E2E-BOOT-3 엔드포인트 표와 목록 표시가 API.md와 일치한다', () => {
    const doc = fsSync.readFileSync(path.join(__dirname, '..', 'API.md'), 'utf-8');
    // 「엔드포인트 목록」 표의 `METHOD` | `경로` 행
    const rowPattern = /^\| `(GET|POST|PATCH|PUT|DELETE)` \| `([^`]+)` \|/gm;
    const rows = [...doc.matchAll(rowPattern)].map((m) => ({
      method: m[1],
      template: m[2],
      pattern: new RegExp(`^${m[2].replace(/\{[^}]+\}/g, '[^/?]+')}([?].*)?$`),
      braces: (m[2].match(/\{/g) ?? []).length,
    }));
    expect(rows).toHaveLength(API_ENDPOINTS.length);
    const sections = doc.split(/^### /m).slice(1);
    // e2e 경로마다 가장 구체적인(경로 변수가 가장 적은) API.md 행 하나에 대응시키고, 행마다 정확히 하나씩 대응해야 한다
    const owners = API_ENDPOINTS.map((e) => {
      const candidates = rows
        .filter((r) => r.method === e.method && r.pattern.test(e.path))
        .sort((a, b) => a.braces - b.braces);
      expect(candidates.length).toBeGreaterThan(0);
      return { endpoint: e, row: candidates[0] };
    });
    for (const row of rows) {
      const owned = owners.filter((o) => o.row === row);
      expect(owned).toHaveLength(1);
      // 상세 절에 page_size가 있으면 목록 엔드포인트다
      const head = '`' + row.method + ' ' + row.template + '`';
      const section = sections.find((s) => s.startsWith(head));
      expect(section).toBeDefined();
      expect(owned[0].endpoint.list === true).toBe((section ?? '').includes('page_size'));
    }
  });

  it('T-E2E-BOOT-2 전역 접두사가 없다', async () => {
    expect((await request(baseUrl).get('/v1/logs')).status).toBe(200);
    for (const url of ['/api/v1/logs', '/logs']) {
      const res = await request(baseUrl).get(url);
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'NOT_FOUND');
    }
  });

  it('T-E2E-MP-1 파일 3개와 텍스트 필드를 UTF-8 이름 그대로 컨트롤러에 넘긴다', async () => {
    const meta = '[{"name":"x"}]';
    const res = await request(baseUrl)
      .post('/v1/__e2e__/multipart')
      .attach('files', Buffer.alloc(1000, 97), '한글 문서.md')
      .attach('files', Buffer.alloc(2000, 98), 'b.png')
      .attach('files', Buffer.alloc(1, 99), 'c.md')
      .field('meta', meta);
    expect(res.status).toBe(201);
    const body = res.body as {
      count: number;
      meta: string;
      files: Array<{ fieldname: string; originalname: string; size: number; bufferLength: number }>;
    };
    expect(body.count).toBe(3);
    expect(body.files.map((f) => f.originalname)).toEqual(['한글 문서.md', 'b.png', 'c.md']);
    expect(body.files.map((f) => f.size)).toEqual([1000, 2000, 1]);
    expect(body.files.map((f) => f.bufferLength)).toEqual([1000, 2000, 1]);
    expect(body.files.every((f) => f.fieldname === 'files')).toBe(true);
    expect(body.meta).toBe(meta);
  });

  it('T-E2E-MP-2 파일이 4개면 413이고 컨트롤러는 불리지 않는다', async () => {
    const before = probeCalls.filter((c) => c === 'multipart').length;
    let req = request(baseUrl).post('/v1/__e2e__/multipart');
    for (let i = 0; i < 4; i += 1) req = req.attach('files', Buffer.alloc(1, 97), `f${i}.md`);
    const res = await req;
    expect(res.status).toBe(413);
    expectErrorShape(res.body, 'PAYLOAD_TOO_LARGE', '파일은 한 요청에 3개까지 올릴 수 있습니다');
    expect(probeCalls.filter((c) => c === 'multipart').length).toBe(before);
  });

  it('T-E2E-MP-3 요청을 끝내지 않아도 파일 수 초과를 바로 413으로 닫는다', async () => {
    const boundary = 'bnd-mp3';
    const body = buildMultipart(
      boundary,
      [1, 2, 3, 4].map((i) => filePart(`f${i}.md`, 1)),
      false,
    );
    const res = await rawRequest(harness.port, {
      method: 'POST',
      path: '/v1/__e2e__/multipart',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      endRequest: false,
      timeoutMs: 3000,
    });
    expect(res.status).toBe(413);
    expectErrorShape(res.json(), 'PAYLOAD_TOO_LARGE');
    expect(res.headers.connection).toBe('close');
  });

  it('T-E2E-MP-4a 파일 하나는 한도(2000)까지 받고 넘으면 이름이 담긴 413이다', async () => {
    const ok = await request(baseUrl)
      .post('/v1/__e2e__/multipart')
      .attach('files', Buffer.alloc(2000, 97), '그림.png');
    expect(ok.status).toBe(201);
    const over = await request(baseUrl)
      .post('/v1/__e2e__/multipart')
      .attach('files', Buffer.alloc(2001, 97), '큰 그림.png');
    expect(over.status).toBe(413);
    expectErrorShape(
      over.body,
      'PAYLOAD_TOO_LARGE',
      '파일 하나의 크기 한도(2000바이트)를 넘었습니다: 큰 그림.png',
    );
  });

  it('T-E2E-MP-4b 파일 하나가 한도를 넘으면 요청을 끝내지 않아도 413으로 닫는다', async () => {
    const boundary = 'bnd-mp4b';
    const body = buildMultipart(boundary, [filePart('큰 그림.png', 2001)], false);
    const res = await rawRequest(harness.port, {
      method: 'POST',
      path: '/v1/__e2e__/multipart',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      endRequest: false,
      timeoutMs: 3000,
    });
    expect(res.status).toBe(413);
    expectErrorShape(res.json(), 'PAYLOAD_TOO_LARGE');
    expect(res.headers.connection).toBe('close');
  });

  it('T-E2E-MP-5 Content-Length가 한도를 넘으면 본문을 기다리지 않고 413이다', async () => {
    const res = await rawRequest(harness.port, {
      method: 'POST',
      path: '/v1/__e2e__/multipart',
      headers: {
        'content-type': 'multipart/form-data; boundary=bnd-mp5',
        'content-length': '20001',
      },
      endRequest: false,
      timeoutMs: 3000,
    });
    expect(res.status).toBe(413);
    expectErrorShape(
      res.json(),
      'PAYLOAD_TOO_LARGE',
      '요청 전체 크기 한도(20000바이트)를 넘었습니다',
    );
    expect(res.headers.connection).toBe('close');
  });

  it('T-E2E-MP-6 길이 헤더 없이 보낸 본문이 한도를 넘으면 요청을 끝내지 않아도 413이다', async () => {
    const boundary = 'bnd-mp6';
    const body = buildMultipart(
      boundary,
      [{ name: 'meta', content: Buffer.alloc(25000, 97) }],
      false,
    );
    const res = await rawRequest(harness.port, {
      method: 'POST',
      path: '/v1/__e2e__/multipart',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      endRequest: false,
      timeoutMs: 3000,
    });
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe('close');
    expectErrorShape(
      res.json(),
      'PAYLOAD_TOO_LARGE',
      '요청 전체 크기 한도(20000바이트)를 넘었습니다',
    );
  });

  it('T-E2E-MP-7 본문이 정확히 한도(20000바이트)면 받아들인다', async () => {
    const boundary = 'bnd-mp7';
    const base = buildMultipart(boundary, [filePart('a.md', 1000), { name: 'meta', content: '' }]);
    const pad = 20000 - base.length;
    expect(pad).toBeGreaterThan(0);
    const body = buildMultipart(boundary, [
      filePart('a.md', 1000),
      { name: 'meta', content: 'm'.repeat(pad) },
    ]);
    expect(body.length).toBe(20000);
    const res = await rawRequest(harness.port, {
      method: 'POST',
      path: '/v1/__e2e__/multipart',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': '20000',
      },
      body,
      endRequest: true,
      timeoutMs: 5000,
    });
    expect(res.status).toBe(201);
  });

  it('T-E2E-MP-8 files가 아닌 필드의 파일은 400이고 필드 이름을 담지 않는다', async () => {
    const res = await request(baseUrl)
      .post('/v1/__e2e__/multipart')
      .attach('other', Buffer.alloc(1, 97), 'a.md');
    expect(res.status).toBe(400);
    expectErrorShape(res.body, 'INVALID_REQUEST', '업로드 요청 형식이 올바르지 않습니다');
    expect(JSON.stringify(res.body)).not.toContain('other');
  });

  it('T-E2E-MP-9 닫는 경계 없이 끝난 multipart는 400이다', async () => {
    const boundary = 'bnd-mp9';
    const body = buildMultipart(boundary, [filePart('a.md', 10)], false);
    const res = await rawRequest(harness.port, {
      method: 'POST',
      path: '/v1/__e2e__/multipart',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      endRequest: true,
      timeoutMs: 5000,
    });
    expect(res.status).toBe(400);
    expectErrorShape(res.json(), 'INVALID_REQUEST');
  });
});

describe('REQ-BE-7.1.2', () => {
  it('T-E2E-VAL-1 잘못된 쿼리 값은 400이고 입력을 담지 않는다', async () => {
    const res = await request(baseUrl).get('/v1/logs').query({ page: 'SECRET-7f3a' });
    expect(res.status).toBe(400);
    expectErrorShape(res.body, 'INVALID_REQUEST');
    expect((res.body as { error: { message: string } }).error.message).toContain('page');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
  });

  it('T-E2E-VAL-2 모르는 쿼리 필드는 400이다', async () => {
    const res = await request(baseUrl).get('/v1/logs').query({ foo: 'SECRET-7f3a' });
    expect(res.status).toBe(400);
    expectErrorShape(res.body, 'INVALID_REQUEST');
    expect((res.body as { error: { message: string } }).error.message).toContain('foo');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
  });

  it('T-E2E-VAL-3 필수 본문 필드 누락은 400이고 컨트롤러가 불리지 않는다', async () => {
    const before = probeCalls.filter((c) => c === 'validate').length;
    const res = await request(baseUrl).post('/v1/__e2e__/validate').send({ count: 1 });
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('name');
    expect(probeCalls.filter((c) => c === 'validate').length).toBe(before);
  });

  it('T-E2E-VAL-4 타입 오류는 필드 이름만 담는다', async () => {
    const res = await request(baseUrl)
      .post('/v1/__e2e__/validate')
      .send({ name: 'SECRET-7f3a', count: 'SECRET-COUNT' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('count');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SECRET-7f3a');
    expect(text).not.toContain('SECRET-COUNT');
    expectErrorShape(res.body, 'INVALID_REQUEST');
  });

  it('T-E2E-VAL-5 모르는 본문 필드는 400이다', async () => {
    const res = await request(baseUrl)
      .post('/v1/__e2e__/validate')
      .send({ name: 'a', count: 1, extra: 'SECRET-7f3a' });
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain('extra');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-7f3a');
  });

  it('T-E2E-VAL-6 잘못된 JSON은 400 고정 문장이고 입력을 담지 않는다', async () => {
    const res = await request(baseUrl)
      .post('/v1/__e2e__/validate')
      .set('content-type', 'application/json')
      .send('{"name": SECRET-7f3a');
    expect(res.status).toBe(400);
    expectErrorShape(res.body, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SECRET-7f3a');
    expect(text).not.toContain('JSON');
  });

  it('T-E2E-VAL-7 달력에 없는 날짜는 400이고 입력을 담지 않는다', async () => {
    for (const query of [{ from: '2026-02-30' }, { to: '2026-13-01' }]) {
      const res = await request(baseUrl).get('/v1/logs').query(query);
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'INVALID_REQUEST', '날짜는 YYYY-MM-DD 형식이어야 합니다');
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('2026-02-30');
      expect(text).not.toContain('2026-13-01');
    }
  });

  it('T-E2E-VAL-8 검증 실패는 api.request_invalid를 남기고 날짜 오류는 남기지 않는다', async () => {
    capture.clear();
    await request(baseUrl).get('/v1/logs').query({ foo: 'SECRET-7f3a' });
    const logs = apiLogs();
    const invalid = logs.filter((log) => log.msg === 'api.request_invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].level).toBe(40);
    expect(invalid[0].path).toBe('/v1/logs');
    expect(invalid[0].fields).toEqual(['foo']);
    expect(JSON.stringify(logs)).not.toContain('SECRET-7f3a');
    capture.clear();
    await request(baseUrl).get('/v1/logs').query({ from: '2026-02-30' });
    expect(apiLogs().filter((log) => log.msg === 'api.request_invalid')).toHaveLength(0);
  });

  it('T-E2E-VAL-9 올바른 본문은 그대로 통과한다', async () => {
    const res = await request(baseUrl).post('/v1/__e2e__/validate').send({ name: 'a', count: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, body: { name: 'a', count: 2 } });
  });

  it.each([
    ['POST', '/v1/documents', 'multipart/mixed; boundary=x'],
    ['POST', '/v1/search', 'multipart/related; boundary=x'],
    ['POST', '/v1/golden-sets', 'multipart/related; boundary=x'],
  ])(
    'T-PR3-E2E-MP-1 form-data가 아닌 multipart는 %s %s에서 400 INVALID_REQUEST다',
    async (method, urlPath, contentType) => {
      const res = await rawRequest(harness.port, {
        method,
        path: urlPath,
        headers: { 'content-type': contentType },
        body: Buffer.from('--x--\r\n'),
        endRequest: true,
        timeoutMs: 5000,
      });
      expect(res.status).toBe(400);
      // ★ 500이 아니라 한국어 고정 문장의 400이어야 한다
      expectErrorShape(res.json(), 'INVALID_REQUEST', '업로드 요청 형식이 올바르지 않습니다');
    },
  );

  it.each(['multipart/', 'multipart/form-data; =x'])(
    'T-PR3-E2E-MP-2 형식이 깨진 multipart Content-Type %j는 500이 아니라 400 INVALID_REQUEST다',
    async (contentType) => {
      const res = await rawRequest(harness.port, {
        method: 'POST',
        path: '/v1/documents',
        headers: { 'content-type': contentType },
        body: Buffer.from('--x--\r\n'),
        endRequest: true,
        timeoutMs: 5000,
      });
      expect(res.status).toBe(400);
      expectErrorShape(res.json(), 'INVALID_REQUEST', '업로드 요청 형식이 올바르지 않습니다');
    },
  );
});

describe('REQ-BE-7.1.3', () => {
  it.each(LIST_ENDPOINTS)('T-E2E-PAGE-1 %s는 쿼리 없이 페이지 형식을 준다', async (url) => {
    const res = await request(baseUrl).get(url);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: unknown[];
      total: number;
      page: number;
      page_size: number;
    };
    expect(Object.keys(body).sort()).toEqual(['items', 'page', 'page_size', 'total']);
    expect(Array.isArray(body.items)).toBe(true);
    expect(Number.isInteger(body.total) && body.total >= 0).toBe(true);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
  });

  it.each(LIST_ENDPOINTS)('T-E2E-PAGE-2 %s는 허용 페이지 크기를 받는다', async (url) => {
    for (const size of [20, 50, 100]) {
      const res = await request(baseUrl).get(url).query({ page_size: size, page: 2 });
      expect(res.status).toBe(200);
      expect((res.body as { page_size: number }).page_size).toBe(size);
      expect((res.body as { page: number }).page).toBe(2);
    }
  });

  it.each(LIST_ENDPOINTS)('T-E2E-PAGE-3 %s는 허용 밖 페이지 값을 400으로 거부한다', async (url) => {
    for (const size of ['10', '30', '101', '0', 'abc']) {
      const res = await request(baseUrl).get(url).query({ page_size: size });
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'INVALID_REQUEST');
      expect((res.body as { error: { message: string } }).error.message).toContain('page_size');
    }
    for (const page of ['0', '-1', '1.5']) {
      const res = await request(baseUrl).get(url).query({ page });
      expect(res.status).toBe(400);
      expectErrorShape(res.body, 'INVALID_REQUEST');
      expect((res.body as { error: { message: string } }).error.message).toContain('page');
    }
  });

  it('T-E2E-PAGE-4 시작 시점 total에 25건을 더하면 total이 그만큼 늘고 2쪽 개수가 맞다', async () => {
    // ★ 다른 단계가 남긴 기록에 기대지 않도록 시작 시점의 total을 기준으로 삼는다
    const before = await request(baseUrl).get('/v1/logs');
    const base = (before.body as { total: number }).total;
    const logs = harness.app.get(LogsService);
    for (let i = 0; i < 25; i += 1) {
      await logs.record({
        kind: 'upload',
        docId: `doc-page-${i}`,
        name: `문서 ${i}`,
        editionLabel: null,
        outcome: 'success',
      });
    }
    const res = await request(baseUrl).get('/v1/logs').query({ page_size: 20, page: 2 });
    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[]; total: number };
    expect(body.total).toBe(base + 25);
    expect(body.items).toHaveLength(Math.min(20, base + 25 - 20));
  });
});

describe('REQ-BE-8.3.1', () => {
  it.each(Object.keys(CODE_CLASSES))(
    'T-E2E-ERR-1 %s는 표의 상태와 오류 본문으로 응답한다',
    async (code) => {
      const res = await request(baseUrl).get(`/v1/__e2e__/throw/${code}`);
      expect(res.status).toBe(STATUS_TABLE[code]);
      expectErrorShape(res.body, code);
      expect(res.headers['content-type']).toContain('application/json');
    },
  );
});

describe('REQ-BE-8.3.2', () => {
  it('T-E2E-ERR-2 예상 못한 오류는 500 고정 문장이고 입력·스택이 응답에 없다', async () => {
    const res = await request(baseUrl).get('/v1/__e2e__/throw/unhandled').query({ q: 'SECRET-Q' });
    expect(res.status).toBe(500);
    expectErrorShape(res.body, 'INTERNAL_ERROR', INTERNAL_MESSAGE);
    const text = JSON.stringify(res.body);
    for (const forbidden of ['SECRET-7f3a', 'SECRET-Q', 'secret\\\\path', 'SELECT', ' at ']) {
      expect(text).not.toContain(forbidden);
    }
    const unhandledLogs = apiLogs().filter((log) => log.msg === 'api.unhandled');
    expect(unhandledLogs).toHaveLength(1);
    const log = unhandledLogs[0];
    expect(log.level).toBe(50);
    expect(log.path).toBe('/v1/__e2e__/throw/unhandled');
    expect(log.errorName).toBe('Error');
    expect(log.stack as string).toContain('at ');
    const line = JSON.stringify(log);
    expect(line).not.toContain('SECRET-7f3a');
    expect(line).not.toContain('SECRET-Q');
  });

  it('T-E2E-ERR-3 / T-E2E-ERR-4 JSON 본문이 너무 크면 413 고정 문장이다', async () => {
    const res = await request(baseUrl)
      .post('/v1/logs')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ filler: 'x'.repeat(150 * 1024) }));
    expect(res.status).toBe(413);
    expectErrorShape(res.body, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다');
  });
});

// 없는 경로
describe('REQ-BE-7.1.1', () => {
  it('T-E2E-ERR-5 없는 경로·없는 메서드는 404 NOT_FOUND이고 입력을 담지 않는다', async () => {
    capture.clear();
    for (const res of [
      await request(baseUrl).get('/v1/nope').query({ q: 'SECRET-7f3a' }),
      await request(baseUrl).delete('/v1/logs'),
    ]) {
      expect(res.status).toBe(404);
      expectErrorShape(res.body, 'NOT_FOUND', '요청한 경로를 찾을 수 없습니다');
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('SECRET-7f3a');
      expect(text).not.toContain('Cannot');
      expect(text).not.toContain('/v1/nope');
    }
    expect(apiLogs().filter((log) => log.msg === 'api.unhandled')).toHaveLength(0);
  });
});

// 거부 뒤 서버 상태. ★ 파일의 마지막 describe다. 앞의 거부들이 처리되지 않은 Promise 거부를 남기지 않았는지 본다
describe('REQ-BE-7.1.1', () => {
  it('T-E2E-MP-10 거부들 뒤에도 서버가 정상이다', async () => {
    // ★ Jest 안에서는 unhandledRejection 스파이가 호출되지 않는다. 처리되지 않은 거부는
    //   jest-circus가 그 시점에 실행 중인 테스트를 실패시키므로, 거부가 날 시간을 준 뒤 서버 정상만 확인한다
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await request(baseUrl).get('/v1/logs');
    expect(res.status).toBe(200);
  });
});
