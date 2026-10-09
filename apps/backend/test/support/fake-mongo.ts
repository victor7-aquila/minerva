/** 가짜가 지원하는 실패 주입 대상 연산이다. */
type FailableOp =
  | 'insertOne'
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'deleteMany'
  | 'find'
  | 'findOne'
  | 'countDocuments'
  | 'aggregate';

/** 문서 한 건이다. */
type Doc = Record<string, unknown>;

/** 조회 옵션이다. */
interface FindOptions {
  projection?: Record<string, number>;
}

/** 가짜 컬렉션의 커서다. */
export interface FakeCursor {
  sort(spec: Record<string, 1 | -1>): FakeCursor;
  /** ★ 정렬 → skip → limit 순으로 적용한다 */
  skip(count: number): FakeCursor;
  /** ★ 0은 제한 없음이다 */
  limit(count: number): FakeCursor;
  toArray(): Promise<Doc[]>;
}

/** 가짜 aggregate 커서다. */
export interface FakeAggregateCursor {
  toArray(): Promise<Doc[]>;
}

/** 가짜가 받는 update다. $set과 $inc만 지원한다. */
export interface FakeUpdate {
  $set?: Doc;
  /** 숫자 필드에 더한다. 없는 필드는 0에서 시작한다 */
  $inc?: Doc;
}

/** 메모리 가짜 컬렉션이다. assets·indexing·documents 저장소가 쓰는 연산만 지원한다. */
export interface FakeCollection {
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean; name?: string },
  ): Promise<string>;
  insertOne(doc: Doc): Promise<{ acknowledged: boolean }>;
  insertMany(docs: Doc[]): Promise<{ insertedCount: number }>;
  find(filter: Doc, options?: FindOptions): FakeCursor;
  findOne(filter: Doc, options?: FindOptions): Promise<Doc | null>;
  countDocuments(filter?: Doc): Promise<number>;
  aggregate(pipeline: Doc[]): FakeAggregateCursor;
  updateOne(
    filter: Doc,
    update: FakeUpdate,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(
    filter: Doc,
    update: FakeUpdate,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteMany(filter: Doc): Promise<{ deletedCount: number }>;
}

/** 연산 호출 기록 한 건이다. */
export interface FakeCall {
  op: string;
  filter?: unknown;
  /** find·findOne은 넘긴 옵션(+ 커서에서 건 sort·skip·limit), aggregate는 파이프라인이다 */
  options?: unknown;
  /** 돌려준 문서 수다. find는 toArray를 부른 뒤, countDocuments는 센 값, aggregate는 결과 수다 */
  returned?: number;
}

/** 실패 주입 옵션이다. */
export interface FailNextOptions {
  /** ★ insertMany에서만 쓴다. 앞 k건을 넣은 뒤 실패시킨다 */
  insertFirst?: number;
}

/** 메모리 가짜 Db다. */
export interface FakeDb {
  /** 같은 이름이면 같은 객체 */
  collection(name: string): FakeCollection;
  /** 컬렉션의 현재 문서 복사본(삽입 순서) */
  dump(name: string): Record<string, unknown>[];
  /** 다음 호출 하나를 실패시킨다. 예: failNext('updateOne', new Error('boom')) */
  failNext(op: FailableOp, error: Error, options?: FailNextOptions): void;
  /** 연산 호출 기록 [{ op, filter, options?, returned? }] */
  readonly calls: FakeCall[];
}

/**
 * Date인지 본다.
 * ★ structuredClone이 만든 Date는 Jest 샌드박스의 Date와 다른 영역(realm)이라 instanceof가 거짓이 된다
 */
function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** RegExp인지 본다. ★ isDate와 같은 이유로 영역을 가리지 않는다 */
function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]';
}

/** 값이 연산자 객체({ $in … })인지 본다. */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isDate(value) &&
    !isRegExp(value) &&
    Object.keys(value).some((key) => key.startsWith('$'))
  );
}

