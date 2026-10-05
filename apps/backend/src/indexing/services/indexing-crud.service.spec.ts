import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { MONGO_DB } from '../../storage';
import { createFakeDb } from '../../../test/support/fake-mongo';
import type { FakeDb } from '../../../test/support/fake-mongo';
import { IndexingCrudService } from './indexing-crud.service';

let db: FakeDb;
let moduleRef: TestingModule;
let repo: IndexingCrudService;

/** 가짜 Db로 저장소를 만든다. */
async function build(): Promise<void> {
  moduleRef = await Test.createTestingModule({
    providers: [IndexingCrudService, { provide: MONGO_DB, useValue: db }],
  }).compile();
  repo = moduleRef.get(IndexingCrudService);
}

beforeEach(async () => {
  db = createFakeDb();
  await build();
  // ★ 고유 인덱스(docId)를 가짜 Db에도 건다
  await repo.ensureIndexes();
});

afterEach(async () => {
  await moduleRef.close();
  jest.restoreAllMocks();
});

describe('REQ-BE-3.2.4', () => {
  it('T-CUR-1 큰 순번일 때만 올리고 참을 돌려준다', async () => {
    expect(await repo.advance('d', 3)).toBe(true);
    expect(await repo.advance('d', 3)).toBe(false);
    expect(await repo.advance('d', 2)).toBe(false);
    expect(await repo.advance('d', 4)).toBe(true);
    const rows = db.dump('rag_event_cursors');
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSequence).toBe(4);
  });

  it('T-CUR-2 문서가 없을 때 같은 순번을 동시에 올리면 하나만 참이다', async () => {
    const results = await Promise.all([repo.advance('d', 5), repo.advance('d', 5)]);
    expect(results.filter((r) => r)).toHaveLength(1);
    const rows = db.dump('rag_event_cursors');
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSequence).toBe(5);
    // ★ 한쪽이 E11000을 받아 조건부 갱신으로 다시 판정하는 경로를 탄다
    expect(db.calls.filter((call) => call.op === 'insertOne')).toHaveLength(2);
  });

  it('T-CUR-3 문서가 없을 때 다른 순번을 동시에 올려도 줄지 않는다', async () => {
    const [first, second] = await Promise.all([repo.advance('d', 4), repo.advance('d', 5)]);
    // ★ 가짜 Db 연산이 await 없이 원자적이라 4가 먼저 삽입하고 5가 중복 키 뒤 조건부 갱신으로 이긴다
    expect([first, second]).toEqual([true, true]);
    expect(db.dump('rag_event_cursors')[0].lastSequence).toBe(5);
  });

  it('T-CUR-3b 큰 순번이 먼저 만들어졌으면 작은 순번은 거짓이고 줄지 않는다', async () => {
    const [first, second] = await Promise.all([repo.advance('d', 5), repo.advance('d', 4)]);
    expect([first, second]).toEqual([true, false]);
    expect(db.dump('rag_event_cursors')[0].lastSequence).toBe(5);
  });

  it('T-CUR-4 중복 키가 아닌 저장 오류는 다시 던진다', async () => {
    const error = Object.assign(new Error('x'), { code: 121 });
    db.failNext('insertOne', error);
    await expect(repo.advance('n', 1)).rejects.toBe(error);
  });

  it('T-CUR-5 docId 고유 인덱스를 정해진 이름으로 만든다', async () => {
    const spy = jest.spyOn(db.collection('rag_event_cursors'), 'createIndex');
    await repo.ensureIndexes();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      { docId: 1 },
      { unique: true, name: 'rag_event_cursors_doc_id' },
    );
  });

  it('T-CUR-6 마지막 순번을 숫자로 읽고 없으면 null이다', async () => {
    expect(await repo.getLastSequence('none')).toBeNull();
    await repo.advance('d', 2);
    expect(await repo.getLastSequence('d')).toBe(2);
  });

  it('T-CUR-7 rag_event_cursors 컬렉션과 정해진 연산만 쓴다', async () => {
    // ★ 저장소가 생성자에서 db.collection을 부르므로 모듈을 compile하기 전에 스파이를 건다
    await moduleRef.close();
    db = createFakeDb();
    const spy = jest.spyOn(db, 'collection');
    await build();
    await repo.ensureIndexes();
    await repo.advance('d', 1);
    await repo.getLastSequence('d');
    const ops = new Set(db.calls.map((call) => call.op));
    for (const op of ops) {
      expect(['createIndex', 'findOne', 'updateOne', 'insertOne']).toContain(op);
    }
    expect(spy).toHaveBeenCalled();
    for (const [name] of spy.mock.calls) {
      expect(name).toBe('rag_event_cursors');
    }
  });

  it('T-CUR-8 가짜 Db의 $lt·고유 인덱스 동작이 실제 MongoDB와 같은 방향이다', async () => {
    const col = db.collection('probe');
    await col.insertOne({ k: 'num', v: 1 });
    await col.insertOne({ k: 'str', v: 'a' });
    await col.insertOne({ k: 'none' });
    const lt = async (operand: number): Promise<string[]> =>
      (await col.find({ v: { $lt: operand } }).toArray()).map((doc) => doc.k as string);
    // 숫자만 비교하고 필드가 없거나 문자열이면 불일치다
    expect(await lt(2)).toEqual(['num']);
    expect(await lt(1)).toEqual([]);

    // 고유 인덱스는 만든 뒤에만 적용되고 충돌 오류의 code는 11000이다
    await col.insertOne({ k: 'num', v: 2 });
    expect(db.dump('probe')).toHaveLength(4);
    await col.createIndex({ u: 1 }, { unique: true, name: 'probe_u' });
    await col.insertOne({ u: 'x' });
    await expect(col.insertOne({ u: 'x' })).rejects.toMatchObject({ code: 11000 });
    expect(db.dump('probe').filter((doc) => doc.u === 'x')).toHaveLength(1);
  });
});
