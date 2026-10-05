import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { InvalidRequestError } from '../../common';
import { MONGO_DB } from '../../storage';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import type { ListLogsQueryDto } from '../interfaces/list-logs-query.dto';
import { LogsCrudService } from './logs-crud.service';
import { LogsService } from './logs.service';
import type { LogInput } from '../interfaces/logs.types';

/** 문서 이름 센티널. 설명·애플리케이션 로그에 나오면 안 된다 */
const NAME_SENTINEL = '이름센티널-7c1e';
/** 판 표기 센티널 */
const LABEL_SENTINEL = '판센티널-v9';
/** 오류 메시지 센티널(저장 실패 오류의 message) */
const ERROR_SENTINEL = 'mongo-msg-SENTINEL-55';

// ★ nestjs-pino는 루트 로거를 파일당 하나만 만든다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

// 가짜 컬렉션: 호출을 기록한다
const fakeCollection = {
  insertOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  distinct: jest.fn(),
};
const fakeDb = { collection: jest.fn(() => fakeCollection), command: jest.fn() };

let moduleRef: TestingModule;
let service: LogsService;

/** 기본 입력을 만든다. */
function input(overrides: Partial<LogInput> = {}): LogInput {
  return {
    kind: 'upload',
    docId: 'doc-1',
    name: '설계서',
    editionLabel: 'v1',
    outcome: 'success',
    ...overrides,
  };
}

/** insertOne에 넘어간 문서를 꺼낸다. */
function savedDoc(call = 0): Record<string, unknown> {
  return fakeCollection.insertOne.mock.calls[call][0] as Record<string, unknown>;
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({ LOG_RETENTION_DAYS: 90 }, capture.stream)],
    providers: [LogsService, LogsCrudService, { provide: MONGO_DB, useValue: fakeDb }],
  }).compile(); // ★ init() 금지 — onModuleInit이 가짜 DB에 돌지 않게
  service = moduleRef.get(LogsService);
});

afterAll(async () => {
  await moduleRef.close();
});

beforeEach(() => {
  // ★ fakeDb.collection 호출 기록은 생성자에서 한 번 생긴다. 각 메서드 목만 되돌린다
  for (const fn of Object.values(fakeCollection)) {
    fn.mockReset();
  }
  fakeCollection.insertOne.mockResolvedValue({ acknowledged: true });
  capture.clear();
});

/** MODULE.md의 일곱 종류다(내부 상수에 기대지 않고 리터럴로 둔다). */
const KINDS = [
  'upload',
  'content_upload',
  'captioning',
  'processing_state',
  'edit',
  'delete',
  'replace',
] as const;