/** 점 경로(a.b)로 중첩 값을 읽는다. 중간이 없으면 undefined다. */
function getPath(doc: Doc, path: string): unknown {
  let current: unknown = doc;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Doc)[part];
  }
  return current;
}

/** 점 경로(a.b)로 중첩 객체에 쓴다. 중간 객체가 없으면 만든다. */
function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = doc;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== 'object' || next === null) current[part] = {};
    current = current[part] as Doc;
  }
  current[parts[parts.length - 1]] = value;
}

/** 같음 판정이다. null은 undefined와 같고(MongoDB의 {f: null}), Date는 getTime이 같으면 같다. */
function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (isDate(expected)) {
    return isDate(actual) && actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

/** 문자열을 코드 포인트 순으로 비교한다. ★ MongoDB의 기본 문자열 비교(바이너리 순)와 같다 */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * 범위 비교다. 둘 다 숫자, 둘 다 문자열, 둘 다 Date일 때만 비교하고 그 밖(타입이 섞임·필드 없음)은
 * undefined(불일치)다.
 */
function compareRange(actual: unknown, operand: unknown): number | undefined {
  if (typeof actual === 'number' && typeof operand === 'number') return actual - operand;
  if (typeof actual === 'string' && typeof operand === 'string') {
    return compareCodePoints(actual, operand);
  }
  if (isDate(actual) && isDate(operand)) {
    return actual.getTime() - operand.getTime();
  }
  return undefined;
}

/** $regex 연산자 한 건을 평가한다. 문자열 값에만 맞는다. */
function matchRegex(actual: unknown, pattern: unknown, options: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const flags = typeof options === 'string' ? options : '';
  if (!/^[imsx]*$/.test(flags)) {
    throw new Error(`fake-mongo: 지원하지 않는 $options ${flags}`);
  }
  const source = isRegExp(pattern) ? pattern.source : String(pattern);
  // ★ x(확장) 옵션은 JS에 없어 지원하지 않는다
  if (flags.includes('x')) throw new Error('fake-mongo: 지원하지 않는 $options x');
  return new RegExp(source, flags).test(actual);
}

/** 필드 값 하나가 조건에 맞는지 본다. */
function matchField(actual: unknown, expected: unknown): boolean {
  if (isRegExp(expected)) return matchRegex(actual, expected, '');
  if (!isOperatorObject(expected)) return valuesEqual(actual, expected);
  return Object.entries(expected).every(([op, operand]) => {
    if (op === '$in') return (operand as unknown[]).some((item) => valuesEqual(actual, item));
    if (op === '$nin') return !(operand as unknown[]).some((item) => valuesEqual(actual, item));
    if (op === '$eq') return valuesEqual(actual, operand);
    if (op === '$ne') return !valuesEqual(actual, operand);
    if (op === '$regex') return matchRegex(actual, operand, expected.$options);
    // ★ $options는 $regex와 함께 위에서 소비한다. 혼자 쓰이면 오류다
    if (op === '$options') {
      if (!('$regex' in expected)) throw new Error('fake-mongo: $options는 $regex와 함께만 쓴다');
      return true;
    }
    // ★ 실제 MongoDB처럼 필드가 없거나 비교할 수 없는 타입이면 불일치다
    if (op === '$gte' || op === '$gt' || op === '$lte' || op === '$lt') {
      const diff = compareRange(actual, operand);
      if (diff === undefined) return false;
      if (op === '$gte') return diff >= 0;
      if (op === '$gt') return diff > 0;
      if (op === '$lte') return diff <= 0;
      return diff < 0;
    }
    throw new Error(`fake-mongo: 지원하지 않는 필드 연산자 ${op}`);
  });
}

/** 문서가 필터에 맞는지 본다. */
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as Doc[]).some((sub) => matches(doc, sub));
    if (key === '$and') return (expected as Doc[]).every((sub) => matches(doc, sub));
    if (key.startsWith('$')) throw new Error(`fake-mongo: 지원하지 않는 최상위 연산자 ${key}`);
    return matchField(getPath(doc, key), expected);
  });
}

