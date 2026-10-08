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

  it('T-FAKE-4 범위 연산자는 같은 타입(숫자·문자열·Date)끼리만 비교하고 타입이 섞이거나 필드가 없으면 불일치다', async () => {
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
    // ★ 문자열 범위 비교: 같은 타입(문자열)끼리만 비교한다
    expect(await ids({ label: { $gte: 'a' } })).toEqual([3]);
    expect(await ids({ label: { $gt: 'x' } })).toEqual([]);
    // ★ 타입이 섞이면 불일치다(숫자 필드에 문자열 피연산자, 문자열 필드에 숫자 피연산자)
    expect(await ids({ n: { $gte: 'a' } })).toEqual([]);
    expect(await ids({ label: { $gte: 0 } })).toEqual([]);
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
    // ★ $regex는 이제 지원한다. 지원하지 않는 필드 연산자는 $exists 같은 다른 것으로 본다
    await expect(c.find({ a: { $exists: true } }).toArray()).rejects.toThrow('fake-mongo');
    await expect(c.find({ $nor: [] }).toArray()).rejects.toThrow('fake-mongo');
  });
});

// ★ 아래는 PR #3 리뷰 수정(목록 DB 정렬·이름 목록·평가 집계)이 기대는 가짜 확장이다.

describe('REQ-BE-1.3.1', () => {
  it('T-PR3-FAKE-1 skip·limit·countDocuments와 calls의 options·returned', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, k: i % 2 })));
    const ids = async (cursorOf: () => ReturnType<typeof c.find>) =>
      (await cursorOf().toArray()).map((d) => d.id);

    // 정렬 → skip → limit 순이다(skip을 limit보다 먼저 걸어도 같다)
    expect(await ids(() => c.find({}).sort({ id: -1 }).skip(2).limit(3))).toEqual([8, 7, 6]);
    expect(await ids(() => c.find({}).sort({ id: -1 }).limit(3).skip(2))).toEqual([8, 7, 6]);
    // limit(0)은 제한이 없다
    expect(await ids(() => c.find({}).sort({ id: 1 }).skip(8).limit(0))).toEqual([9, 10]);
    expect(await ids(() => c.find({}).skip(20).limit(5))).toEqual([]);
    expect(() => c.find({}).skip(-1)).toThrow('fake-mongo');
    expect(() => c.find({}).limit(1.5)).toThrow('fake-mongo');

    // countDocuments는 필터와 같은 규칙으로 센다
    expect(await c.countDocuments({})).toBe(10);
    expect(await c.countDocuments({ k: 1 })).toBe(5);
    expect(await c.countDocuments({ id: { $gt: 100 } })).toBe(0);

    // calls: options(넘긴 옵션 + 커서에서 건 조건)와 returned(돌려준 수)
    const fresh = createFakeDb();
    const f = fresh.collection('c');
    await f.insertMany([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await f
      .find({ id: { $gte: 1 } }, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .skip(1)
      .limit(1)
      .toArray();
    await f.countDocuments({ id: { $gte: 2 } });
    await f.findOne({ id: 3 });
    await f.findOne({ id: 99 });
    const findCall = fresh.calls.find((call) => call.op === 'find');
    expect(findCall?.options).toEqual({
      projection: { _id: 0 },
      sort: { id: 1 },
      skip: 1,
      limit: 1,
    });
    expect(findCall?.returned).toBe(1);
    expect(fresh.calls.find((call) => call.op === 'countDocuments')?.returned).toBe(2);
    expect(
      fresh.calls.filter((call) => call.op === 'findOne').map((call) => call.returned),
    ).toEqual([1, 0]);
  });
});

