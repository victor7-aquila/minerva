/** 가짜가 지원하는 실패 주입 대상 연산이다. */
type FailableOp =
  'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteMany' | 'find' | 'findOne';

/** 문서 한 건이다. */
type Doc = Record<string, unknown>;

/** 가짜 컬렉션의 커서다. */
export interface FakeCursor {
  sort(spec: Record<string, 1 | -1>): FakeCursor;
  toArray(): Promise<Doc[]>;
}

/** 메모리 가짜 컬렉션이다. assets·indexing·documents 저장소가 쓰는 연산만 지원한다. */
export interface FakeCollection {
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean; name?: string },
  ): Promise<string>;
  insertOne(doc: Doc): Promise<{ acknowledged: boolean }>;
  insertMany(docs: Doc[]): Promise<{ insertedCount: number }>;
  find(filter: Doc, options?: { projection?: Record<string, number> }): FakeCursor;
  findOne(filter: Doc, options?: { projection?: Record<string, number> }): Promise<Doc | null>;
  updateOne(
    filter: Doc,
    update: { $set: Doc },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(
    filter: Doc,
    update: { $set: Doc },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteMany(filter: Doc): Promise<{ deletedCount: number }>;
}

/** 메모리 가짜 Db다. */
export interface FakeDb {
  /** 같은 이름이면 같은 객체 */
  collection(name: string): FakeCollection;
  /** 컬렉션의 현재 문서 복사본(삽입 순서) */
  dump(name: string): Record<string, unknown>[];
  /** 다음 호출 하나를 실패시킨다. 예: failNext('updateOne', new Error('boom')) */
  failNext(op: FailableOp, error: Error): void;
  /** 연산 호출 기록 [{ op, filter }] */
  readonly calls: Array<{ op: string; filter?: unknown }>;
}

/**
 * Date인지 본다.
 * ★ structuredClone이 만든 Date는 Jest 샌드박스의 Date와 다른 영역(realm)이라 instanceof가 거짓이 된다
 */
function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** 값이 연산자 객체({ $in … })인지 본다. */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
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

/** 범위 비교다. 둘 다 숫자이거나 둘 다 Date일 때만 비교하고, 그 밖은 undefined(불일치)다. */
function compareRange(actual: unknown, operand: unknown): number | undefined {
  if (typeof actual === 'number' && typeof operand === 'number') return actual - operand;
  if (isDate(actual) && isDate(operand)) {
    return actual.getTime() - operand.getTime();
  }
  return undefined;
}

/** 필드 값 하나가 조건에 맞는지 본다. */
function matchField(actual: unknown, expected: unknown): boolean {
  if (!isOperatorObject(expected)) return valuesEqual(actual, expected);
  return Object.entries(expected).every(([op, operand]) => {
    if (op === '$in') return (operand as unknown[]).some((item) => valuesEqual(actual, item));
    if (op === '$ne') return !valuesEqual(actual, operand);
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

/** 조회 옵션이 지원 범위인지 확인한다. */
function checkFindOptions(options: { projection?: Record<string, number> } | undefined): void {
  if (options === undefined) return;
  const unknownKeys = Object.keys(options).filter((key) => key !== 'projection');
  if (unknownKeys.length > 0) {
    throw new Error(`fake-mongo: 지원하지 않는 조회 옵션 ${unknownKeys.join(',')}`);
  }
  const projection = options.projection;
  if (projection !== undefined) {
    const keys = Object.keys(projection);
    if (keys.length !== 1 || keys[0] !== '_id' || projection._id !== 0) {
      throw new Error('fake-mongo: 지원하지 않는 projection (_id: 0만 지원)');
    }
  }
}

/** 두 값을 정렬용으로 비교한다. */
function compareValues(a: unknown, b: unknown): number {
  if (isDate(a) && isDate(b)) return Math.sign(a.getTime() - b.getTime());
  if (a === b) return 0;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

/** 고유 키 충돌 오류를 만든다. 실제 드라이버처럼 code가 11000이다. */
function duplicateKeyError(keys: string[]): Error {
  return Object.assign(new Error(`E11000 duplicate key error: ${keys.join(',')}`), {
    code: 11000,
  });
}

/** 메모리 가짜 Db를 만든다. */
export function createFakeDb(): FakeDb {
  const stores = new Map<string, Doc[]>();
  const collections = new Map<string, FakeCollection>();
  const uniqueKeys = new Map<string, string[][]>();
  const failures = new Map<FailableOp, Error[]>();
  const calls: Array<{ op: string; filter?: unknown }> = [];

  /** 컬렉션의 문서 배열을 얻는다. */
  const storeOf = (name: string): Doc[] => {
    let store = stores.get(name);
    if (store === undefined) {
      store = [];
      stores.set(name, store);
    }
    return store;
  };

  /** 호출을 기록하고 예약된 실패가 있으면 던진다. */
  const begin = (op: string, filter?: unknown): void => {
    calls.push({ op, filter });
    const queue = failures.get(op as FailableOp);
    const error = queue?.shift();
    if (error !== undefined) throw error;
  };

  /** 일치한 문서의 값을 바꾸고 반환 값을 만든다. */
  const applySet = (
    targets: Doc[],
    update: { $set: Doc },
  ): { matchedCount: number; modifiedCount: number } => {
    const keys = Object.keys(update);
    if (keys.length !== 1 || keys[0] !== '$set') {
      throw new Error('fake-mongo: 지원하지 않는 update 연산자 ($set만 지원)');
    }
    let modifiedCount = 0;
    for (const doc of targets) {
      const changed = Object.entries(update.$set).some(
        ([key, value]) => !valuesEqual(getPath(doc, key), value),
      );
      for (const [key, value] of Object.entries(update.$set)) {
        setPath(doc, key, structuredClone(value));
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
      const store = storeOf(name);
      const incoming = structuredClone(doc);
      for (const keys of uniqueKeys.get(name) ?? []) {
        const signature = JSON.stringify(keys.map((k) => incoming[k]));
        if (store.some((stored) => JSON.stringify(keys.map((k) => stored[k])) === signature)) {
          throw duplicateKeyError(keys);
        }
      }
      store.push(incoming);
      return { acknowledged: true };
    },
    insertMany: async (docs) => {
      begin('insertMany');
      const store = storeOf(name);
      const incoming = docs.map((doc) => structuredClone(doc));
      for (const keys of uniqueKeys.get(name) ?? []) {
        const seen = new Set(store.map((doc) => JSON.stringify(keys.map((k) => doc[k]))));
        for (const doc of incoming) {
          const signature = JSON.stringify(keys.map((k) => doc[k]));
          if (seen.has(signature)) {
            throw duplicateKeyError(keys);
          }
          seen.add(signature);
        }
      }
      store.push(...incoming);
      return { insertedCount: incoming.length };
    },
    find: (filter, options) => {
      begin('find', filter);
      checkFindOptions(options);
      let sortSpec: Record<string, 1 | -1> | null = null;
      const cursor: FakeCursor = {
        sort: (spec) => {
          sortSpec = spec;
          return cursor;
        },
        toArray: async () => {
          const found = storeOf(name).filter((doc) => matches(doc, filter));
          const spec = sortSpec;
          if (spec !== null) {
            const entries = Object.entries(spec);
            found.sort((a, b) => {
              for (const [field, direction] of entries) {
                const result = compareValues(a[field], b[field]) * direction;
                if (result !== 0) return result;
              }
              return 0;
            });
          }
          return found.map((doc) => structuredClone(doc));
        },
      };
      return cursor;
    },
    findOne: async (filter, options) => {
      begin('findOne', filter);
      checkFindOptions(options);
      const found = storeOf(name).find((doc) => matches(doc, filter));
      return found === undefined ? null : structuredClone(found);
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
      store.push(...kept);
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
    failNext: (op, error) => {
      const queue = failures.get(op) ?? [];
      queue.push(error);
      failures.set(op, queue);
    },
    calls,
  };
}