/** 적용할 projection이다. include가 null이면 _id만 뺀다(가짜 문서에는 _id가 없어 그대로다). */
interface ProjectionPlan {
  include: string[] | null;
}

/**
 * 조회 옵션이 지원 범위인지 확인하고 projection 계획을 만든다.
 * 지원: { _id: 0 } 또는 { _id: 0, a: 1, … }(최상위 키 고르기). 점 경로, _id 밖의 0, 0과 1 섞기는 오류다.
 */
function planFindOptions(options: FindOptions | undefined): ProjectionPlan {
  if (options === undefined) return { include: null };
  const unknownKeys = Object.keys(options).filter((key) => key !== 'projection');
  if (unknownKeys.length > 0) {
    throw new Error(`fake-mongo: 지원하지 않는 조회 옵션 ${unknownKeys.join(',')}`);
  }
  const projection = options.projection;
  if (projection === undefined) return { include: null };
  const fields = Object.entries(projection).filter(([key]) => key !== '_id');
  if ('_id' in projection && projection._id !== 0) {
    throw new Error('fake-mongo: 지원하지 않는 projection (_id는 0만 지원)');
  }
  for (const [key, flag] of fields) {
    if (key.includes('.')) throw new Error('fake-mongo: 지원하지 않는 projection (점 경로)');
    if (flag !== 1) {
      throw new Error('fake-mongo: 지원하지 않는 projection (_id 밖에서 0과 1을 섞을 수 없다)');
    }
  }
  return { include: fields.length === 0 ? null : fields.map(([key]) => key) };
}

/** projection 계획을 문서에 적용한다. */
function applyProjection(doc: Doc, plan: ProjectionPlan): Doc {
  if (plan.include === null) return doc;
  const picked: Doc = {};
  for (const key of plan.include) {
    if (key in doc) picked[key] = doc[key];
  }
  return picked;
}

/** BSON 비교 순서의 타입 순위다. ★ null과 필드 없음은 같은 값이고 가장 작다 */
function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'string') return 2;
  if (Array.isArray(value)) return 4;
  if (typeof value === 'boolean') return 5;
  if (isDate(value)) return 6;
  if (isRegExp(value)) return 7;
  return 3; // 객체
}

/** 두 값을 정렬용으로 비교한다. 타입이 다르면 BSON 비교 순서다. */
function compareValues(a: unknown, b: unknown): number {
  const rank = typeRank(a) - typeRank(b);
  if (rank !== 0) return Math.sign(rank);
  if (a === null || a === undefined) return 0;
  if (typeof a === 'number') return Math.sign(a - (b as number));
  // ★ 문자열은 코드 포인트 순이다 (UTF-16 코드 유닛 순이면 U+FFFF 위 문자가 어긋난다)
  if (typeof a === 'string') return Math.sign(compareCodePoints(a, b as string));
  if (typeof a === 'boolean') return Number(a) - Number(b as boolean);
  if (isDate(a)) return Math.sign(a.getTime() - (b as Date).getTime());
  throw new Error('fake-mongo: 지원하지 않는 정렬 값(객체·배열·정규식)');
}

/** 정렬 조건대로 배열을 제자리에서 정렬한다. */
function sortDocs(docs: Doc[], spec: Record<string, 1 | -1>): void {
  const entries = Object.entries(spec);
  docs.sort((a, b) => {
    for (const [field, direction] of entries) {
      const result = compareValues(getPath(a, field), getPath(b, field)) * direction;
      if (result !== 0) return result;
    }
    return 0;
  });
}

/** 고유 키 충돌 오류를 만든다. 실제 드라이버처럼 code가 11000이다. */
function duplicateKeyError(keys: string[]): Error {
  return Object.assign(new Error(`E11000 duplicate key error: ${keys.join(',')}`), {
    code: 11000,
  });
}