describe('REQ-BE-1.3.8', () => {
  it('T-PR3-FAKE-2 키를 고르는 projection을 지원하고 잘못된 projection은 오류다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertOne({ a: 1, b: 2, c: { d: 3 } });

    expect(await c.find({}, { projection: { _id: 0 } }).toArray()).toEqual([
      { a: 1, b: 2, c: { d: 3 } },
    ]);
    expect(await c.find({}, { projection: { _id: 0, a: 1, c: 1 } }).toArray()).toEqual([
      { a: 1, c: { d: 3 } },
    ]);
    expect(await c.findOne({}, { projection: { _id: 0, b: 1 } })).toEqual({ b: 2 });
    // 없는 키를 골라도 오류가 아니다
    expect(await c.findOne({}, { projection: { _id: 0, zzz: 1 } })).toEqual({});

    // 점 경로, _id 밖의 0과 1 섞기, 지원하지 않는 옵션은 오류다
    expect(() => c.find({}, { projection: { _id: 0, 'c.d': 1 } })).toThrow('fake-mongo');
    expect(() => c.find({}, { projection: { _id: 0, a: 1, b: 0 } })).toThrow('fake-mongo');
    expect(() => c.find({}, { projection: { a: 0 } })).toThrow('fake-mongo');
    await expect(c.findOne({}, { projection: { _id: 0, 'c.d': 1 } })).rejects.toThrow('fake-mongo');
    expect(() => c.find({}, { sort: { a: 1 } } as never)).toThrow('fake-mongo');
  });
});

describe('REQ-BE-1.3.7', () => {
  it('T-PR3-FAKE-3 $regex($options 포함)와 문자열 범위 비교를 지원한다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([
      { name: 'a.b-1' },
      { name: 'axb' },
      { name: 'A.B-2' },
      { name: 'a.b-2' },
      { name: '가나' },
      { name: 3 },
      { other: 'a.b-9' },
    ]);
    const names = async (filter: Record<string, unknown>) =>
      (await c.find(filter).sort({ name: 1 }).toArray()).map((d) => d.name);

    // 점이 정규식 메타 문자이므로 이스케이프한 접두는 점 그대로만 맞는다
    expect(await names({ name: { $regex: '^a\\.b' } })).toEqual(['a.b-1', 'a.b-2']);
    expect(await names({ name: { $regex: '^a.b' } })).toEqual(['a.b-1', 'a.b-2', 'axb']);
    expect(await names({ name: { $regex: '^a\\.b', $options: 'i' } })).toEqual([
      'A.B-2',
      'a.b-1',
      'a.b-2',
    ]);
    // 문자열이 아닌 값과 없는 필드에는 맞지 않는다
    expect(await names({ name: { $regex: '3' } })).toEqual([]);
    // 문자열 범위 비교는 코드 포인트 순이고 문자열끼리만 비교한다
    expect(await names({ name: { $gt: 'a.b-1', $lt: 'axb' } })).toEqual(['a.b-2']);
    expect(await names({ name: { $gte: '가' } })).toEqual(['가나']);
    expect(await names({ name: { $gt: 'A.B-2' } })).toEqual(['a.b-1', 'a.b-2', 'axb', '가나']);
    await expect(c.find({ name: { $options: 'i' } }).toArray()).rejects.toThrow('fake-mongo');
  });
});

