import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Db } from 'mongodb';
import request from 'supertest';
import { LogsModule, LogsService } from '../src/logs';
import { MONGO_DB } from '../src/storage';
import { createLogCapture } from './support/log-capture';
import {
  assertMongoReachable,
  createTestDbName,
  dropTestDb,
  testMongoUri,
} from './support/mongo-test-db';
import { createTestCommonModule } from './support/test-common.module';

jest.setTimeout(30_000);

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();
const createdDbs: string[] = [];
let tmpDir: string;
const openApps: INestApplication[] = [];

beforeAll(async () => {
  await assertMongoReachable();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-logs-e2e-'));
});

afterEach(async () => {
  // 앱이 같은 파일의 여러 테스트에서 공유될 수 있어 공유 앱은 각 그룹의 afterAll에서 닫는다
  while (openApps.length > 0) {
    await openApps.pop()?.close();
  }
});

afterAll(async () => {
  await Promise.all(createdDbs.map((name) => dropTestDb(name)));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 테스트 DB를 하나 정하고 정리 목록에 넣는다. */
function newTestDb(): string {
  const dbName = createTestDbName();
  createdDbs.push(dbName);
  return dbName;
}

/** LogsModule을 올리고 api 단계 전까지 쓰는 검증 파이프를 건다. */
async function bootApp(dbName: string, retentionDays = 3650): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      createTestCommonModule(
        {
          MONGODB_URI: testMongoUri(dbName),
          FILE_STORAGE_DIR: tmpDir,
          LOG_RETENTION_DAYS: retentionDays,
        },
        capture.stream,
      ),
      LogsModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  // ★ 전역 ValidationPipe·DomainErrorFilter는 api 단계가 만든다. 오류는 상태 코드 400까지만 단언한다
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init(); // onModuleInit(인덱스 준비)이 여기서 돈다
  return app;
}

/** 응답 항목 하나의 모양이다(검사에 쓰는 열만). */
interface Item {
  log_id: string;
  occurred_at: string;
  kind: string;
  document: { doc_id: string; name: string; edition_label: string | null };
  document_deleted: boolean;
  outcome: string;
  description: string;
}

interface ListBody {
  items: Item[];
  total: number;
  page: number;
  page_size: number;
}

/** 씨앗 기록 하나다(MODULE.md 데이터 모델 여덟 필드). */
function seed(
  logId: string,
  occurredAt: string,
  kind: string,
  docId: string,
  name: string,
  editionLabel: string | null,
  outcome: string,
): Record<string, unknown> {
  return {
    logId,
    occurredAt: new Date(occurredAt),
    kind,
    docId,
    name,
    editionLabel,
    outcome,
    description: `설명-${logId}`,
  };
}

/** 씨앗 데이터다. KST 날짜 경계를 걸치고, 이름이 같은 두 문서와 접두어가 같은 다른 이름을 둔다. */
function seedRecords(): Record<string, unknown>[] {
  const fixed = [
    seed('seed-01', '2026-10-02T15:00:00.000Z', 'upload', 'doc-a', '설계서', 'v1', 'success'),
    seed('seed-02', '2026-10-03T14:59:59.999Z', 'captioning', 'doc-a', '설계서', 'v1', 'failure'),
    seed(
      'seed-03',
      '2026-10-03T15:00:00.000Z',
      'processing_state',
      'doc-a',
      '설계서',
      'v1',
      'success',
    ),
    seed('seed-04', '2026-10-04T14:59:00.000Z', 'edit', 'doc-b', '설계서', 'v2', 'success'),
    seed('seed-05', '2026-10-04T15:00:00.000Z', 'delete', 'doc-c', '설계서 v2', null, 'success'),
    seed('seed-06', '2026-10-04T15:00:00.000Z', 'upload', 'doc-c', '설계서 v2', null, 'failure'),
    seed('seed-07', '2026-10-05T03:00:00.000Z', 'replace', 'doc-b', '설계서', 'v2', 'success'),
    seed(
      'seed-08',
      '2026-10-01T00:00:00.000Z',
      'content_upload',
      'doc-d',
      '운영 가이드',
      null,
      'success',
    ),
  ];
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  const pages = Array.from({ length: 25 }, (_, i) => {
    const id = `page-${String(i + 1).padStart(2, '0')}`;
    return seed(
      id,
      new Date(base + i * 60_000).toISOString(),
      'upload',
      'doc-p',
      '페이지용',
      null,
      'success',
    );
  });
  return [...fixed, ...pages];
}

/** 씨앗 로그 id 집합을 정렬해 돌려준다. */
function ids(body: ListBody): string[] {
  return body.items.map((item) => item.log_id).sort();
}

/** 씨앗을 넣은 앱을 describe 하나 동안 공유하고 요청 도우미를 돌려준다. */
function useSeededApp(): {
  get: (query: Record<string, string | string[]> | string) => request.Test;
  ok: (query: Record<string, string | string[]> | string) => Promise<ListBody>;
} {
  let app: INestApplication;

  beforeAll(async () => {
    const dbName = newTestDb();
    app = await bootApp(dbName);
    const db = app.get<Db>(MONGO_DB);
    await db.collection('logs').insertMany(seedRecords());
  });

  afterAll(async () => {
    await app.close();
  });

  /** GET /v1/logs를 보낸다. */
  function get(query: Record<string, string | string[]> | string): request.Test {
    const req = request(app.getHttpServer()).get('/v1/logs');
    return typeof query === 'string' ? req.query(query) : req.query(query);
  }

  /** 200 응답 본문을 준다. */
  async function ok(query: Record<string, string | string[]> | string): Promise<ListBody> {
    const res = await get(query).expect(200);
    return res.body as ListBody;
  }

  return { get, ok };
}

describe('REQ-BE-6.2.1', () => {
  const { get, ok } = useSeededApp();

  it('T-E2E-PAGE-1 기본 페이지는 20개이고 전체 개수가 25다', async () => {
    const body = await ok({ doc_id: 'doc-p' });
    expect(body.total).toBe(25);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.items).toHaveLength(20);
  });

  it('T-E2E-PAGE-2 2쪽은 5개다', async () => {
    const body = await ok({ doc_id: 'doc-p', page: '2' });
    expect(body.items).toHaveLength(5);
    expect(body.total).toBe(25);
    expect(body.page).toBe(2);
  });

  it('T-E2E-PAGE-3 page_size 50이면 25개, 3쪽은 비어 있다', async () => {
    const big = await ok({ doc_id: 'doc-p', page_size: '50' });
    expect(big.items).toHaveLength(25);
    const empty = await ok({ doc_id: 'doc-p', page: '3' });
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(25);
  });

  it('T-E2E-PAGE-4 total은 거른 결과의 수다', async () => {
    const body = await ok({ name: '설계서' });
    expect(body.total).toBe(5);
  });

  it('T-E2E-SORT-1 기본은 발생 시각 내림차순이다', async () => {
    const body = await ok({});
    const times = body.items.map((item) => Date.parse(item.occurred_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(body.items[0].log_id).toBe('seed-07');
    expect(body.items[0].occurred_at).toBe('2026-10-05T03:00:00Z');
  });

  it('T-E2E-SORT-2 order=asc는 오름차순이다', async () => {
    const body = await ok({ order: 'asc', page_size: '100' });
    const times = body.items.map((item) => Date.parse(item.occurred_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(body.items[0].log_id).toBe('page-01');
    expect(body.items[0].occurred_at).toBe('2026-09-01T00:00:00Z');
  });

  // 결정 6(CONTEXT.md): 정렬 열이 같으면 occurredAt 내림차순이 보조 정렬이다. MODULE.md에는 아직 없다
  it('T-E2E-SORT-3 kind 정렬은 코드 문자열 순이고 같은 종류 안은 최근 순이다', async () => {
    const body = await ok({
      kind: 'upload,delete,edit,replace',
      sort: 'kind',
      order: 'asc',
      page_size: '100',
    });
    expect(body.total).toBe(30);
    const kinds = body.items.map((item) => item.kind);
    expect(kinds.slice(0, 3)).toEqual(['delete', 'edit', 'replace']);
    expect(kinds.slice(3).every((kind) => kind === 'upload')).toBe(true);
    expect(body.items.slice(0, 3).map((item) => item.log_id)).toEqual([
      'seed-05',
      'seed-04',
      'seed-07',
    ]);
    const pageIds = Array.from({ length: 25 }, (_, i) => `page-${String(25 - i).padStart(2, '0')}`);
    expect(body.items.slice(3).map((item) => item.log_id)).toEqual([
      'seed-06',
      'seed-01',
      ...pageIds,
    ]);
  });

  it('T-E2E-SORT-4 outcome 정렬은 asc·desc 순서가 반대다', async () => {
    const asc = await ok({ doc_id: 'doc-c', sort: 'outcome', order: 'asc' });
    expect(asc.items.map((item) => item.log_id)).toEqual(['seed-06', 'seed-05']);
    const desc = await ok({ doc_id: 'doc-c', sort: 'outcome', order: 'desc' });
    expect(desc.items.map((item) => item.log_id)).toEqual(['seed-05', 'seed-06']);
  });

  it('T-E2E-SORT-6 kind 내림차순은 정렬 열 동률 구간이 페이지 경계를 가로질러도 순서가 이어진다', async () => {
    const query = { kind: 'upload,delete,edit,replace', sort: 'kind', order: 'desc' };
    const first = await ok({ ...query, page_size: '20' });
    const second = await ok({ ...query, page: '2', page_size: '20' });
    const pageIds = Array.from({ length: 25 }, (_, i) => `page-${String(25 - i).padStart(2, '0')}`);
    const expected = ['seed-06', 'seed-01', ...pageIds, 'seed-07', 'seed-04', 'seed-05'];

    expect(first.total).toBe(30);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(10);
    expect([...first.items, ...second.items].map((item) => item.log_id)).toEqual(expected);
  });

  // 결정 6(CONTEXT.md): 마지막 보조 정렬은 _id(삽입 순서)를 정렬 방향대로 쓴다
  it('T-E2E-SORT-7 발생 시각이 모두 같아도 페이지 경계에서 순서가 안정적이다', async () => {
    const app = await bootApp(newTestDb());
    openApps.push(app);
    const sameTime = '2026-10-01T00:00:00.000Z';
    const records = Array.from({ length: 25 }, (_, i) =>
      seed(
        `tie-${String(i + 1).padStart(2, '0')}`,
        sameTime,
        'upload',
        'doc-t',
        '동률',
        null,
        'success',
      ),
    );
    await app.get<Db>(MONGO_DB).collection('logs').insertMany(records);
    const fetch = async (order: string, page: string): Promise<string[]> => {
      const res = await request(app.getHttpServer())
        .get('/v1/logs')
        .query({ order, page, page_size: '20' })
        .expect(200);
      return (res.body as ListBody).items.map((item) => item.log_id);
    };
    const insertion = records.map((record) => record.logId as string);

    const desc = [...(await fetch('desc', '1')), ...(await fetch('desc', '2'))];
    const asc = [...(await fetch('asc', '1')), ...(await fetch('asc', '2'))];

    expect(desc).toEqual([...insertion].reverse());
    expect(asc).toEqual(insertion);
  });

  it.each([
    ['sort=name'],
    ['sort=occurredAt'],
    ['order=up'],
    ['page_size=30'],
    ['page=0'],
    ['page=abc'],
    ['unknown=1'],
  ])('T-E2E-SORT-5 잘못된 요청 %s는 400이다', async (query) => {
    await get(query).expect(400);
  });

  it('T-E2E-SHAPE-2 밀리초가 있는 발생 시각은 초 단위로 버려 내보낸다', async () => {
    const body = await ok({ doc_id: 'doc-a', order: 'asc' });
    const item = body.items.find((entry) => entry.log_id === 'seed-02');
    expect(item?.occurred_at).toBe('2026-10-03T14:59:59Z');
  });

  it('T-E2E-SHAPE-1 응답 형식이 API.md와 정확히 같다', async () => {
    const res = await get({ doc_id: 'doc-b', order: 'asc' }).expect(200);
    const body = res.body as ListBody;
    expect(Object.keys(body).sort()).toEqual(['items', 'page', 'page_size', 'total']);
    expect(body.items[0]).toEqual({
      log_id: 'seed-04',
      occurred_at: '2026-10-04T14:59:00Z',
      kind: 'edit',
      document: { doc_id: 'doc-b', name: '설계서', edition_label: 'v2' },
      document_deleted: false,
      outcome: 'success',
      description: '설명-seed-04',
    });
    const deleted = await ok({ doc_id: 'doc-c' });
    for (const item of deleted.items) {
      expect('edition_label' in item.document).toBe(true);
      expect(item.document.edition_label).toBeNull();
    }
  });
});

describe('REQ-BE-6.2.2', () => {
  const { get, ok } = useSeededApp();

  it('T-E2E-FILTER-1 kind 하나', async () => {
    expect(ids(await ok({ kind: 'edit' }))).toEqual(['seed-04']);
  });

  it('T-E2E-FILTER-2 kind 쉼표 목록', async () => {
    expect(ids(await ok({ kind: 'edit,replace' }))).toEqual(['seed-04', 'seed-07']);
  });

  it('T-E2E-FILTER-3 kind 반복 파라미터', async () => {
    expect(ids(await ok({ kind: ['edit', 'replace'] }))).toEqual(['seed-04', 'seed-07']);
  });

  // CONTEXT.md 「구현 결정」 kind 파싱: 빈 항목은 허용 값이 아니므로 400이다. MODULE.md·API.md에는 아직 없다
  it.each([['kind=other'], ['kind='], ['kind=edit,']])(
    'T-E2E-FILTER-4 잘못된 종류 %s는 400이다',
    async (query) => {
      await get(query).expect(400);
    },
  );

  it('T-E2E-FILTER-5 outcome 거르기', async () => {
    expect(ids(await ok({ outcome: 'failure' }))).toEqual(['seed-02', 'seed-06']);
    await get({ outcome: 'fail' }).expect(400);
  });

  it('T-E2E-FILTER-6 같은 날 from·to는 KST 하루를 모두 포함한다', async () => {
    const body = await ok({ from: '2026-10-04', to: '2026-10-04' });
    expect(ids(body)).toEqual(['seed-03', 'seed-04']);
  });

  it('T-E2E-FILTER-7 from만 주면 그 KST 날짜부터다', async () => {
    expect(ids(await ok({ from: '2026-10-05' }))).toEqual(['seed-05', 'seed-06', 'seed-07']);
  });

  it('T-E2E-FILTER-8 to 경계와 조합', async () => {
    expect(ids(await ok({ doc_id: 'doc-a', to: '2026-10-03' }))).toEqual(['seed-01', 'seed-02']);
    expect((await ok({ doc_id: 'doc-a', to: '2026-10-02' })).items).toEqual([]);
    expect(ids(await ok({ kind: 'captioning,content_upload', to: '2026-10-03' }))).toEqual([
      'seed-02',
      'seed-08',
    ]);
  });

  // CONTEXT.md 「구현 결정」 from > to: 오류가 아니라 빈 페이지다. 명세에 해당 오류가 없다
  it('T-E2E-FILTER-9 from이 to보다 늦으면 빈 결과다', async () => {
    const body = await ok({ from: '2026-10-05', to: '2026-10-04' });
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it.each([['from=2026-1-4'], ['to=20261004'], ['from=2026/10/04']])(
    'T-E2E-FILTER-10 날짜 형식 오류 %s는 400이다',
    async (query) => {
      await get(query).expect(400);
    },
  );

  it('T-E2E-FILTER-11 name은 정확히 같은 이름만 맞는다', async () => {
    expect(ids(await ok({ name: '설계서' }))).toEqual([
      'seed-01',
      'seed-02',
      'seed-03',
      'seed-04',
      'seed-07',
    ]);
  });

  it('T-E2E-FILTER-12 name은 부분 일치가 아니다', async () => {
    expect((await ok({ name: '설계' })).items).toEqual([]);
  });

  it('T-E2E-FILTER-13 doc_id 거르기', async () => {
    expect(ids(await ok({ doc_id: 'doc-a' }))).toEqual(['seed-01', 'seed-02', 'seed-03']);
  });

  it('T-E2E-FILTER-14 조건은 모두 함께 적용된다', async () => {
    const body = await ok({
      name: '설계서',
      kind: 'edit,replace,upload',
      outcome: 'success',
      from: '2026-10-04',
    });
    expect(ids(body)).toEqual(['seed-04', 'seed-07']);
  });

  it.each([['name[$ne]=x'], ['doc_id[$gt]=']])(
    'T-E2E-FILTER-15 연산자 주입 %s는 400이다',
    async (query) => {
      await get(query).expect(400);
    },
  );

  // 결정 2(CONTEXT.md): delete 기록(결과 무관)이 있으면 삭제됨이다
  it('T-E2E-DEL-1 delete 기록이 있는 문서의 모든 항목이 삭제됨이다', async () => {
    const deleted = await ok({ doc_id: 'doc-c' });
    expect(ids(deleted)).toEqual(['seed-05', 'seed-06']);
    expect(deleted.items.every((item) => item.document_deleted)).toBe(true);
    const alive = await ok({ doc_id: 'doc-a' });
    expect(alive.items.length).toBeGreaterThan(0);
    expect(alive.items.every((item) => !item.document_deleted)).toBe(true);
  });

  // 결정 2(CONTEXT.md)
  it('T-E2E-DEL-2 실패한 delete 기록도 삭제됨으로 본다', async () => {
    const app = await bootApp(newTestDb());
    openApps.push(app);
    const logs = app.get(LogsService);
    await logs.record({
      kind: 'upload',
      docId: 'doc-f',
      name: '삭제검사',
      editionLabel: null,
      outcome: 'success',
    });
    await logs.record({
      kind: 'delete',
      docId: 'doc-f',
      name: '삭제검사',
      editionLabel: null,
      outcome: 'failure',
    });
    await logs.record({
      kind: 'upload',
      docId: 'doc-g',
      name: '삭제검사',
      editionLabel: null,
      outcome: 'success',
    });

    const res = await request(app.getHttpServer())
      .get('/v1/logs')
      .query({ name: '삭제검사' })
      .expect(200);
    const body = res.body as ListBody;

    const byDoc = (docId: string): Item[] => body.items.filter((i) => i.document.doc_id === docId);
    expect(byDoc('doc-f')).toHaveLength(2);
    expect(byDoc('doc-f').every((item) => item.document_deleted)).toBe(true);
    expect(byDoc('doc-g')).toHaveLength(1);
    expect(byDoc('doc-g').every((item) => !item.document_deleted)).toBe(true);
  });
});

describe('REQ-BE-6.1.2', () => {
  it('T-E2E-REC-1 record한 기록이 조회로 돌아온다', async () => {
    const app = await bootApp(newTestDb());
    openApps.push(app);
    const before = Math.floor(Date.now() / 1000) * 1000;
    await app.get(LogsService).record({
      kind: 'captioning',
      docId: 'doc-r',
      name: '왕복',
      editionLabel: null,
      outcome: 'success',
      detail: { count: 3, failedCount: 1 },
    });
    const after = Date.now();

    const res = await request(app.getHttpServer())
      .get('/v1/logs')
      .query({ doc_id: 'doc-r' })
      .expect(200);
    const body = res.body as ListBody;

    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.kind).toBe('captioning');
    expect(item.document).toEqual({ doc_id: 'doc-r', name: '왕복', edition_label: null });
    expect(item.document_deleted).toBe(false);
    expect(item.outcome).toBe('success');
    expect(item.description).toBe('요약·캡션 3개를 만들었습니다 (임시 설명 1개)');
    expect(item.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const occurred = Date.parse(item.occurred_at);
    expect(occurred).toBeGreaterThanOrEqual(before);
    expect(occurred).toBeLessThanOrEqual(after);
  });

  it('T-E2E-REC-2 logId가 같은 기록은 중복 키 오류다', async () => {
    const app = await bootApp(newTestDb());
    openApps.push(app);
    const collection = app.get<Db>(MONGO_DB).collection('logs');
    const record = seed(
      'dup-1',
      '2026-10-01T00:00:00.000Z',
      'upload',
      'doc-x',
      '중복',
      null,
      'success',
    );

    await collection.insertOne({ ...record });

    await expect(collection.insertOne({ ...record })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('REQ-BE-6.3.1', () => {
  /** key가 정확히 { occurredAt: 1 }인 인덱스를 모은다. */
  async function ttlIndexes(
    dbName: string,
    app: INestApplication,
  ): Promise<Array<{ name?: string; expireAfterSeconds?: number }>> {
    const db = app.get<Db>(MONGO_DB);
    expect(db.databaseName).toBe(dbName);
    const indexes = await db.collection('logs').listIndexes().toArray();
    return indexes.filter((index) => {
      const keys = Object.keys(index.key as Record<string, unknown>);
      return keys.length === 1 && keys[0] === 'occurredAt' && Number(index.key.occurredAt) === 1;
    });
  }

  it('T-E2E-TTL-1 보관 90일이면 만료가 7776000초다', async () => {
    const dbName = newTestDb();
    const app = await bootApp(dbName, 90);
    openApps.push(app);

    const ttl = await ttlIndexes(dbName, app);

    expect(ttl).toHaveLength(1);
    expect(ttl[0].expireAfterSeconds).toBe(7_776_000);
  });

  it('T-E2E-TTL-2·3 보관 일수를 바꿔 다시 기동하면 만료가 바뀌고 한 번 더 기동해도 그대로다', async () => {
    const dbName = newTestDb();
    const first = await bootApp(dbName, 90);
    await first.close();

    const second = await bootApp(dbName, 30);
    openApps.push(second);
    let ttl = await ttlIndexes(dbName, second);
    expect(ttl).toHaveLength(1);
    expect(ttl[0].expireAfterSeconds).toBe(2_592_000);
    await second.close();
    openApps.pop();

    const third = await bootApp(dbName, 30);
    openApps.push(third);
    ttl = await ttlIndexes(dbName, third);
    expect(ttl).toHaveLength(1);
    expect(ttl[0].expireAfterSeconds).toBe(2_592_000);
  });

  it('T-E2E-TTL-4 TTL이 아닌 같은 키 인덱스가 있어도 기동하고 TTL로 맞춘다', async () => {
    const dbName = newTestDb();
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(testMongoUri(dbName));
    try {
      await client.connect();
      await client.db(dbName).collection('logs').createIndex({ occurredAt: 1 }, { name: 'manual' });
    } finally {
      await client.close();
    }

    const app = await bootApp(dbName, 7);
    openApps.push(app);

    const ttl = await ttlIndexes(dbName, app);
    expect(ttl).toHaveLength(1);
    expect(ttl[0].expireAfterSeconds).toBe(604_800);
  });

  it('T-E2E-TTL-5 인덱스 준비 뒤에도 기록이 저장되고 logId 고유 인덱스가 있다', async () => {
    const dbName = newTestDb();
    const app = await bootApp(dbName, 90);
    openApps.push(app);

    await app.get(LogsService).record({
      kind: 'upload',
      docId: 'doc-t',
      name: '인덱스',
      editionLabel: null,
      outcome: 'success',
    });

    const collection = app.get<Db>(MONGO_DB).collection('logs');
    expect(await collection.countDocuments({ docId: 'doc-t' })).toBe(1);
    const indexes = await collection.listIndexes().toArray();
    // ★ 인덱스 이름은 구현 선택이라 고정하지 않는다. key가 { logId: 1 }인 인덱스를 찾아 고유 여부만 본다
    const byLogId = indexes.filter((index) => {
      const keys = Object.keys(index.key as Record<string, unknown>);
      return keys.length === 1 && keys[0] === 'logId' && Number(index.key.logId) === 1;
    });
    expect(byLogId.some((index) => index.unique === true)).toBe(true);
  });
});
