import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { RagUnavailableError } from '../../common';
import type { AppConfig } from '../../common';
import { RagClient, RagRequestError } from '../../rag';
import type {
  RagEdition,
  RagIndexJob,
  RagIndexJobAccepted,
  RagIndexRequest,
  RagIndexState,
} from '../../rag';
import { MONGO_DB } from '../../storage';
import { createFakeDb } from '../../../test/support/fake-mongo';
import type { FakeDb } from '../../../test/support/fake-mongo';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import { INDEX_JOB_STATE_CHANGED } from '../interfaces/indexing.events';
import type { IndexJobStateChangedEvent } from '../interfaces/indexing.events';
import { IndexingService } from './indexing.service';
import type { IndexRequestInput, RagEventNotification } from '../interfaces/indexing.types';
import { IndexingCrudService } from './indexing-crud.service';

// ★ nestjs-pino는 루트 로거를 파일당 하나만 만든다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

/** pino가 넣는 기본 필드다. 로그 필드 비교에서 뺀다 */
const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
/** 로그 비노출 검사용 센티널이다. */
const MD_SENT = 'MD-SENT-81';
const HINT_SENT = 'HINT-SENT-82';
const NAME_SENT = 'NAME-SENT-83';
const LABEL_SENT = 'LABEL-SENT-84';
const DATE_SENT = '2099-08-05';
const FAILMSG_SENT = 'FAILMSG-SENT-86';
/** 대체 실패 사유다(REQ-BE-3.2.3) */
const UNREACHABLE_FAILURE = {
  code: 'RAG_UNREACHABLE',
  message: 'RAG Server에서 실패 사유를 받지 못했습니다',
  headingPath: null,
  placeholderId: null,
};

const fakeRag = {
  submitIndexJob: jest.fn<Promise<RagIndexJobAccepted>, [req: RagIndexRequest]>(),
  getIndexJob: jest.fn<Promise<RagIndexJob>, [jobId: string]>(),
  getIndexStates: jest.fn<Promise<RagIndexState[]>, [docIds: readonly string[]]>(),
  updateMetadata: jest.fn<
    Promise<void>,
    [docId: string, name: string, edition: RagEdition | null]
  >(),
  deleteDocument: jest.fn<Promise<void>, [docId: string]>(),
};

let db: FakeDb;
let emitter: EventEmitter2;
let events: IndexJobStateChangedEvent[];
let moduleRef: TestingModule;
let service: IndexingService;

/** 끝나지 않는 Promise를 만든다. 경합 테스트에서 끼어들 순간을 고정하는 데 쓴다. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 설정을 받아 서비스를 만든다. */
async function build(config: Partial<AppConfig> = {}): Promise<void> {
  moduleRef = await Test.createTestingModule({
    imports: [
      createTestCommonModule(
        { CHUNKING_MODE: 'semantic', RAG_EVENTS_TOKEN: 'unit-token', ...config },
        capture.stream,
      ),
    ],
    providers: [
      IndexingService,
      IndexingCrudService,
      { provide: MONGO_DB, useValue: db },
      { provide: RagClient, useValue: fakeRag },
      { provide: EventEmitter2, useValue: emitter },
    ],
  }).compile();
  service = moduleRef.get(IndexingService);
  // ★ 고유 인덱스(docId)를 가짜 Db에도 건다
  await service.onModuleInit();
}

beforeEach(async () => {
  db = createFakeDb();
  emitter = new EventEmitter2();
  events = [];
  emitter.on(INDEX_JOB_STATE_CHANGED, (event: IndexJobStateChangedEvent) => {
    events.push(event);
  });
  capture.clear();
  for (const fn of Object.values(fakeRag)) fn.mockReset();
  await build();
});

afterEach(async () => {
  await moduleRef.close();
});

/** 알림 값을 만든다. */
function note(over: Partial<RagEventNotification> = {}): RagEventNotification {
  return {
    docId: 'doc-1',
    jobId: 'job-1',
    version: '3',
    jobState: 'running',
    searchableVersion: null,
    sequence: 1,
    ...over,
  };
}

/** RAG Server 작업 응답을 만든다. */
function job(over: Partial<RagIndexJob> = {}): RagIndexJob {
  return {
    jobId: 'job-1',
    docId: 'doc-1',
    version: '3',
    state: 'succeeded',
    stage: null,
    failure: null,
    result: { chunkCount: 12, fallbackUsed: false },
    ...over,
  };
}

/** RAG Server 색인 상태 응답을 만든다. */
function state(over: Partial<RagIndexState> = {}): RagIndexState {
  return {
    docId: 'doc-1',
    searchableVersion: null,
    latestJobId: 'job-1',
    latestJobState: 'running',
    latestJobStage: 'embedding',
    ...over,
  };
}

/** 색인 요청 입력을 만든다. */
function input(over: Partial<IndexRequestInput> = {}): IndexRequestInput {
  return {
    docId: 'doc-1',
    version: '3',
    indexingMarkdown: `# 제목 ${MD_SENT}`,
    hints: [{ placeholderId: 't1', text: HINT_SENT }],
    name: NAME_SENT,
    edition: { label: LABEL_SENT, editionDate: DATE_SENT },
    force: false,
    ...over,
  };
}

/** 접수 응답을 만든다. */
function accepted(over: Partial<RagIndexJobAccepted> = {}): RagIndexJobAccepted {
  return { outcome: 'queued', jobId: 'job-9', docId: 'doc-1', version: '3', ...over };
}

/** msg가 같은 로그 줄만 모은다. */
function logsOf(msg: string): Record<string, unknown>[] {
  return capture.parsed().filter((line) => line.msg === msg);
}

/** pino 기본 필드를 뺀 키 목록(정렬)이다. */
function fieldsOf(line: Record<string, unknown>): string[] {
  return Object.keys(line)
    .filter((key) => !PINO_BASE.includes(key))
    .sort();
}

/** pino 기본 필드를 뺀 값 객체다. */
function payloadOf(line: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(line).filter(([key]) => !PINO_BASE.includes(key)));
}

/** 문서의 순번 레코드를 읽는다. */
function cursor(docId: string): Record<string, unknown> | undefined {
  return db.dump('rag_event_cursors').find((doc) => doc.docId === docId);
}

/** 작업 ID별로 getIndexJob 응답을 정한다. */
function jobsById(map: Record<string, RagIndexJob | Error>): void {
  fakeRag.getIndexJob.mockImplementation(async (jobId) => {
    const found = map[jobId];
    if (found === undefined) throw new Error(`테스트에 없는 작업 ${jobId}`);
    if (found instanceof Error) throw found;
    return found;
  });
}

