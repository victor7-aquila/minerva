import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { Db } from 'mongodb';
import { AppLoggerModule } from '../libs/logger';
import { CommonModule } from '../src/common';
import { FILE_STORE, MONGO_DB, StorageModule } from '../src/storage';
import type { FileStore } from '../src/storage';
import {
  assertMongoReachable,
  createTestDbName,
  dropTestDb,
  testMongoUri,
} from './support/mongo-test-db';
import { buildFullTestEnv } from './support/test-env';

jest.setTimeout(30_000);

/** 이진 데이터다. */
const BYTES = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x0a, 0x0d]);

const originalEnv = process.env;
const createdDbs: string[] = [];
let moduleRef: TestingModule | undefined;
let tmpBase: string;

beforeAll(async () => {
  await assertMongoReachable();
});

beforeEach(async () => {
  moduleRef = undefined;
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-storage-e2e-'));
});

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
  process.env = originalEnv;
  await fs.rm(tmpBase, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(createdDbs.map((name) => dropTestDb(name)));
});

/** 환경을 통째로 바꾸고 CommonModule + AppLoggerModule + StorageModule을 올린다. */
async function boot(env: Record<string, string>): Promise<TestingModule> {
  // ★ 병합하지 않고 통째로 바꾼다. 개발자 PC의 .env·환경 값이 섞이지 않게 한다
  process.env = { ...env };
  moduleRef = await Test.createTestingModule({
    imports: [CommonModule, AppLoggerModule, StorageModule],
  }).compile();
  return moduleRef;
}

describe('REQ-BE-9.1.1', () => {
  it('T-E2E-4 실제 설정으로 기동하면 MONGO_DB가 그 URI의 DB다', async () => {
    const dbName = createTestDbName();
    createdDbs.push(dbName);

    const ref = await boot(
      buildFullTestEnv({ MONGODB_URI: testMongoUri(dbName), FILE_STORAGE_DIR: tmpBase }),
    );

    const db = ref.get<Db>(MONGO_DB);
    expect(db.databaseName).toBe(dbName);
    const pong = await db.command({ ping: 1 });
    expect(pong.ok).toBe(1);
  });
});

describe('REQ-BE-9.1.2', () => {
  it('T-E2E-5 실제 설정의 FILE_STORAGE_DIR 아래에 쓴다', async () => {
    const dbName = createTestDbName();
    createdDbs.push(dbName);
    const storeDir = path.join(tmpBase, 'store');

    const ref = await boot(
      buildFullTestEnv({ MONGODB_URI: testMongoUri(dbName), FILE_STORAGE_DIR: storeDir }),
    );
    const files = ref.get<FileStore>(FILE_STORE);

    await files.put('doc9/2/p.png', BYTES);

    const raw = await fs.readFile(path.join(storeDir, 'doc9', '2', 'p.png'));
    expect(raw.equals(BYTES)).toBe(true);
    expect((await files.read('doc9/2/p.png'))?.equals(BYTES)).toBe(true);
  });
});