describe('REQ-BE-5.3.2', () => {
  it('T-PR3-FAKE-4 aggregate의 지원 파이프라인을 돌리고 지원하지 않는 단계는 오류다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([
      { g: 'a', at: 1, v: 'a1' },
      { g: 'a', at: 3, v: 'a3' },
      { g: 'b', at: 2, v: 'b2' },
      { g: 'c', at: 9, v: 'c9' },
      { g: 'a', at: 2, v: 'a2' },
    ]);
    const pipeline = [
      { $match: { g: { $in: ['a', 'b'] } } },
      { $sort: { g: 1, at: -1 } },
      { $group: { _id: '$g', latest: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$latest' } },
      { $project: { _id: 0 } },
    ];
    const result = await c.aggregate(pipeline).toArray();
    expect(result).toEqual([
      { g: 'a', at: 3, v: 'a3' },
      { g: 'b', at: 2, v: 'b2' },
    ]);
    // 결과를 바꿔도 원본이 바뀌지 않는다
    result[0].v = 'changed';
    expect((await c.aggregate(pipeline).toArray())[0].v).toBe('a3');
    // 호출 기록: 파이프라인과 돌려준 수
    const call = db.calls.find((entry) => entry.op === 'aggregate');
    expect(call?.options).toEqual(pipeline);
    expect(call?.returned).toBe(2);

    // $project 없이 $group만 돌리면 _id와 이름 아래 문서가 나온다
    const grouped = await c
      .aggregate([{ $sort: { at: 1 } }, { $group: { _id: '$g', first: { $first: '$$ROOT' } } }])
      .toArray();
    expect(grouped.map((d) => d._id)).toEqual(['a', 'b', 'c']);
    expect(grouped[0].first).toEqual({ g: 'a', at: 1, v: 'a1' });

    // 지원하지 않는 단계·모양은 오류다
    await expect(c.aggregate([{ $limit: 1 }]).toArray()).rejects.toThrow('fake-mongo');
    await expect(
      c.aggregate([{ $group: { _id: '$g', n: { $sum: 1 } } }]).toArray(),
    ).rejects.toThrow('fake-mongo');
    await expect(
      c.aggregate([{ $group: { _id: null, latest: { $first: '$$ROOT' } } }]).toArray(),
    ).rejects.toThrow('fake-mongo');
    await expect(c.aggregate([{ $project: { v: 1 } }]).toArray()).rejects.toThrow('fake-mongo');
    await expect(c.aggregate([{ $replaceRoot: { newRoot: { x: 1 } } }]).toArray()).rejects.toThrow(
      'fake-mongo',
    );
  });

  it('T-PR3-FAKE-10 $group에서 null과 필드 없음은 _id가 null인 한 그룹이다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([{ g: null, t: 1 }, { t: 3 }, { g: 'x', t: 2 }]);
    const groups = await c
      .aggregate([{ $sort: { t: -1 } }, { $group: { _id: '$g', latest: { $first: '$$ROOT' } } }])
      .toArray();
    expect(groups).toHaveLength(2);
    // ★ _id는 undefined가 아니라 null이어야 실제 MongoDB와 같다
    const nullGroup = groups.filter((g) => g._id === null);
    expect(nullGroup).toHaveLength(1);
    expect(nullGroup[0]._id).toBeNull();
    expect((nullGroup[0].latest as { t: number }).t).toBe(3);
    expect(groups.filter((g) => g._id === 'x')).toHaveLength(1);
  });
});

describe('REQ-BE-5.2.4', () => {
  it('T-PR3-FAKE-5 insertMany는 ordered로 동작하고 failNext의 insertFirst로 부분 삽입 뒤 실패시킨다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.createIndex({ id: 1 }, { unique: true });
    await c.insertOne({ id: 1 });

    // 고유 키가 충돌하면 그 앞 문서까지만 넣고 code 11000으로 던진다
    await expect(c.insertMany([{ id: 2 }, { id: 3 }, { id: 1 }, { id: 4 }])).rejects.toMatchObject({
      code: 11000,
    });
    expect(db.dump('c').map((d) => d.id)).toEqual([1, 2, 3]);
    // 같은 묶음 안의 중복도 앞 문서까지만 들어간다
    await expect(c.insertMany([{ id: 5 }, { id: 5 }])).rejects.toMatchObject({ code: 11000 });
    expect(db.dump('c').map((d) => d.id)).toEqual([1, 2, 3, 5]);

    // insertFirst: 앞 k건을 넣고 준 오류로 실패한다
    db.failNext('insertMany', new Error('boom'), { insertFirst: 2 });
    await expect(c.insertMany([{ id: 10 }, { id: 11 }, { id: 12 }])).rejects.toThrow('boom');
    expect(db.dump('c').map((d) => d.id)).toEqual([1, 2, 3, 5, 10, 11]);
    // 한 번만 적용된다
    await c.insertMany([{ id: 20 }]);
    expect(db.dump('c').map((d) => d.id)).toEqual([1, 2, 3, 5, 10, 11, 20]);
    // insertFirst 없이 실패시키면 하나도 넣지 않는다
    db.failNext('insertMany', new Error('none'));
    await expect(c.insertMany([{ id: 30 }])).rejects.toThrow('none');
    expect(db.dump('c').map((d) => d.id)).not.toContain(30);
    // insertFirst는 insertMany에서만 쓴다
    expect(() => db.failNext('find', new Error('x'), { insertFirst: 1 })).toThrow('fake-mongo');
    // 새 실패 대상: countDocuments, aggregate
    db.failNext('countDocuments', new Error('count'));
    await expect(c.countDocuments({})).rejects.toThrow('count');
    db.failNext('aggregate', new Error('agg'));
    // ★ 실제 드라이버처럼 aggregate 호출은 던지지 않고 toArray에서 거부한다
    const cursor = c.aggregate([]);
    await expect(cursor.toArray()).rejects.toThrow('agg');
    // 한 번만 적용된다
    expect(await c.aggregate([]).toArray()).toBeDefined();
  });

  it('T-PR3-FAKE-7 문자열 정렬은 코드 포인트 순이다(U+FFFF 위 문자는 U+FFFD 뒤)', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    const emoji = String.fromCodePoint(0x1f600);
    const bmp = String.fromCodePoint(0xfffd);
    await c.insertMany([
      { id: 1, name: emoji },
      { id: 2, name: bmp },
      { id: 3, name: 'a' },
    ]);
    // ★ UTF-16 코드 유닛 순이면 이모지(D83D…)가 U+FFFD보다 앞선다
    const asc = (await c.find({}).sort({ name: 1 }).toArray()).map((d) => d.id);
    expect(asc).toEqual([3, 2, 1]);
    const desc = (await c.find({}).sort({ name: -1 }).toArray()).map((d) => d.id);
    expect(desc).toEqual([1, 2, 3]);
  });
});