describe('REQ-BE-3.1.1', () => {
  it('T-REQ-1 색인 요청 인자를 입력과 설정 값으로 만든다', async () => {
    fakeRag.submitIndexJob.mockResolvedValue(accepted());
    const inp = input();
    await service.requestIndex(inp);
    expect(fakeRag.submitIndexJob).toHaveBeenCalledTimes(1);
    const arg = fakeRag.submitIndexJob.mock.calls[0][0];
    expect(arg).toEqual({
      docId: 'doc-1',
      version: '3',
      markdown: inp.indexingMarkdown,
      assets: [{ placeholderId: 't1', text: HINT_SENT }],
      name: NAME_SENT,
      edition: { label: LABEL_SENT, editionDate: DATE_SENT },
      chunking: 'semantic',
      force: false,
    });
    expect(Object.keys(arg).sort()).toEqual([
      'assets',
      'chunking',
      'docId',
      'edition',
      'force',
      'markdown',
      'name',
      'version',
    ]);
    // ★ 입력 배열을 그대로 넘기지 않고 복사한다
    expect(arg.assets).not.toBe(inp.hints);
  });

  it('T-REQ-1b 판 정보가 없고 힌트가 비어도 force를 입력 그대로 넘긴다', async () => {
    fakeRag.submitIndexJob.mockResolvedValue(accepted());
    await service.requestIndex(input({ edition: null, hints: [], force: true }));
    const arg = fakeRag.submitIndexJob.mock.calls[0][0];
    expect(arg.edition).toBeNull();
    expect(arg.assets).toEqual([]);
    expect(arg.force).toBe(true);
  });

  it('T-REQ-2 접수 결과를 accepted·reused로 옮긴다', async () => {
    const cases: Array<[RagIndexJobAccepted['outcome'], 'accepted' | 'reused']> = [
      ['queued', 'accepted'],
      ['joined', 'accepted'],
      ['reused', 'reused'],
    ];
    for (const [outcome, kind] of cases) {
      fakeRag.submitIndexJob.mockResolvedValue(accepted({ outcome, jobId: 'job-x' }));
      const result = await service.requestIndex(input());
      expect(result).toEqual({ kind, jobId: 'job-x' });
      expect(Object.keys(result).sort()).toEqual(['jobId', 'kind']);
    }
  });

  it('T-REQ-3 RAG Server에 닿지 않으면 unreachable이고 경고 로그를 남긴다', async () => {
    fakeRag.submitIndexJob.mockRejectedValue(new RagUnavailableError());
    await expect(service.requestIndex(input())).resolves.toEqual({ kind: 'unreachable' });
    const lines = logsOf('indexing.request_failed');
    expect(lines).toHaveLength(1);
    expect(payloadOf(lines[0])).toEqual({
      operation: 'requestIndex',
      docId: 'doc-1',
      code: 'RAG_UNAVAILABLE',
    });
    expect(lines[0].level).toBe(40);
  });

  it('T-REQ-4 RAG Server가 오류로 응답해도 unreachable이고 코드를 남긴다', async () => {
    fakeRag.submitIndexJob.mockRejectedValue(new RagRequestError(400, 'INVALID_REQUEST'));
    await expect(service.requestIndex(input())).resolves.toEqual({ kind: 'unreachable' });
    expect(logsOf('indexing.request_failed')[0].code).toBe('INVALID_REQUEST');
  });

  it('T-REQ-5 계약 밖 outcome이면 INVALID_RESPONSE로 unreachable이다', async () => {
    fakeRag.submitIndexJob.mockResolvedValue({
      ...accepted(),
      outcome: 'weird',
    } as unknown as RagIndexJobAccepted);
    await expect(service.requestIndex(input())).resolves.toEqual({ kind: 'unreachable' });
    expect(logsOf('indexing.request_failed')[0].code).toBe('INVALID_RESPONSE');
  });

  it('T-REQ-6 예상 밖 예외는 그대로 던진다', async () => {
    const error = new Error('boom');
    fakeRag.submitIndexJob.mockRejectedValue(error);
    await expect(service.requestIndex(input())).rejects.toBe(error);
    expect(logsOf('indexing.request_failed')).toHaveLength(0);
  });

  it('T-REQ-7 요청 내용(MD·요약·이름·판)이 로그에 없다', async () => {
    fakeRag.submitIndexJob.mockResolvedValue(accepted());
    await service.requestIndex(input());
    fakeRag.submitIndexJob.mockRejectedValue(new RagUnavailableError());
    await service.requestIndex(input());
    const text = capture.lines.join('\n');
    for (const sentinel of [MD_SENT, HINT_SENT, NAME_SENT, LABEL_SENT, DATE_SENT]) {
      expect(text).not.toContain(sentinel);
    }
  });
});

describe('REQ-BE-3.1.2', () => {
  it('T-REQ-8 접수한 작업 ID를 응답 값 그대로 돌려준다', async () => {
    fakeRag.submitIndexJob.mockResolvedValue(accepted({ outcome: 'queued', jobId: 'job-q' }));
    await expect(service.requestIndex(input())).resolves.toEqual({
      kind: 'accepted',
      jobId: 'job-q',
    });
    fakeRag.submitIndexJob.mockResolvedValue(accepted({ outcome: 'reused', jobId: 'job-r' }));
    await expect(service.requestIndex(input())).resolves.toEqual({
      kind: 'reused',
      jobId: 'job-r',
    });
  });
});

describe('REQ-BE-3.1.3', () => {
  it('T-REQ-9 설정한 청킹 방식을 요청에 넣는다', async () => {
    fakeRag.submitIndexJob.mockResolvedValue(accepted());
    await service.requestIndex(input());
    expect(fakeRag.submitIndexJob.mock.calls[0][0].chunking).toBe('semantic');

    await moduleRef.close();
    await build({ CHUNKING_MODE: 'rule' });
    fakeRag.submitIndexJob.mockClear();
    await service.requestIndex(input());
    expect(fakeRag.submitIndexJob.mock.calls[0][0].chunking).toBe('rule');
  });
});