/** 음이 아닌 정수인지 확인한다. */
function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`fake-mongo: ${name}은 0 이상의 정수여야 한다`);
  }
}

/** $group 단계의 모양을 확인하고 { 그룹 필드, 결과 이름 }을 준다. */
function parseGroup(stage: unknown): { field: string; name: string } {
  const spec = stage as Doc;
  const keys = Object.keys(spec);
  const idExpr = spec._id;
  const named = keys.filter((key) => key !== '_id');
  if (typeof idExpr !== 'string' || !idExpr.startsWith('$') || named.length !== 1) {
    throw new Error('fake-mongo: 지원하지 않는 $group (_id: "$필드"와 $first 하나만 지원)');
  }
  const accumulator = spec[named[0]] as Doc;
  const accKeys = Object.keys(accumulator ?? {});
  if (accKeys.length !== 1 || accKeys[0] !== '$first' || accumulator.$first !== '$$ROOT') {
    throw new Error('fake-mongo: 지원하지 않는 $group (이름: { $first: "$$ROOT" }만 지원)');
  }
  return { field: idExpr.slice(1), name: named[0] };
}

/** aggregate 파이프라인을 실행한다. 지원 단계: $match, $sort, $group($first), $replaceRoot, $project({_id:0}). */
function runPipeline(source: Doc[], pipeline: Doc[]): Doc[] {
  let docs = source.map((doc) => structuredClone(doc));
  for (const stage of pipeline) {
    const keys = Object.keys(stage);
    if (keys.length !== 1) throw new Error('fake-mongo: 지원하지 않는 파이프라인 단계 모양');
    const [name] = keys;
    const body = stage[name];
    if (name === '$match') {
      docs = docs.filter((doc) => matches(doc, body as Doc));
    } else if (name === '$sort') {
      sortDocs(docs, body as Record<string, 1 | -1>);
    } else if (name === '$group') {
      const { field, name: resultName } = parseGroup(body);
      const groups = new Map<string, Doc>();
      for (const doc of docs) {
        const value = getPath(doc, field);
        // ★ 실제 MongoDB처럼 null과 필드 없음은 _id가 null인 한 그룹이다
        const id = value === undefined ? null : value;
        const key =
          id === null ? 'null' : isDate(id) ? `d:${id.getTime()}` : `${typeof id}:${String(id)}`;
        if (!groups.has(key)) groups.set(key, { _id: id, [resultName]: doc });
      }
      docs = [...groups.values()];
    } else if (name === '$replaceRoot') {
      const newRoot = (body as Doc).newRoot;
      if (
        typeof newRoot !== 'string' ||
        !newRoot.startsWith('$') ||
        Object.keys(body as Doc).length !== 1
      ) {
        throw new Error('fake-mongo: 지원하지 않는 $replaceRoot ({ newRoot: "$이름" }만 지원)');
      }
      docs = docs.map((doc) => getPath(doc, newRoot.slice(1)) as Doc);
    } else if (name === '$project') {
      const spec = body as Doc;
      if (Object.keys(spec).length !== 1 || spec._id !== 0) {
        throw new Error('fake-mongo: 지원하지 않는 $project ({ _id: 0 }만 지원)');
      }
      docs = docs.map((doc) => {
        const { _id: removed, ...rest } = doc;
        void removed;
        return rest;
      });
    } else {
      throw new Error(`fake-mongo: 지원하지 않는 파이프라인 단계 ${name}`);
    }
  }
  return docs;
}

/** 예약된 실패 한 건이다. */
interface PlannedFailure {
  error: Error;
  insertFirst: number | null;
}

