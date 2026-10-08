import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { Db } from 'mongodb';
import { InvalidRequestError } from '../src/common';
import { FILE_STORE, MONGO_DB, StorageModule } from '../src/storage';
import type { FileStore } from '../src/storage';
import { createLogCapture } from './support/log-capture';
import {
  assertMongoReachable,
  createTestDbName,
  dropTestDb,
  testMongoUri,
} from './support/mongo-test-db';
import { createTestCommonModule } from './support/test-common.module';
import type { TestConfigValues } from './support/test-common.module';

jest.setTimeout(30_000);

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다. nestjs-pino는 루트 로거를 파일당 하나만 만들어
//   처음 forRoot의 출력 대상에 고정한다
const capture = createLogCapture();
const createdDbs: string[] = [];
let moduleRef: TestingModule | undefined;
let tmpBase: string;

// ★ 자격 증명과 호스트에 센티널을 넣어 로그·오류에 새는지 본다. 포트 1은 즉시 거부된다
const UNREACHABLE_URI =
  'mongodb://e2e-user-SENTINEL:e2e-pass-SENTINEL@127.0.0.1:1/minerva_test_unreachable?serverSelectionTimeoutMS=1000';

beforeAll(async () => {
  await assertMongoReachable();
});

beforeEach(async () => {
  capture.clear();
  moduleRef = undefined;
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-storage-e2e-'));
});

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
  await fs.rm(tmpBase, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(createdDbs.map((name) => dropTestDb(name)));
});

/** 하네스 + StorageModule을 올린다. */
async function boot(values: TestConfigValues): Promise<TestingModule> {
  moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule(values, capture.stream), StorageModule],
  }).compile();
  return moduleRef;
}

/** 테스트 DB를 하나 정하고 정리 목록에 넣는다. */
function newTestDb(): string {
  const dbName = createTestDbName();
  createdDbs.push(dbName);
  return dbName;
}

describe('REQ-BE-9.1.1', () => {
  it('T-E2E-1 닿지 않는 주소면 앱 생성이 실패하고 error 로그가 남으며 연결 문자열이 없다', async () => {
    const error = await boot({ MONGODB_URI: UNREACHABLE_URI, FILE_STORAGE_DIR: tmpBase }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(moduleRef).toBeUndefined();

    const failed = capture.parsed().filter((line) => line.msg === 'storage.mongo_connect_failed');
    expect(failed).toHaveLength(1);
    const entry = failed[0];
    expect(entry.level).toBe(50);
    expect(typeof entry.errorName).toBe('string');
    expect((entry.errorName as string).length).toBeGreaterThanOrEqual(1);

    // ★ 허용 필드는 errorName뿐이다. 나머지는 pino 기본 필드여야 한다
    const allowed = new Set(['level', 'time', 'pid', 'hostname', 'context', 'errorName', 'msg']);
    const extra = Object.keys(entry).filter((key) => !allowed.has(key));
    expect(extra).toEqual([]);

    const allLogs = capture.lines.join('\n');
    for (const secret of ['SENTINEL', 'mongodb://', '127.0.0.1:1', 'e2e-user']) {
      expect(allLogs).not.toContain(secret);
    }

    const thrown = error as Error;
    const thrownText = [String(thrown), thrown.message, thrown.stack ?? ''].join('\n');
    for (const secret of ['SENTINEL', 'mongodb://', '127.0.0.1']) {
      expect(thrownText).not.toContain(secret);
    }
  });

  it('T-E2E-2 닿는 주소면 MONGO_DB가 주입되고 실제로 쓸 수 있다', async () => {
    const dbName = newTestDb();
    const ref = await boot({ MONGODB_URI: testMongoUri(dbName), FILE_STORAGE_DIR: tmpBase });

    const db = ref.get<Db>(MONGO_DB);

    expect(db).toBeInstanceOf(Db);
    expect(db.databaseName).toBe(dbName);
    const pong = await db.command({ ping: 1 });
    expect(pong.ok).toBe(1);

    await db.collection('e2e_probe').insertOne({ n: 1 });
    const found = await db.collection('e2e_probe').findOne({ n: 1 });
    expect(found).toMatchObject({ n: 1 });

    const failed = capture.parsed().filter((line) => line.msg === 'storage.mongo_connect_failed');
    expect(failed).toHaveLength(0);
  });

  it('T-E2E-3 종료할 때 연결을 닫는다', async () => {
    const dbName = newTestDb();
    const ref = await boot({ MONGODB_URI: testMongoUri(dbName), FILE_STORAGE_DIR: tmpBase });
    const db = ref.get<Db>(MONGO_DB);

    await ref.close();
    moduleRef = undefined;

    const error = await db.command({ ping: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('MongoNotConnectedError');
  });
});

describe('REQ-BE-9.1.2', () => {
  it('T-E2E-6 FILE_STORE가 주입되고 설정한 위치에 쓴다', async () => {
    const dbName = newTestDb();
    const ref = await boot({
      MONGODB_URI: testMongoUri(dbName),
      FILE_STORAGE_DIR: path.join(tmpBase, 'files'),
    });
    const files = ref.get<FileStore>(FILE_STORE);

    await files.put('doc1/1/ph.png', Buffer.from([1, 2, 3]));

    const raw = await fs.readFile(path.join(tmpBase, 'files', 'doc1', '1', 'ph.png'));
    expect([...raw]).toEqual([1, 2, 3]);
    await expect(files.read('../x')).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