describe('REQ-BE-3.2.2', () => {
  it('T-NOTI-1 running 알림은 조회 없이 이벤트로 넘긴다', async () => {
    await service.handleNotification(
      note({ jobState: 'running', sequence: 1, searchableVersion: '2' }),
    );
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual([
      'docId',
      'failure',
      'jobId',
      'jobState',
      'result',
      'searchableVersion',
      'source',
      'version',
    ]);
    expect(events[0]).toEqual({
      docId: 'doc-1',
      version: '3',
      jobId: 'job-1',
      jobState: 'running',
      searchableVersion: '2',
      result: null,
      failure: null,
      source: 'notification',
    });
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
  });

  it('T-NOTI-2 succeeded 알림은 작업을 조회해 결과를 싣고 버전은 알림 값을 쓴다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(
      job({ version: '999', result: { chunkCount: 12, fallbackUsed: true } }),
    );
    await service.handleNotification(note({ jobState: 'succeeded', sequence: 1 }));
    expect(fakeRag.getIndexJob).toHaveBeenCalledTimes(1);
    expect(fakeRag.getIndexJob).toHaveBeenCalledWith('job-1');
    expect(events).toHaveLength(1);
    expect(events[0].result).toEqual({ chunkCount: 12, fallbackUsed: true });
    expect(Object.keys(events[0].result ?? {})).toHaveLength(2);
    expect(events[0].failure).toBeNull();
    expect(events[0].version).toBe('3');
  });

  it('T-NOTI-3 queued·superseded 알림은 조회 없이 결과·실패 사유가 null이다', async () => {
    await service.handleNotification(note({ jobState: 'queued', sequence: 1 }));
    await service.handleNotification(note({ jobState: 'superseded', sequence: 2 }));
    expect(events.map((e) => e.jobState)).toEqual(['queued', 'superseded']);
    for (const event of events) {
      expect(event.result).toBeNull();
      expect(event.failure).toBeNull();
    }
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
  });

  it('T-NOTI-4 결과 조회에 실패하면 이벤트도 순번도 없고 다시 보내면 반영된다', async () => {
    fakeRag.getIndexJob.mockRejectedValue(new RagUnavailableError());
    await expect(
      service.handleNotification(note({ jobState: 'succeeded', sequence: 1 })),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(cursor('doc-1')).toBeUndefined();
    const failed = logsOf('indexing.request_failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])).toEqual({
      operation: 'getIndexJob',
      docId: 'doc-1',
      code: 'RAG_UNAVAILABLE',
    });
    expect(logsOf('indexing.event_received')[0].applied).toBe(false);

    fakeRag.getIndexJob.mockReset();
    fakeRag.getIndexJob.mockResolvedValue(job());
    await service.handleNotification(note({ jobState: 'succeeded', sequence: 1 }));
    expect(events).toHaveLength(1);
    expect(cursor('doc-1')?.lastSequence).toBe(1);
  });

  it('T-NOTI-5 결과가 비어 있으면 MISSING_RESULT로 반영하지 않는다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(job({ result: null }));
    await service.handleNotification(note({ jobState: 'succeeded', sequence: 1 }));
    expect(events).toHaveLength(0);
    expect(cursor('doc-1')).toBeUndefined();
    expect(logsOf('indexing.request_failed')[0].code).toBe('MISSING_RESULT');
  });

  it('T-NOTI-6 작업 조회는 순번 갱신보다 먼저 일어난다', async () => {
    let opsAtFetch: string[] = [];
    fakeRag.getIndexJob.mockImplementation(async () => {
      opsAtFetch = db.calls.map((call) => call.op);
      return job();
    });
    await service.handleNotification(note({ jobState: 'succeeded', sequence: 1 }));
    expect(opsAtFetch).not.toContain('updateOne');
    expect(opsAtFetch).not.toContain('insertOne');
  });

  it('T-NOTI-7 받는 쪽이 실패해도 순번은 올라가고 경고 로그만 남긴다', async () => {
    const syncFail = (): void => {
      throw new Error('LISTENER-SECRET');
    };
    emitter.on(INDEX_JOB_STATE_CHANGED, syncFail);
    await expect(service.handleNotification(note({ sequence: 1 }))).resolves.toBeUndefined();
    expect(cursor('doc-1')?.lastSequence).toBe(1);
    emitter.off(INDEX_JOB_STATE_CHANGED, syncFail);

    emitter.on(INDEX_JOB_STATE_CHANGED, async () => {
      throw new Error('LISTENER-SECRET');
    });
    await expect(service.handleNotification(note({ sequence: 2 }))).resolves.toBeUndefined();
    expect(cursor('doc-1')?.lastSequence).toBe(2);

    const dispatchFailed = logsOf('indexing.event_dispatch_failed');
    expect(dispatchFailed).toHaveLength(2);
    for (const line of dispatchFailed) {
      expect(payloadOf(line)).toEqual({
        docId: 'doc-1',
        jobId: 'job-1',
        source: 'notification',
        errorName: 'Error',
      });
      expect(line.level).toBe(40);
    }
    expect(capture.lines.join('\n')).not.toContain('LISTENER-SECRET');
    expect(logsOf('indexing.event_received').map((l) => l.applied)).toEqual([true, true]);
  });

  it('T-NOTI-8 받는 쪽 처리가 끝날 때까지 기다린다', async () => {
    let done = false;
    emitter.on(INDEX_JOB_STATE_CHANGED, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      done = true;
    });
    await service.handleNotification(note());
    expect(done).toBe(true);
  });

  it('T-NOTI-9 같은 문서의 알림은 차례로 처리하고 다른 문서는 기다리지 않는다', async () => {
    const order: string[] = [];
    const doc1Seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    emitter.on(INDEX_JOB_STATE_CHANGED, async (event: IndexJobStateChangedEvent) => {
      if (event.docId === 'doc-1') {
        active += 1;
        maxActive = Math.max(maxActive, active);
        doc1Seen.push(event.jobState);
      }
      order.push(`enter:${event.docId}:${event.jobState}`);
      // 순번 4(running)만 오래 걸린다
      if (event.docId === 'doc-1' && event.jobState === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      order.push(`exit:${event.docId}:${event.jobState}`);
      if (event.docId === 'doc-1') active -= 1;
    });
    await Promise.all([
      service.handleNotification(note({ sequence: 4, jobState: 'running' })),
      service.handleNotification(note({ sequence: 5, jobState: 'queued' })),
      service.handleNotification(note({ docId: 'doc-2', sequence: 1 })),
    ]);
    expect(doc1Seen).toEqual(['running', 'queued']);
    expect(maxActive).toBe(1);
    expect(order.indexOf('enter:doc-2:running')).toBeLessThan(order.indexOf('exit:doc-1:running'));
    expect(order.indexOf('exit:doc-1:running')).toBeLessThan(order.indexOf('enter:doc-1:queued'));
  });

  it('T-NOTI-10 알림 하나에 event_received 한 줄을 남긴다', async () => {
    await service.handleNotification(note({ sequence: 2 }));
    await service.handleNotification(note({ sequence: 1 }));
    const lines = logsOf('indexing.event_received');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(fieldsOf(line)).toEqual(['applied', 'docId', 'jobId', 'jobState', 'sequence']);
      expect(line.level).toBe(30);
    }
    expect(lines.map((l) => l.applied)).toEqual([true, false]);
  });

  it('T-LOG-1 서비스 로그는 정해진 이벤트명과 필드만 쓴다', async () => {
    fakeRag.submitIndexJob.mockRejectedValue(new RagUnavailableError());
    await service.requestIndex(input());
    emitter.on(INDEX_JOB_STATE_CHANGED, () => {
      throw new Error('x');
    });
    await service.handleNotification(note({ sequence: 1 }));
    fakeRag.getIndexStates.mockResolvedValue([state({ docId: 'a', latestJobId: 'ja' })]);
    jobsById({ ja: job({ jobId: 'ja', docId: 'a', version: '5' }) });
    await service.reconcile(['a']);
    fakeRag.updateMetadata.mockRejectedValue(new RagUnavailableError());
    await service.updateMetadata('doc-1', NAME_SENT, null);

    const expected: Record<string, string[]> = {
      'indexing.event_received': ['applied', 'docId', 'jobId', 'jobState', 'sequence'],
      'indexing.request_failed': ['code', 'docId', 'operation'],
      'indexing.reconciled': ['docs', 'events'],
      'indexing.event_dispatch_failed': ['docId', 'errorName', 'jobId', 'source'],
    };
    const own = capture.parsed().filter((line) => line.context === 'IndexingService');
    expect(own.length).toBeGreaterThan(0);
    for (const line of own) {
      expect(Object.keys(expected)).toContain(line.msg);
      expect(fieldsOf(line)).toEqual(expected[line.msg as string]);
    }
    expect(new Set(own.map((l) => l.msg))).toEqual(new Set(Object.keys(expected)));
  });
});

describe('REQ-BE-3.2.3', () => {
  it('T-FAIL-1 failed 알림은 작업의 실패 사유를 싣는다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(
      job({
        state: 'failed',
        result: null,
        failure: {
          code: 'CHUNKING_FAILED',
          message: FAILMSG_SENT,
          headingPath: ['설치', '환경'],
          placeholderId: 't1',
        },
      }),
    );
    await service.handleNotification(note({ jobState: 'failed', sequence: 1 }));
    expect(fakeRag.getIndexJob).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].failure).toEqual({
      code: 'CHUNKING_FAILED',
      message: FAILMSG_SENT,
      headingPath: ['설치', '환경'],
      placeholderId: 't1',
    });
    expect(Object.keys(events[0].failure ?? {})).toHaveLength(4);
    expect(events[0].result).toBeNull();
  });

  it('T-FAIL-2 실패 사유를 받지 못하면 대체 사유로 발행하고 순번을 올린다', async () => {
    const causes: Array<[Error, string]> = [
      [new RagUnavailableError(), 'RAG_UNAVAILABLE'],
      [new RagRequestError(404, 'JOB_NOT_FOUND'), 'JOB_NOT_FOUND'],
    ];
    let sequence = 0;
    for (const [error, code] of causes) {
      sequence += 1;
      fakeRag.getIndexJob.mockReset();
      fakeRag.getIndexJob.mockRejectedValue(error);
      capture.clear();
      await service.handleNotification(note({ jobState: 'failed', sequence }));
      expect(events).toHaveLength(sequence);
      expect(events[sequence - 1].failure).toEqual(UNREACHABLE_FAILURE);
      expect(cursor('doc-1')?.lastSequence).toBe(sequence);
      const failed = logsOf('indexing.request_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].code).toBe(code);
    }
  });

  it('T-FAIL-3 실패 사유가 비어 있으면 MISSING_FAILURE를 남기고 대체 사유로 발행한다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(job({ state: 'failed', failure: null, result: null }));
    await service.handleNotification(note({ jobState: 'failed', sequence: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0].failure).toEqual(UNREACHABLE_FAILURE);
    expect(logsOf('indexing.request_failed')[0].code).toBe('MISSING_FAILURE');
  });

  it('T-FAIL-5 알림 경로의 작업 조회가 rag 오류가 아니면 그대로 던지고 반영하지 않는다', async () => {
    const error = new Error('boom');
    for (const [jobState, sequence] of [
      ['failed', 1],
      ['succeeded', 2],
    ] as const) {
      fakeRag.getIndexJob.mockReset();
      fakeRag.getIndexJob.mockRejectedValue(error);
      await expect(service.handleNotification(note({ jobState, sequence }))).rejects.toBe(error);
    }
    // ★ 대체 사유 이벤트도, 순번 올림도, 받은 로그도 없어야 재전송이 반영된다
    expect(events).toHaveLength(0);
    expect(cursor('doc-1')).toBeUndefined();
    expect(logsOf('indexing.request_failed')).toHaveLength(0);
    expect(logsOf('indexing.event_received')).toHaveLength(0);
  });

  it('T-FAIL-4 실패 사유가 로그에 없고 대체 사유 객체는 매번 새로 만든다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(
      job({
        state: 'failed',
        result: null,
        failure: {
          code: 'CHUNKING_FAILED',
          message: FAILMSG_SENT,
          headingPath: ['설치', '환경'],
          placeholderId: 't1',
        },
      }),
    );
    await service.handleNotification(note({ jobState: 'failed', sequence: 1 }));
    const text = capture.lines.join('\n');
    expect(text).not.toContain(FAILMSG_SENT);
    expect(text).not.toContain('설치');

    fakeRag.getIndexJob.mockReset();
    fakeRag.getIndexJob.mockRejectedValue(new RagUnavailableError());
    await service.handleNotification(note({ jobState: 'failed', sequence: 2 }));
    await service.handleNotification(note({ jobState: 'failed', sequence: 3 }));
    const [, second, third] = events;
    expect(second.failure).not.toBeNull();
    expect(second.failure).not.toBe(third.failure);
  });
});