describe('REQ-BE-5.2.8', () => {
  it('T-PR3-FAKE-6 $nin은 값이 목록에 없거나 필드가 없는 문서에 맞는다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([{ id: 1, g: 'a' }, { id: 2, g: 'b' }, { id: 3 }, { id: 4, g: null }]);
    const ids = async (filter: Record<string, unknown>) =>
      (await c.find(filter).toArray()).map((d) => d.id);
    expect(await ids({ g: { $nin: ['a'] } })).toEqual([2, 3, 4]);
    expect(await ids({ g: { $nin: ['a', 'b'] } })).toEqual([3, 4]);
    // null이 목록에 있으면 값이 없거나 null인 문서가 빠진다
    expect(await ids({ g: { $nin: ['a', null] } })).toEqual([2]);
    expect(await ids({ g: { $nin: [] } })).toEqual([1, 2, 3, 4]);
  });
});

describe('REQ-BE-1.3.2', () => {
  it('T-PR3-FAKE-8 정렬에서 null과 필드 없음은 같은 값이고 오름차순 맨 앞, 내림차순 맨 뒤다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([
      { k: 'a', v: 2 },
      { k: 'b', v: null },
      { k: 'c' },
      { k: 'd', v: -1 },
      { k: 'e', v: 0 },
    ]);
    const keys = async (sort: Record<string, 1 | -1>) =>
      (await c.find({}).sort(sort).toArray()).map((d) => d.k);
    expect(await keys({ v: 1, k: 1 })).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(await keys({ v: -1, k: 1 })).toEqual(['a', 'e', 'd', 'b', 'c']);
  });

  it('T-PR3-FAKE-9 정렬에서 타입이 다르면 숫자 < 문자열 < Date 순이다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([
      { k: 's', v: 'x' },
      { k: 'n', v: 5 },
      { k: 'd', v: new Date(0) },
      { k: 'z' },
    ]);
    const keys = (await c.find({}).sort({ v: 1 }).toArray()).map((d) => d.k);
    expect(keys).toEqual(['z', 'n', 's', 'd']);
  });

  it('T-PR3-FAKE-11 정렬 값이 객체·배열이면 지원하지 않는다는 오류다', async () => {
    const db = createFakeDb();
    const c = db.collection('c');
    await c.insertMany([{ v: { a: 1 } }, { v: { a: 2 } }]);
    await expect(c.find({}).sort({ v: 1 }).toArray()).rejects.toThrow(
      'fake-mongo: 지원하지 않는 정렬 값',
    );
  });
});