/** 메모리 가짜 Db를 만든다. */
export function createFakeDb(): FakeDb {
  const stores = new Map<string, Doc[]>();
  const collections = new Map<string, FakeCollection>();
  const uniqueKeys = new Map<string, string[][]>();
  const failures = new Map<FailableOp, PlannedFailure[]>();
  const calls: FakeCall[] = [];

  /** 컬렉션의 문서 배열을 얻는다. */
  const storeOf = (name: string): Doc[] => {
    let store = stores.get(name);
    if (store === undefined) {
      store = [];
      stores.set(name, store);
    }
    return store;
  };

  /** 호출을 기록하고 기록 객체를 준다. 예약된 실패는 따로 꺼낸다. */
  const record = (op: string, filter?: unknown, options?: unknown): FakeCall => {
    const entry: FakeCall = { op, filter };
    if (options !== undefined) entry.options = options;
    calls.push(entry);
    return entry;
  };

  /** 예약된 실패를 꺼낸다. */
  const takeFailure = (op: string): PlannedFailure | undefined =>
    failures.get(op as FailableOp)?.shift();

  /** 호출을 기록하고 예약된 실패가 있으면 던진다. */
  const begin = (op: string, filter?: unknown, options?: unknown): FakeCall => {
    const entry = record(op, filter, options);
    const failure = takeFailure(op);
    if (failure !== undefined) throw failure.error;
    return entry;
  };

  /** 문서 하나를 고유 키 검사 뒤 넣는다. 충돌하면 던진다. */
  const insertChecked = (name: string, doc: Doc): void => {
    const store = storeOf(name);
    for (const keys of uniqueKeys.get(name) ?? []) {
      const signature = JSON.stringify(keys.map((k) => doc[k]));
      if (store.some((stored) => JSON.stringify(keys.map((k) => stored[k])) === signature)) {
        throw duplicateKeyError(keys);
      }
    }
    store.push(doc);
  };

  /** 일치한 문서의 값을 바꾸고 반환 값을 만든다. */
  const applySet = (
    targets: Doc[],
    update: FakeUpdate,
  ): { matchedCount: number; modifiedCount: number } => {
    const keys = Object.keys(update);
    if (keys.length === 0 || keys.some((key) => key !== '$set' && key !== '$inc')) {
      throw new Error('fake-mongo: 지원하지 않는 update 연산자 ($set·$inc만 지원)');
    }
    const sets = Object.entries(update.$set ?? {});
    const incs = Object.entries(update.$inc ?? {});
    let modifiedCount = 0;
    for (const doc of targets) {
      const changed =
        sets.some(([key, value]) => !valuesEqual(getPath(doc, key), value)) ||
        incs.some(([, by]) => by !== 0);
      for (const [key, value] of sets) {
        setPath(doc, key, structuredClone(value));
      }
      for (const [key, by] of incs) {
        const current = getPath(doc, key);
        // ★ 실제 MongoDB처럼 숫자가 아닌 필드에 $inc하면 오류다. 없는 필드는 0에서 시작한다
        if (current !== undefined && typeof current !== 'number') {
          throw new Error('fake-mongo: $inc 대상이 숫자가 아니다');
        }
        setPath(doc, key, ((current as number | undefined) ?? 0) + (by as number));
      }
      if (changed) modifiedCount += 1;
    }
    return { matchedCount: targets.length, modifiedCount };
  };

  /** 컬렉션 하나를 만든다. */
  const makeCollection = (name: string): FakeCollection => ({
    createIndex: async (spec, options) => {
      calls.push({ op: 'createIndex' });
      if (options?.unique === true) {
        const list = uniqueKeys.get(name) ?? [];
        list.push(Object.keys(spec));
        uniqueKeys.set(name, list);
      }
      return options?.name ?? Object.keys(spec).join('_');
    },
    insertOne: async (doc) => {
      begin('insertOne');
      insertChecked(name, structuredClone(doc));
      return { acknowledged: true };
    },
    insertMany: async (docs) => {
      const entry = record('insertMany');
      const failure = takeFailure('insertMany');
      const incoming = docs.map((doc) => structuredClone(doc));
      // ★ ordered 동작이다: 앞 문서까지 넣고 충돌·주입 실패에서 멈춘다
      const limit = failure === undefined ? incoming.length : (failure.insertFirst ?? 0);
      let inserted = 0;
      try {
        for (const doc of incoming.slice(0, limit)) {
          insertChecked(name, doc);
          inserted += 1;
        }
      } finally {
        entry.returned = inserted;
      }
      if (failure !== undefined) throw failure.error;
      return { insertedCount: inserted };
    },
    find: (filter, options) => {
      const entry = begin('find', filter, options === undefined ? undefined : { ...options });
      const plan = planFindOptions(options);
      let sortSpec: Record<string, 1 | -1> | null = null;
      let skipCount = 0;
      let limitCount = 0;
      /** 커서에서 건 조건을 호출 기록 옵션에 남긴다. */
      const note = (key: string, value: unknown): void => {
        entry.options = { ...((entry.options as Doc | undefined) ?? {}), [key]: value };
      };
      const cursor: FakeCursor = {
        sort: (spec) => {
          sortSpec = spec;
          note('sort', spec);
          return cursor;
        },
        skip: (count) => {
          assertCount('skip', count);
          skipCount = count;
          note('skip', count);
          return cursor;
        },
        limit: (count) => {
          assertCount('limit', count);
          limitCount = count;
          note('limit', count);
          return cursor;
        },
        toArray: async () => {
          let found = storeOf(name).filter((doc) => matches(doc, filter));
          if (sortSpec !== null) sortDocs(found, sortSpec);
          found = found.slice(skipCount);
          if (limitCount > 0) found = found.slice(0, limitCount);
          entry.returned = found.length;
          return found.map((doc) => structuredClone(applyProjection(doc, plan)));
        },
      };
      return cursor;
    },
    findOne: async (filter, options) => {
      const entry = begin('findOne', filter, options === undefined ? undefined : { ...options });
      const plan = planFindOptions(options);
      const found = storeOf(name).find((doc) => matches(doc, filter));
      entry.returned = found === undefined ? 0 : 1;
      return found === undefined ? null : structuredClone(applyProjection(found, plan));
    },
    countDocuments: async (filter = {}) => {
      const entry = begin('countDocuments', filter);
      const count = storeOf(name).filter((doc) => matches(doc, filter)).length;
      entry.returned = count;
      return count;
    },
    aggregate: (pipeline) => {
      // ★ 실제 드라이버처럼 aggregate 호출은 던지지 않고, 예약된 실패는 toArray에서 거부로 나온다
      const entry = record('aggregate', undefined, pipeline);
      return {
        toArray: async () => {
          const failure = takeFailure('aggregate');
          if (failure !== undefined) throw failure.error;
          const result = runPipeline(storeOf(name), pipeline);
          entry.returned = result.length;
          return result;
        },
      };
    },
    updateOne: async (filter, update) => {
      begin('updateOne', filter);
      const first = storeOf(name).find((doc) => matches(doc, filter));
      return applySet(first === undefined ? [] : [first], update);
    },
    updateMany: async (filter, update) => {
      begin('updateMany', filter);
      return applySet(
        storeOf(name).filter((doc) => matches(doc, filter)),
        update,
      );
    },
    deleteMany: async (filter) => {
      begin('deleteMany', filter);
      const store = storeOf(name);
      const kept = store.filter((doc) => !matches(doc, filter));
      const deletedCount = store.length - kept.length;
      store.length = 0;
      for (const doc of kept) store.push(doc);
      return { deletedCount };
    },
  });

  return {
    collection: (name) => {
      let collection = collections.get(name);
      if (collection === undefined) {
        collection = makeCollection(name);
        collections.set(name, collection);
      }
      return collection;
    },
    dump: (name) => storeOf(name).map((doc) => structuredClone(doc)),
    failNext: (op, error, options) => {
      if (options?.insertFirst !== undefined && op !== 'insertMany') {
        throw new Error('fake-mongo: insertFirst는 insertMany에서만 쓴다');
      }
      const queue = failures.get(op) ?? [];
      queue.push({ error, insertFirst: options?.insertFirst ?? null });
      failures.set(op, queue);
    },
    calls,
  };
}