describe('REQ-BE-3.2.4', () => {
  it('T-SEQ-1 오래됐거나 같은 순번은 무시하고 큰 순번만 반영한다', async () => {
    await service.handleNotification(note({ jobState: 'running', sequence: 3 }));
    await service.handleNotification(note({ jobState: 'succeeded', sequence: 2 }));
    await service.handleNotification(note({ jobState: 'running', sequence: 3 }));
    await service.handleNotification(note({ jobState: 'running', sequence: 4 }));
    expect(events).toHaveLength(2);
    // ★ 오래된 succeeded 알림은 작업을 조회하지 않는다
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
    expect(db.dump('rag_event_cursors')).toEqual([{ docId: 'doc-1', lastSequence: 4 }]);
  });

  it('T-SEQ-2 같은 알림을 동시에 두 번 보내도 이벤트는 하나다', async () => {
    await Promise.all([
      service.handleNotification(note({ sequence: 5 })),
      service.handleNotification(note({ sequence: 5 })),
    ]);
    expect(events).toHaveLength(1);
  });

  it('T-SEQ-3 순번은 문서별로 센다', async () => {
    await service.handleNotification(note({ docId: 'doc-a', sequence: 5 }));
    await service.handleNotification(note({ docId: 'doc-b', sequence: 1 }));
    expect(events.map((e) => e.docId)).toEqual(['doc-a', 'doc-b']);
  });

  it('T-SEQ-4 순번이 건너뛰어도 큰 값이면 반영한다', async () => {
    await service.handleNotification(note({ sequence: 1 }));
    await service.handleNotification(note({ sequence: 10 }));
    expect(events).toHaveLength(2);
    expect(cursor('doc-1')?.lastSequence).toBe(10);
  });

  it('T-SEQ-5 저장된 순번을 기준으로 거른다', async () => {
    await db.collection('rag_event_cursors').insertOne({ docId: 'doc-1', lastSequence: 7 });
    await service.handleNotification(note({ sequence: 7 }));
    expect(events).toHaveLength(0);
    await service.handleNotification(note({ sequence: 8 }));
    expect(events).toHaveLength(1);
  });

  it('T-SEQ-6 MongoDB 오류는 그대로 던지고 사슬은 이어진다', async () => {
    const readError = new Error('mongo down');
    db.failNext('findOne', readError);
    await expect(service.handleNotification(note({ sequence: 1 }))).rejects.toBe(readError);
    expect(events).toHaveLength(0);
    expect(logsOf('indexing.event_received')).toHaveLength(0);

    const writeError = new Error('mongo down');
    db.failNext('updateOne', writeError);
    await expect(service.handleNotification(note({ sequence: 1 }))).rejects.toBe(writeError);
    expect(events).toHaveLength(0);
    expect(logsOf('indexing.event_received')).toHaveLength(0);

    // 실패 뒤에도 같은 알림을 다시 받으면 반영된다
    await service.handleNotification(note({ sequence: 1 }));
    expect(events).toHaveLength(1);
  });
});

