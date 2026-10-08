import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';

/**
 * 환경 변수 E2E_MONGO_BASE_URI 값을 연결 주소(`scheme://호스트[:포트]`)와 쿼리로 나눈다.
 * ★ 경로(DB 이름)는 버리고 쿼리 옵션(예: `?directConnection=true`)만 남긴다. DB 이름은 테스트가 정한다.
 */
function parseBaseUri(raw: string): { origin: string; query: string } {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?/.exec(raw.trim());
  if (!match) {
    throw new Error('E2E_MONGO_BASE_URI는 mongodb:// 또는 mongodb+srv:// 주소여야 합니다');
  }
  return { origin: match[1], query: match[2] ?? '' };
}

const PARSED = parseBaseUri(process.env.E2E_MONGO_BASE_URI ?? 'mongodb://localhost:27017');

/** e2e가 쓰는 MongoDB 주소다(DB 이름 없음). 기본은 저장소 루트 docker compose의 mongo다. */
export const E2E_MONGO_BASE_URI = PARSED.query
  ? `${PARSED.origin}/?${PARSED.query}`
  : PARSED.origin;

/** 테스트 DB 이름의 접두사다. 이 접두사가 아닌 DB는 지우지 않는다. */
const TEST_DB_PREFIX = 'minerva_test_';

/**
 * 이번 e2e 실행의 식별자다. global-setup이 만들어 환경 변수로 모든 워커에 전달한다.
 * ★ global-teardown은 이 식별자가 붙은 DB만 지워, 같은 Mongo를 쓰는 다른 실행의 DB를 건드리지 않는다.
 */
function runId(): string {
  return process.env.E2E_RUN_ID ?? 'norun';
}

/** 이번 실행의 테스트 DB 이름 접두사다. */
function runPrefix(): string {
  return `${TEST_DB_PREFIX}${runId()}_`;
}

/** 테스트 전용 DB 이름(minerva_test_<실행 식별자>_<임의 12자리 16진수>)을 만든다. */
export function createTestDbName(): string {
  return `${runPrefix()}${randomBytes(6).toString('hex')}`;
}

/** 테스트 DB를 가리키는 연결 문자열을 만든다. */
export function testMongoUri(dbName: string): string {
  return `${PARSED.origin}/${dbName}${PARSED.query ? `?${PARSED.query}` : ''}`;
}

/** 테스트 DB를 지운다. 없으면 아무 일 없이 끝난다. */
export async function dropTestDb(dbName: string): Promise<void> {
  // ★ 실수로 실제 DB를 지우지 않게 접두사를 확인한다
  if (!dbName.startsWith(TEST_DB_PREFIX)) {
    throw new Error(`테스트 DB 이름이 ${TEST_DB_PREFIX}로 시작해야 합니다`);
  }
  const client = new MongoClient(E2E_MONGO_BASE_URI, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db(dbName).dropDatabase();
  } finally {
    await client.close();
  }
}

/** 이번 실행이 만든(접두사 minerva_test_<실행 식별자>_) 남은 테스트 DB만 지운다. ★ 다른 DB·다른 실행의 DB는 건드리지 않는다. */
export async function dropAllTestDbs(): Promise<void> {
  const client = new MongoClient(E2E_MONGO_BASE_URI, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
    const names = databases.map((d) => d.name).filter((name) => name.startsWith(runPrefix()));
    await Promise.all(names.map((name) => client.db(name).dropDatabase()));
  } finally {
    await client.close();
  }
}

/** 오류 메시지에 쓸 호스트 부분만 돌려준다. ★ 자격 증명(user:pass@)과 쿼리는 로그에 남기지 않는다. */
function safeOrigin(): string {
  const host = PARSED.origin.replace(/^[^:]+:\/\/(?:[^@/]*@)?/, '');
  return host;
}

/** MongoDB에 닿는지 확인하고, 닿지 않으면 준비 방법을 담은 Error를 던진다. */
export async function assertMongoReachable(): Promise<void> {
  const client = new MongoClient(E2E_MONGO_BASE_URI, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch {
    throw new Error(
      `e2e용 MongoDB(${safeOrigin()})에 연결할 수 없습니다. 저장소 루트에서 docker compose up -d mongo를 실행하세요`,
    );
  } finally {
    await client.close();
  }
}