describe('REQ-BE-6.1.1', () => {
  it.each(KINDS)('T-REC-1 %s 기록은 insertOne을 한 번 부른다', async (kind) => {
    await service.record(input({ kind }));

    expect(fakeCollection.insertOne).toHaveBeenCalledTimes(1);
    expect(savedDoc().kind).toBe(kind);
    expect(fakeDb.collection).toHaveBeenCalledWith('logs');
  });

  it('T-REC-FAIL-1 저장이 실패해도 예외가 없고 식별자만 경고로 남는다', async () => {
    fakeCollection.insertOne.mockRejectedValue(
      Object.assign(new Error(ERROR_SENTINEL), { name: 'MongoServerError' }),
    );

    await expect(
      service.record(
        input({
          name: NAME_SENTINEL,
          editionLabel: LABEL_SENTINEL,
          kind: 'upload',
          docId: 'doc-1',
        }),
      ),
    ).resolves.toBeUndefined();

    const failed = capture.parsed().filter((line) => line.msg === 'logs.record_failed');
    expect(failed).toHaveLength(1);
    const entry = failed[0];
    expect(entry.level).toBe(40);
    expect(entry.kind).toBe('upload');
    expect(entry.docId).toBe('doc-1');
    expect(entry.errorName).toBe('MongoServerError');
    const allowed = new Set([
      'level',
      'time',
      'pid',
      'hostname',
      'context',
      'kind',
      'docId',
      'errorName',
      'msg',
    ]);
    expect(Object.keys(entry).filter((key) => !allowed.has(key))).toEqual([]);
    for (const line of capture.lines) {
      expect(line).not.toContain(NAME_SENTINEL);
      expect(line).not.toContain(LABEL_SENTINEL);
      expect(line).not.toContain(ERROR_SENTINEL);
      expect(line).not.toContain('문서를 올리지');
    }
  });

  it('T-REC-FAIL-2 insertOne이 동기로 던져도 거부되지 않는다', async () => {
    fakeCollection.insertOne.mockImplementation(() => {
      throw new TypeError('x');
    });

    await expect(service.record(input())).resolves.toBeUndefined();

    const failed = capture.parsed().filter((line) => line.msg === 'logs.record_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].errorName).toBe('TypeError');
  });

  it.each([['문자열 오류'], [{}]])(
    'T-REC-FAIL-3 Error가 아닌 값(%j)이 거부돼도 UnknownError로 남는다',
    async (rejected) => {
      fakeCollection.insertOne.mockRejectedValue(rejected);

      await expect(service.record(input())).resolves.toBeUndefined();

      const failed = capture.parsed().filter((line) => line.msg === 'logs.record_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].errorName).toBe('UnknownError');
    },
  );

  it('T-REC-FAIL-4 성공한 기록은 logs 로그 줄을 남기지 않는다', async () => {
    await service.record(input());

    const own = capture
      .parsed()
      .filter((line) => typeof line.msg === 'string' && line.msg.startsWith('logs.'));
    expect(own).toEqual([]);
  });
});

describe('REQ-BE-6.1.2', () => {
  it('T-REC-2 저장 문서의 필드가 여덟 개로 정확하다', async () => {
    const before = Date.now();
    await service.record({
      kind: 'processing_state',
      docId: 'doc-7',
      name: '설계서',
      editionLabel: 'v2',
      outcome: 'failure',
      detail: { fromState: 'indexing', toState: 'failed', reasonCode: 'EMBEDDING_FAILED' },
    });
    const after = Date.now();

    const doc = savedDoc();
    expect(Object.keys(doc).sort()).toEqual(
      [
        'logId',
        'occurredAt',
        'kind',
        'docId',
        'name',
        'editionLabel',
        'outcome',
        'description',
      ].sort(),
    );
    expect(typeof doc.logId).toBe('string');
    expect((doc.logId as string).length).toBeGreaterThan(0);
    expect(doc.occurredAt).toBeInstanceOf(Date);
    const time = (doc.occurredAt as Date).getTime();
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
    expect(doc.docId).toBe('doc-7');
    expect(doc.name).toBe('설계서');
    expect(doc.editionLabel).toBe('v2');
    expect(doc.outcome).toBe('failure');
    expect(doc.description).toBe(
      '처리 상태가 색인 중에서 실패로 바뀌었습니다 (사유 EMBEDDING_FAILED)',
    );
  });

  it('T-REC-3 판 표기가 없으면 editionLabel 키가 null로 있다', async () => {
    await service.record(input({ editionLabel: null }));

    const doc = savedDoc();
    expect('editionLabel' in doc).toBe(true);
    expect(doc.editionLabel).toBeNull();
  });

  it('T-REC-4 기록마다 logId가 다르다', async () => {
    await service.record(input());
    await service.record(input());

    expect(savedDoc(0).logId).not.toBe(savedDoc(1).logId);
  });
});

describe('REQ-BE-6.1.3', () => {
  it('T-REC-5 이름·판 표기·자유 문장이 설명과 저장 필드에 들어가지 않는다', async () => {
    const base: LogInput = {
      kind: 'processing_state',
      docId: 'doc-1',
      name: NAME_SENTINEL,
      editionLabel: LABEL_SENTINEL,
      outcome: 'failure',
      detail: { reasonCode: NAME_SENTINEL, replacedByDocId: 'doc-x' },
    };
    const forced = {
      ...base,
      message: '본문센티널',
      detail: { ...base.detail, text: '본문센티널' },
    } as unknown as LogInput;

    await service.record(forced);

    const doc = savedDoc();
    expect(Object.keys(doc).sort()).toEqual(
      [
        'logId',
        'occurredAt',
        'kind',
        'docId',
        'name',
        'editionLabel',
        'outcome',
        'description',
      ].sort(),
    );
    const description = doc.description as string;
    expect(description).not.toContain(NAME_SENTINEL);
    expect(description).not.toContain(LABEL_SENTINEL);
    expect(description).not.toContain('본문센티널');
    expect(description).not.toContain('doc-x');
  });
});

describe('REQ-BE-6.2.2', () => {
  it.each([[{ from: '2026-02-30' }], [{ to: '2026-13-01' }]])(
    'T-LIST-UNIT-1 없는 날짜 %j는 InvalidRequestError로 거부되고 DB를 부르지 않는다',
    async (query) => {
      await expect(service.list(query as ListLogsQueryDto)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );

      expect(fakeCollection.find).not.toHaveBeenCalled();
      expect(fakeCollection.countDocuments).not.toHaveBeenCalled();
    },
  );
});