describe('REQ-BE-3.3.1', () => {
  it('T-REC-1 문서마다 최신 작업의 이벤트를 발행한다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({
        docId: 'a',
        latestJobId: 'ja',
        latestJobState: 'succeeded',
        latestJobStage: null,
        searchableVersion: '5',
      }),
      state({
        docId: 'b',
        latestJobId: 'jb',
        latestJobState: 'failed',
        latestJobStage: null,
      }),
    ]);
    jobsById({
      ja: job({
        jobId: 'ja',
        docId: 'a',
        version: '5',
        result: { chunkCount: 3, fallbackUsed: false },
      }),
      jb: job({
        jobId: 'jb',
        docId: 'b',
        version: '2',
        state: 'failed',
        result: null,
        failure: { code: 'X', message: FAILMSG_SENT, headingPath: null, placeholderId: null },
      }),
    });
    await service.reconcile(['a', 'b']);
    // ★ 알림이 없으므로 RAG 왕복은 묶음 조회 1번뿐이다 (P41)
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    expect(fakeRag.getIndexStates.mock.calls[0][0]).toEqual(['a', 'b']);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.docId)).toEqual(['a', 'b']);
    expect(events.map((e) => e.source)).toEqual(['reconcile', 'reconcile']);
    expect(events.map((e) => e.version)).toEqual(['5', '2']);
    expect(events.map((e) => e.jobId)).toEqual(['ja', 'jb']);
    expect(events.map((e) => e.jobState)).toEqual(['succeeded', 'failed']);
    expect(events.map((e) => e.searchableVersion)).toEqual(['5', null]);
    expect(events[0].result).toEqual({ chunkCount: 3, fallbackUsed: false });
    expect(events[0].failure).toBeNull();
    expect(events[1].result).toBeNull();
    expect(events[1].failure).toEqual({
      code: 'X',
      message: FAILMSG_SENT,
      headingPath: null,
      placeholderId: null,
    });
    const done = logsOf('indexing.reconciled');
    expect(done).toHaveLength(1);
    expect(payloadOf(done[0])).toEqual({ docs: 2, events: 2 });
    expect(done[0].level).toBe(30);
  });

  it('T-REC-2 queued·running·superseded는 결과·실패 사유 없이 작업 조회 버전을 쓴다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja', latestJobState: 'queued', latestJobStage: null }),
      state({ docId: 'b', latestJobId: 'jb', latestJobState: 'running' }),
      state({ docId: 'c', latestJobId: 'jc', latestJobState: 'superseded', latestJobStage: null }),
    ]);
    jobsById({
      ja: job({ jobId: 'ja', docId: 'a', version: '1', state: 'queued', result: null }),
      jb: job({ jobId: 'jb', docId: 'b', version: '2', state: 'running', result: null }),
      jc: job({ jobId: 'jc', docId: 'c', version: '3', state: 'superseded', result: null }),
    });
    await service.reconcile(['a', 'b', 'c']);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.version)).toEqual(['1', '2', '3']);
    for (const event of events) {
      expect(event.result).toBeNull();
      expect(event.failure).toBeNull();
    }
    expect(fakeRag.getIndexJob).toHaveBeenCalledTimes(3);
  });

  it('T-REC-3 색인 상태 조회에 실패하면 이벤트 없이 끝난다', async () => {
    fakeRag.getIndexStates.mockRejectedValue(new RagUnavailableError());
    await expect(service.reconcile(['a', 'b'])).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
    const failed = logsOf('indexing.request_failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])).toEqual({
      operation: 'getIndexStates',
      docId: null,
      code: 'RAG_UNAVAILABLE',
    });
    expect(payloadOf(logsOf('indexing.reconciled')[0])).toEqual({ docs: 2, events: 0 });
  });

  it('T-REC-4 한 문서의 작업 조회가 실패해도 다른 문서는 발행한다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja' }),
      state({ docId: 'b', latestJobId: 'jb' }),
    ]);
    jobsById({
      ja: new RagRequestError(404, 'JOB_NOT_FOUND'),
      jb: job({ jobId: 'jb', docId: 'b', version: '2', state: 'running', result: null }),
    });
    await service.reconcile(['a', 'b']);
    expect(events.map((e) => e.docId)).toEqual(['b']);
    const failed = logsOf('indexing.request_failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])).toEqual({
      operation: 'getIndexJob',
      docId: 'a',
      code: 'JOB_NOT_FOUND',
    });
    expect(payloadOf(logsOf('indexing.reconciled')[0])).toEqual({ docs: 2, events: 1 });
  });

  it('T-REC-13 문서별 작업 조회가 rag 오류가 아니면 삼키지 않고 던진다', async () => {
    const error = new Error('boom');
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja' }),
      state({ docId: 'b', latestJobId: 'jb' }),
    ]);
    jobsById({
      ja: error,
      jb: job({ jobId: 'jb', docId: 'b', state: 'running', result: null }),
    });
    await expect(service.reconcile(['a', 'b'])).rejects.toBe(error);
    expect(logsOf('indexing.request_failed')).toHaveLength(0);
    // ★ 같은 묶음의 문서는 직렬 구간 안에서 동시에 발행하므로 오류가 난 문서(a)만 빠지고 b는 발행된다
    expect(events.map((e) => e.docId)).toEqual(['b']);
  });

  /** 문서 n개의 색인 상태를 정하고, 작업 조회는 호출 순서·지연을 제어할 수 있게 한다. */
  function manyDocs(count: number): string[] {
    const ids = Array.from({ length: count }, (_, i) => `d${i}`);
    fakeRag.getIndexStates.mockResolvedValue(
      ids.map((docId, i) => state({ docId, latestJobId: `j${i}` })),
    );
    return ids;
  }

  it('T-REC-16 문서가 여러 개여도 문서마다 이벤트가 하나씩 나오고 집계가 맞다', async () => {
    const ids = manyDocs(9);
    // 앞 문서일수록 늦게 끝나게 해 완료 순서가 입력 순서와 달라지게 한다
    fakeRag.getIndexJob.mockImplementation(async (jobId) => {
      const n = Number(jobId.slice(1));
      await new Promise((resolve) => setTimeout(resolve, (9 - n) * 3));
      return job({ jobId, docId: `d${n}`, version: String(n), state: 'running', result: null });
    });
    await service.reconcile(ids);
    // ★ 발행은 문서의 직렬 구간 안에서 하므로 완료 순서를 따른다 (P23). 문서마다 하나씩이면 된다
    // ★ 알림이 없으므로 색인 상태 조회는 묶음 1번뿐이다 (P41)
    expect([...events.map((e) => e.docId)].sort()).toEqual([...ids].sort());
    for (const event of events) {
      expect(event.jobId).toBe(`j${event.docId.slice(1)}`);
      expect(event.version).toBe(event.docId.slice(1));
    }
    expect(events.map((e) => e.source)).toEqual(ids.map(() => 'reconcile'));
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    const done = logsOf('indexing.reconciled');
    expect(done).toHaveLength(1);
    expect(payloadOf(done[0])).toEqual({ docs: 9, events: 9 });
  });

  it.each([2, 5])(
    'T-REC-17 %i번째 문서의 작업 조회가 rag 오류가 아니면 그 오류로 던지고 같은 묶음의 오류 문서 외 문서만 발행한다',
    async (k) => {
      const ids = manyDocs(9);
      const error = new Error('boom');
      fakeRag.getIndexJob.mockImplementation(async (jobId) => {
        const n = Number(jobId.slice(1));
        if (n === k - 1) throw error;
        return job({ jobId, docId: `d${n}`, version: String(n), state: 'running', result: null });
      });
      await expect(service.reconcile(ids)).rejects.toBe(error);
      // ★ 오류가 난 문서가 든 묶음(동시 4개)은 그 문서만 빠지고 모두 발행되며, 그 뒤 묶음은 돌지 않는다 (P23)
      // ★ 4는 indexing.service.ts의 RECONCILE_CONCURRENCY(동시 처리 수)와 같은 값이다 — 상수가 바뀌면 함께 고친다
      const concurrency = 4;
      const batchEnd = (Math.floor((k - 1) / concurrency) + 1) * concurrency;
      const expected = ids.slice(0, batchEnd).filter((id) => id !== `d${k - 1}`);
      expect([...events.map((e) => e.docId)].sort()).toEqual([...expected].sort());
      // 오류 뒤 처리가 끝없이 이어지지 않는다
      expect(fakeRag.getIndexJob.mock.calls.length).toBeLessThan(ids.length);
    },
  );

  it('T-REC-14 jobState·searchableVersion은 색인 상태 값이고 채움 판정도 그 상태를 따른다', async () => {
    // 상태는 running인데 작업 응답은 그 사이 succeeded·failed가 된 경우다
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja', latestJobState: 'running', searchableVersion: '4' }),
      state({ docId: 'b', latestJobId: 'jb', latestJobState: 'running', searchableVersion: null }),
    ]);
    jobsById({
      ja: job({
        jobId: 'ja',
        docId: 'a',
        version: '9',
        state: 'succeeded',
        result: { chunkCount: 3, fallbackUsed: false },
      }),
      jb: job({
        jobId: 'jb',
        docId: 'b',
        version: '8',
        state: 'failed',
        result: null,
        failure: { code: 'X', message: FAILMSG_SENT, headingPath: null, placeholderId: null },
      }),
    });
    await service.reconcile(['a', 'b']);
    expect(events.map((e) => e.jobState)).toEqual(['running', 'running']);
    expect(events.map((e) => e.searchableVersion)).toEqual(['4', null]);
    expect(events.map((e) => e.version)).toEqual(['9', '8']);
    for (const event of events) {
      expect(event.result).toBeNull();
      expect(event.failure).toBeNull();
    }
  });

  it('T-REC-15 상태가 succeeded·failed인데 작업 응답이 아직 아니면 상태 기준으로 건너뛴다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja', latestJobState: 'succeeded', latestJobStage: null }),
      state({ docId: 'b', latestJobId: 'jb', latestJobState: 'failed', latestJobStage: null }),
    ]);
    jobsById({
      ja: job({ jobId: 'ja', docId: 'a', state: 'running', result: null }),
      jb: job({ jobId: 'jb', docId: 'b', state: 'running', result: null, failure: null }),
    });
    await service.reconcile(['a', 'b']);
    expect(events).toHaveLength(0);
    expect(logsOf('indexing.request_failed').map((l) => l.code)).toEqual([
      'MISSING_RESULT',
      'MISSING_FAILURE',
    ]);
  });

  it('T-REC-5 결과·실패 사유가 비어 있으면 대체 사유 없이 건너뛴다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja', latestJobState: 'succeeded', latestJobStage: null }),
      state({ docId: 'b', latestJobId: 'jb', latestJobState: 'failed', latestJobStage: null }),
    ]);
    jobsById({
      ja: job({ jobId: 'ja', docId: 'a', result: null }),
      jb: job({ jobId: 'jb', docId: 'b', state: 'failed', failure: null, result: null }),
    });
    await service.reconcile(['a', 'b']);
    expect(events).toHaveLength(0);
    expect(logsOf('indexing.request_failed').map((l) => l.code)).toEqual([
      'MISSING_RESULT',
      'MISSING_FAILURE',
    ]);
  });

  it('T-REC-6 빈 목록은 조회하지 않고 중복 ID는 하나로 합친다', async () => {
    await service.reconcile([]);
    expect(fakeRag.getIndexStates).not.toHaveBeenCalled();
    expect(payloadOf(logsOf('indexing.reconciled')[0])).toEqual({ docs: 0, events: 0 });

    capture.clear();
    fakeRag.getIndexStates.mockResolvedValue([]);
    await service.reconcile(['a', 'a', 'b']);
    expect(fakeRag.getIndexStates).toHaveBeenCalledWith(['a', 'b']);
    expect(logsOf('indexing.reconciled')[0].docs).toBe(2);
  });

  it('T-REC-7 최신 작업이 없는 문서는 조회도 이벤트도 없다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: null, latestJobState: null, latestJobStage: null }),
      state({ docId: 'b', latestJobId: 'j', latestJobState: null, latestJobStage: null }),
    ]);
    await service.reconcile(['a', 'b']);
    expect(events).toHaveLength(0);
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
  });

  it('T-REC-8 알림 순번과 무관하게 발행하고 순번 컬렉션을 건드리지 않는다', async () => {
    await db.collection('rag_event_cursors').insertOne({ docId: 'a', lastSequence: 9 });
    const before = db.dump('rag_event_cursors');
    fakeRag.getIndexStates.mockResolvedValue([state({ docId: 'a', latestJobId: 'ja' })]);
    jobsById({ ja: job({ jobId: 'ja', docId: 'a', state: 'running', result: null }) });
    await service.reconcile(['a']);
    expect(events).toHaveLength(1);
    expect(db.dump('rag_event_cursors')).toEqual(before);
  });

  it('T-REC-9 받는 쪽이 실패해도 다른 문서를 계속 발행한다', async () => {
    emitter.on(INDEX_JOB_STATE_CHANGED, (event: IndexJobStateChangedEvent) => {
      if (event.docId === 'a') throw new Error('x');
    });
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobId: 'ja' }),
      state({ docId: 'b', latestJobId: 'jb' }),
    ]);
    jobsById({
      ja: job({ jobId: 'ja', docId: 'a', state: 'running', result: null }),
      jb: job({ jobId: 'jb', docId: 'b', state: 'running', result: null }),
    });
    await expect(service.reconcile(['a', 'b'])).resolves.toBeUndefined();
    expect([...events.map((e) => e.docId)].sort()).toEqual(['a', 'b']);
    const failed = logsOf('indexing.event_dispatch_failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])).toEqual({
      docId: 'a',
      jobId: 'ja',
      source: 'reconcile',
      errorName: 'Error',
    });
    // 발행을 시도한 수다
    expect(payloadOf(logsOf('indexing.reconciled')[0])).toEqual({ docs: 2, events: 2 });
  });

  it('T-REC-10 예상 밖 예외는 그대로 던진다', async () => {
    const error = new Error('boom');
    fakeRag.getIndexStates.mockRejectedValue(error);
    await expect(service.reconcile(['a'])).rejects.toBe(error);
  });

  it('T-REC-11 요청하지 않은 문서의 상태는 버린다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([state({ docId: 'z', latestJobId: 'jz' })]);
    await service.reconcile(['a']);
    expect(events).toHaveLength(0);
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
  });

  it('T-REC-12 실패 사유가 로그에 없다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'b', latestJobId: 'jb', latestJobState: 'failed', latestJobStage: null }),
    ]);
    jobsById({
      jb: job({
        jobId: 'jb',
        docId: 'b',
        state: 'failed',
        result: null,
        failure: {
          code: 'X',
          message: FAILMSG_SENT,
          headingPath: null,
          placeholderId: null,
        },
      }),
    });
    await service.reconcile(['b']);
    expect(capture.lines.join('\n')).not.toContain(FAILMSG_SENT);
  });

  /** 조건이 참이 될 때까지 이벤트 루프를 돌린다. ★ 실제 시간을 기다리지 않는다 */
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!check()) throw new Error('조건이 참이 되지 않았습니다');
  }

  it('T-PR3-REC-1 묶음 조회 뒤 알림이 처리돼도 낡은 상태가 아니라 다시 조회한 상태로 발행한다', async () => {
    const gate = deferred<RagIndexState[]>();
    let fresh = state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' });
    let calls = 0;
    fakeRag.getIndexStates.mockImplementation((docIds) => {
      calls += 1;
      // ★ 첫 호출(묶음)만 멈춘다. 그 값은 알림 처리보다 앞선 낡은 스냅샷이다
      if (calls === 1) return gate.promise;
      return Promise.resolve(docIds.includes('A') ? [fresh] : []);
    });
    let jobOf: RagIndexJob | Error = new RagRequestError(404, 'JOB_NOT_FOUND');
    fakeRag.getIndexJob.mockImplementation(async () => {
      if (jobOf instanceof Error) throw jobOf;
      return jobOf;
    });

    const running = service.reconcile(['A']);
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    // 멈춘 동안 failed 알림이 처리된다. 작업 조회 실패로 RAG_UNREACHABLE 대체 사유가 나간다
    await service.handleNotification(
      note({ docId: 'A', jobId: 'jA', jobState: 'failed', sequence: 1 }),
    );
    expect(events.map((e) => e.source)).toEqual(['notification']);
    expect(events[0].failure?.code).toBe('RAG_UNREACHABLE');

    // 그 뒤 RAG Server 상태가 실제 사유가 있는 failed로 바뀌고 묶음 호출이 풀린다
    fresh = state({
      docId: 'A',
      latestJobId: 'jA',
      latestJobState: 'failed',
      latestJobStage: null,
    });
    jobOf = job({
      jobId: 'jA',
      docId: 'A',
      state: 'failed',
      result: null,
      failure: {
        code: 'PARSE_FAILED',
        message: FAILMSG_SENT,
        headingPath: null,
        placeholderId: null,
      },
    });
    gate.resolve([state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' })]);
    await running;

    const reconciled = events.filter((e) => e.source === 'reconcile');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].jobState).toBe('failed');
    expect(reconciled[0].failure).toEqual({
      code: 'PARSE_FAILED',
      message: FAILMSG_SENT,
      headingPath: null,
      placeholderId: null,
    });
    // ★ 낡은 running 이벤트는 나가지 않는다
    expect(events.some((e) => e.jobState === 'running')).toBe(false);
    // 묶음 1번 + A를 직렬 구간 안에서 다시 조회 1번
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(2);
    expect([...fakeRag.getIndexStates.mock.calls[1][0]]).toEqual(['A']);
  });

  it('T-PR3-REC-2 알림이 반영된 A의 다시 조회는 A 알림 처리가 끝난 뒤에 하고 알림 없는 B는 다시 조회하지 않고 기다리지도 않는다', async () => {
    const order: string[] = [];
    const gateBatch = deferred<void>();
    const gateA = deferred<void>();
    emitter.on(INDEX_JOB_STATE_CHANGED, async (event: IndexJobStateChangedEvent) => {
      order.push(`start:${event.docId}:${event.source}`);
      // ★ A의 알림 반영만 멈춘다
      if (event.docId === 'A' && event.source === 'notification') await gateA.promise;
      order.push(`end:${event.docId}:${event.source}`);
    });
    let calls = 0;
    fakeRag.getIndexStates.mockImplementation(async (docIds) => {
      calls += 1;
      order.push(`states:${docIds.join(',')}`);
      // ★ 첫 호출(묶음)만 멈춘다. 그동안 A의 알림이 반영된다
      if (calls === 1) await gateBatch.promise;
      return [
        state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' }),
        state({ docId: 'B', latestJobId: 'jB', latestJobState: 'running' }),
      ].filter((s) => docIds.includes(s.docId));
    });
    jobsById({
      jA: job({ jobId: 'jA', docId: 'A', state: 'running', result: null }),
      jB: job({ jobId: 'jB', docId: 'B', state: 'running', result: null }),
    });

    const running = service.reconcile(['A', 'B']);
    await until(() => order.includes('states:A,B'));
    // 묶음 조회가 멈춘 동안 A의 알림이 반영되고 그 이벤트 처리가 멈춘다
    const notified = service.handleNotification(
      note({ docId: 'A', jobId: 'jA', jobState: 'running', sequence: 1 }),
    );
    await until(() => order.includes('start:A:notification'));
    gateBatch.resolve();
    // B는 A를 기다리지 않고 발행을 마친다
    await until(() => order.includes('end:B:reconcile'));
    expect(order).not.toContain('end:A:notification');
    // ★ 알림이 없던 B는 다시 조회하지 않는다. A도 알림 처리가 끝나기 전에는 조회하지 않는다
    expect(order).not.toContain('states:B');
    expect(order).not.toContain('states:A');

    gateA.resolve();
    await notified;
    await running;
    // A의 다시 조회는 A 알림 처리가 끝난 뒤이고, A의 reconcile 이벤트가 그 뒤에 나간다
    expect(order.indexOf('states:A')).toBeGreaterThan(order.indexOf('end:A:notification'));
    expect(order.indexOf('start:A:reconcile')).toBeGreaterThan(order.indexOf('states:A'));
    expect(order).not.toContain('states:B');
  });

  /** 문서 하나(A)의 알림 순번 1을 처리하고 getIndexJob이 못 받아 대체 사유가 나가게 한다. */
  const noteFailedA = (sequence: number) =>
    service.handleNotification(note({ docId: 'A', jobId: 'jA', jobState: 'failed', sequence }));

  it('T-PR3-F5-1 알림이 없으면 묶음 조회 1번으로 문서 셋의 이벤트가 나온다', async () => {
    const ids = ['A', 'B', 'C'];
    fakeRag.getIndexStates.mockResolvedValue(
      ids.map((docId) => state({ docId, latestJobId: `j${docId}`, latestJobState: 'running' })),
    );
    jobsById(
      Object.fromEntries(
        ids.map((docId) => [
          `j${docId}`,
          job({ jobId: `j${docId}`, docId, state: 'running', result: null }),
        ]),
      ),
    );
    await service.reconcile(ids);
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    expect([...fakeRag.getIndexStates.mock.calls[0][0]]).toEqual(ids);
    expect([...events.map((e) => e.docId)].sort()).toEqual(ids);
  });

  it('T-PR3-F5-2 묶음 조회 중 알림이 반영된 A만 다시 조회하고 B는 묶음 결과로 발행한다', async () => {
    const gate = deferred<RagIndexState[]>();
    const freshA = state({
      docId: 'A',
      latestJobId: 'jA',
      latestJobState: 'failed',
      latestJobStage: null,
    });
    let calls = 0;
    fakeRag.getIndexStates.mockImplementation((docIds) => {
      calls += 1;
      // ★ 첫 호출(묶음)은 알림 처리보다 앞선 낡은 스냅샷으로 멈춰 있다
      if (calls === 1) return gate.promise;
      return Promise.resolve(docIds.includes('A') ? [freshA] : []);
    });
    let jobA: RagIndexJob | Error = new RagRequestError(404, 'JOB_NOT_FOUND');
    fakeRag.getIndexJob.mockImplementation(async (jobId) => {
      if (jobId === 'jB') return job({ jobId: 'jB', docId: 'B', state: 'running', result: null });
      if (jobA instanceof Error) throw jobA;
      return jobA;
    });

    const running = service.reconcile(['A', 'B']);
    await noteFailedA(1);
    expect(events[0].failure?.code).toBe('RAG_UNREACHABLE');

    jobA = job({
      jobId: 'jA',
      docId: 'A',
      state: 'failed',
      result: null,
      failure: {
        code: 'PARSE_FAILED',
        message: FAILMSG_SENT,
        headingPath: null,
        placeholderId: null,
      },
    });
    gate.resolve([
      state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' }),
      state({ docId: 'B', latestJobId: 'jB', latestJobState: 'running' }),
    ]);
    await running;

    const reconciled = events.filter((e) => e.source === 'reconcile');
    const a = reconciled.find((e) => e.docId === 'A');
    const b = reconciled.find((e) => e.docId === 'B');
    expect(a?.jobState).toBe('failed');
    expect(a?.failure?.code).toBe('PARSE_FAILED');
    expect(b?.jobState).toBe('running');
    // ★ 묶음 1번 + A만 다시 조회 1번이다. B는 다시 조회하지 않는다
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(2);
    expect([...fakeRag.getIndexStates.mock.calls[1][0]]).toEqual(['A']);
  });

  it('T-PR3-F5-3 이미 반영한 순번 이하의 알림은 무시되어 다시 조회를 일으키지 않는다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(
      job({ jobId: 'jA', docId: 'A', state: 'running', result: null }),
    );
    // 먼저 순번 5를 반영해 둔다
    await service.handleNotification(
      note({ docId: 'A', jobId: 'jA', jobState: 'running', sequence: 5 }),
    );
    const gate = deferred<RagIndexState[]>();
    fakeRag.getIndexStates.mockImplementation(() => gate.promise);

    const running = service.reconcile(['A']);
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    // ★ 묶음 조회 중 같은 순번(무시됨)과 더 낮은 순번 알림이 온다
    const before = events.length;
    await service.handleNotification(
      note({ docId: 'A', jobId: 'jA', jobState: 'running', sequence: 5 }),
    );
    await service.handleNotification(
      note({ docId: 'A', jobId: 'jA', jobState: 'running', sequence: 3 }),
    );
    expect(events).toHaveLength(before);
    gate.resolve([state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' })]);
    await running;

    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.source === 'reconcile')).toHaveLength(1);
  });

  it('T-PR3-F5-4 묶음 조회 전에 반영이 끝난 알림은 다시 조회를 일으키지 않는다', async () => {
    fakeRag.getIndexJob.mockRejectedValue(new RagRequestError(404, 'JOB_NOT_FOUND'));
    await noteFailedA(1);
    expect(events).toHaveLength(1);

    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'A', latestJobId: 'jA', latestJobState: 'failed', latestJobStage: null }),
    ]);
    fakeRag.getIndexJob.mockResolvedValue(
      job({
        jobId: 'jA',
        docId: 'A',
        state: 'failed',
        result: null,
        failure: {
          code: 'PARSE_FAILED',
          message: FAILMSG_SENT,
          headingPath: null,
          placeholderId: null,
        },
      }),
    );
    await service.reconcile(['A']);
    // ★ 묶음이 이미 알림 반영 뒤의 값이므로 1번이다
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.source === 'reconcile')).toHaveLength(1);
  });

  /**
   * 진행 중인 상태 맞추기의 감시 등록 크기를 읽는다. 필드가 없으면 undefined다.
   * ★ 감시 누수는 공개 동작으로 드러나지 않아 내부 필드를 본다 — 끝난 감시가 남아도 다음 reconcile은 새 감시를 쓴다
   */
  const watchCount = (): number | undefined =>
    (Reflect.get(service, 'reconcileWatches') as Set<unknown> | undefined)?.size;

  /** 문서 A의 running 알림을 순번과 함께 보낸다. */
  const noteRunningA = (sequence: number): Promise<void> =>
    service.handleNotification(note({ docId: 'A', jobId: 'jA', jobState: 'running', sequence }));

  /** A의 running 상태를 묶음으로 주고 reconcile(['A'])을 돌려 그동안의 묶음 조회 횟수를 돌려준다. */
  async function statesCallsOfReconcileA(): Promise<number> {
    fakeRag.getIndexStates.mockReset();
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' }),
    ]);
    await service.reconcile(['A']);
    return fakeRag.getIndexStates.mock.calls.length;
  }

  it('T-FU-WATCH-1 상태 맞추기 밖의 알림은 감시를 남기지 않고 다음 상태 맞추기의 다시 조회를 일으키지 않는다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(job({ state: 'running', result: null }));
    for (const [index, docId] of ['A', 'B', 'C'].entries()) {
      await service.handleNotification(
        note({ docId, jobId: `j${docId}`, jobState: 'running', sequence: index + 1 }),
      );
    }
    expect(events).toHaveLength(3);
    // ★ 진행 중인 reconcile이 없으면 감시 등록은 비어 있다
    expect(watchCount()).toBe(0);
    fakeRag.getIndexStates.mockResolvedValue(
      ['A', 'B', 'C'].map((docId) =>
        state({ docId, latestJobId: `j${docId}`, latestJobState: 'running' }),
      ),
    );
    await service.reconcile(['A', 'B', 'C']);
    // ★ 알림이 상태 맞추기 전에 끝났으므로 묶음 조회 1번뿐이다 — 문서별로 남은 상태가 없다
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(1);
    expect(watchCount()).toBe(0);
  });

  it('T-FU-WATCH-2 상태 맞추기 중에만 감시가 등록돼 그때의 알림만 다시 조회를 일으키고 끝나면(정상·조회 실패·예외) 지워진다', async () => {
    fakeRag.getIndexJob.mockResolvedValue(
      job({ jobId: 'jA', docId: 'A', state: 'running', result: null }),
    );
    // ① 묶음 조회가 멈춘 동안 온 알림은 A만 다시 조회하게 한다
    const gate = deferred<RagIndexState[]>();
    fakeRag.getIndexStates.mockImplementationOnce(() => gate.promise);
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' }),
    ]);
    const running = service.reconcile(['A']);
    // ★ 묶음 조회가 멈춘 동안만 감시가 1개 등록돼 있다
    expect(watchCount()).toBe(1);
    await noteRunningA(1);
    gate.resolve([state({ docId: 'A', latestJobId: 'jA', latestJobState: 'running' })]);
    await running;
    expect(fakeRag.getIndexStates).toHaveBeenCalledTimes(2);
    expect([...fakeRag.getIndexStates.mock.calls[1][0]]).toEqual(['A']);
    expect(watchCount()).toBe(0);

    // ② 정상으로 끝난 뒤의 알림은 다음 상태 맞추기에서 다시 조회를 일으키지 않는다
    await noteRunningA(2);
    expect(await statesCallsOfReconcileA()).toBe(1);

    // ③ 묶음 조회 실패(RAG Server 불통)로 끝난 뒤도 같다
    fakeRag.getIndexStates.mockReset();
    fakeRag.getIndexStates.mockRejectedValue(new RagUnavailableError());
    await service.reconcile(['A']);
    expect(watchCount()).toBe(0);
    await noteRunningA(3);
    expect(await statesCallsOfReconcileA()).toBe(1);

    // ④ rag 오류가 아닌 예외로 거부된 뒤도 같다
    fakeRag.getIndexJob.mockRejectedValueOnce(new Error('unexpected'));
    await expect(service.reconcile(['A'])).rejects.toThrow('unexpected');
    expect(watchCount()).toBe(0);
    await noteRunningA(4);
    expect(await statesCallsOfReconcileA()).toBe(1);
    expect(watchCount()).toBe(0);
  });
});

