import { createFakeDb } from '../../test/support/fake-mongo';

// ★ documents 단위 테스트의 조건부 갱신(REQ-BE-1.5.5)이 기대는 가짜 Db 연산을 직접 확인한다.
// 가짜가 실제 MongoDB와 어긋나면 단위 테스트가 거짓 초록을 내므로 연산자마다 몇 건씩만 본다.

describe('REQ-BE-1.5.5', () => {
  it('T-FAKE-1 점 경로로 읽고 쓴다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertOne({ id: 1, pendingRag: { deleteChunks: false, metadata: false } });
    expect(await c.findOne({ 'pendingRag.metadata': false })).not.toBeNull();
    await c.updateOne({ id: 1 }, { $set: { 'pendingRag.metadata': true } });
    expect(await c.findOne({ 'pendingRag.metadata': false })).toBeNull();
    const row = db.dump('c')[0];
    expect(row.pendingRag).toEqual({ deleteChunks: false, metadata: true });
  });

  it('T-FAKE-2 null은 없는 값과 같고 Date는 시각이 같으면 같다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertOne({ id: 1, at: new Date('2026-01-01T00:00:00Z'), edition: null });
    await c.insertOne({ id: 2 });
    expect((await c.find({ edition: null }).toArray()).map((d) => d.id)).toEqual([1, 2]);
    expect(await c.findOne({ at: new Date('2026-01-01T00:00:00Z') })).not.toBeNull();
    expect(await c.findOne({ at: new Date('2026-01-01T00:00:01Z') })).toBeNull();
  });

  it('T-FAKE-3 조건이 어긋나면 갱신하지 않고 matchedCount가 0이다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertOne({ id: 1, state: 'completed', n: 1 });
    const missed = await c.updateOne({ id: 1, state: 'queued' }, { $set: { n: 2 } });
    expect(missed.matchedCount).toBe(0);
    expect(db.dump('c')[0].n).toBe(1);
    const hit = await c.updateOne({ id: 1, state: 'completed' }, { $set: { n: 2 } });
    expect(hit.matchedCount).toBe(1);
    expect(hit.modifiedCount).toBe(1);
  });

  it('T-FAKE-4 범위 연산자는 숫자와 Date에서만 비교하고 필드가 없으면 불일치다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([
      { id: 1, n: 5, at: new Date('2026-01-02T00:00:00Z') },
      { id: 2, n: 10 },
      { id: 3, label: 'x' },
    ]);
    const ids = async (filter: Record<string, unknown>) =>
      (await c.find(filter).toArray()).map((d) => d.id);
    expect(await ids({ n: { $gte: 5, $lt: 10 } })).toEqual([1]);
    expect(await ids({ n: { $gt: 5 } })).toEqual([2]);
    expect(await ids({ n: { $lte: 5 } })).toEqual([1]);
    expect(await ids({ at: { $gte: new Date('2026-01-01T00:00:00Z') } })).toEqual([1]);
    expect(await ids({ n: { $gte: 0 }, id: { $ne: 1 } })).toEqual([2]);
  });

  it('T-FAKE-5 $and와 $or를 조합하고 지원하지 않는 연산자는 오류를 던진다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([
      { id: 1, a: 1, b: 1 },
      { id: 2, a: 1, b: 2 },
      { id: 3, a: 2, b: 2 },
    ]);
    const ids = async (filter: Record<string, unknown>) =>
      (await c.find(filter).toArray()).map((d) => d.id);
    expect(await ids({ $and: [{ a: 1 }, { $or: [{ b: 2 }, { b: 3 }] }] })).toEqual([2]);
    await expect(c.find({ a: { $regex: 'x' } }).toArray()).rejects.toThrow('fake-mongo');
    await expect(c.find({ $nor: [] }).toArray()).rejects.toThrow('fake-mongo');
  });
});