describe('REQ-BE-1.3.6', () => {
  it('T-STG-1 running이고 단계가 있는 문서만 단계를 돌려준다', async () => {
    fakeRag.getIndexStates.mockResolvedValue([
      state({ docId: 'a', latestJobState: 'running', latestJobStage: 'chunking' }),
      state({ docId: 'b', latestJobState: 'running', latestJobStage: 'storing' }),
      state({ docId: 'c', latestJobState: 'queued', latestJobStage: null }),
      state({ docId: 'd', latestJobState: 'succeeded', latestJobStage: null }),
      state({ docId: 'e', latestJobState: 'running', latestJobStage: null }),
    ]);
    const stages = await service.getStages(['a', 'b', 'c', 'd', 'e']);
    expect(stages).toBeInstanceOf(Map);
    expect([...stages.entries()]).toEqual([
      ['a', 'chunking'],
      ['b', 'storing'],
    ]);
    expect(fakeRag.getIndexJob).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(logsOf('indexing.reconciled')).toHaveLength(0);
  });

  it('T-STG-2 RAG Server에 닿지 않으면 빈 값이다', async () => {
    fakeRag.getIndexStates.mockRejectedValue(new RagUnavailableError());
    const stages = await service.getStages(['a']);
    expect(stages.size).toBe(0);
    const failed = logsOf('indexing.request_failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])).toEqual({
      operation: 'getIndexStates',
      docId: null,
      code: 'RAG_UNAVAILABLE',
    });
  });

  it('T-STG-3 빈 목록은 조회하지 않고 중복 ID는 하나로 합친다', async () => {
    expect((await service.getStages([])).size).toBe(0);
    expect(fakeRag.getIndexStates).not.toHaveBeenCalled();
    fakeRag.getIndexStates.mockResolvedValue([]);
    await service.getStages(['a', 'a']);
    expect(fakeRag.getIndexStates).toHaveBeenCalledWith(['a']);
  });

  it('T-STG-4 예상 밖 예외는 그대로 던진다', async () => {
    fakeRag.getIndexStates.mockRejectedValue(new Error('boom'));
    await expect(service.getStages(['a'])).rejects.toThrow('boom');
  });
});

describe('REQ-BE-3.4.1', () => {
  it('T-META-1 이름·판 정보를 RAG Server에 넘기고 참을 돌려준다', async () => {
    fakeRag.updateMetadata.mockResolvedValue(undefined);
    await expect(
      service.updateMetadata('doc-1', NAME_SENT, { label: LABEL_SENT, editionDate: DATE_SENT }),
    ).resolves.toBe(true);
    expect(fakeRag.updateMetadata).toHaveBeenCalledTimes(1);
    expect(fakeRag.updateMetadata).toHaveBeenCalledWith('doc-1', NAME_SENT, {
      label: LABEL_SENT,
      editionDate: DATE_SENT,
    });

    fakeRag.updateMetadata.mockClear();
    await expect(service.updateMetadata('doc-1', NAME_SENT, null)).resolves.toBe(true);
    expect(fakeRag.updateMetadata).toHaveBeenCalledWith('doc-1', NAME_SENT, null);
  });
});

describe('REQ-BE-3.4.2', () => {
  it('T-META-2 이름 변경이 실패하면 예외 없이 거짓이다', async () => {
    const causes: Array<[Error, string]> = [
      [new RagUnavailableError(), 'RAG_UNAVAILABLE'],
      [new RagRequestError(500, 'INTERNAL_ERROR'), 'INTERNAL_ERROR'],
    ];
    for (const [error, code] of causes) {
      capture.clear();
      fakeRag.updateMetadata.mockRejectedValue(error);
      await expect(service.updateMetadata('doc-1', NAME_SENT, null)).resolves.toBe(false);
      const failed = logsOf('indexing.request_failed');
      expect(failed).toHaveLength(1);
      expect(payloadOf(failed[0])).toEqual({ operation: 'updateMetadata', docId: 'doc-1', code });
    }
  });

  it('T-META-3 예상 밖 예외는 그대로 던진다', async () => {
    fakeRag.updateMetadata.mockRejectedValue(new Error('boom'));
    fakeRag.deleteDocument.mockRejectedValue(new Error('boom'));
    await expect(service.updateMetadata('doc-1', NAME_SENT, null)).rejects.toThrow('boom');
    await expect(service.deleteChunks('doc-1')).rejects.toThrow('boom');
  });

  it('T-META-4 이름·판 정보가 로그에 없다', async () => {
    fakeRag.updateMetadata.mockResolvedValue(undefined);
    await service.updateMetadata('doc-1', NAME_SENT, { label: LABEL_SENT, editionDate: DATE_SENT });
    fakeRag.updateMetadata.mockRejectedValue(new RagUnavailableError());
    await service.updateMetadata('doc-1', NAME_SENT, { label: LABEL_SENT, editionDate: DATE_SENT });
    const text = capture.lines.join('\n');
    for (const sentinel of [NAME_SENT, LABEL_SENT, DATE_SENT]) {
      expect(text).not.toContain(sentinel);
    }
  });
});

describe('REQ-BE-1.8.4', () => {
  it('T-DEL-1 청크 삭제를 RAG Server에 요청하고 실패하면 거짓이다', async () => {
    fakeRag.deleteDocument.mockResolvedValue(undefined);
    await expect(service.deleteChunks('doc-1')).resolves.toBe(true);
    expect(fakeRag.deleteDocument).toHaveBeenCalledTimes(1);
    expect(fakeRag.deleteDocument).toHaveBeenCalledWith('doc-1');

    fakeRag.deleteDocument.mockRejectedValue(new RagUnavailableError());
    await expect(service.deleteChunks('doc-1')).resolves.toBe(false);
    const failed = logsOf('indexing.request_failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])).toEqual({
      operation: 'deleteChunks',
      docId: 'doc-1',
      code: 'RAG_UNAVAILABLE',
    });
  });
});
