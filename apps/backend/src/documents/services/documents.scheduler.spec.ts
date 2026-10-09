import { DocumentLockedError } from '../../common';
import type { ProcessingState } from '../../common';
import type { PreparedVersion } from '../../assets';
import type { IndexRequestOutcome } from '../../indexing';
import { EditDocumentDto, ListDocumentsQueryDto } from '../interfaces/documents.dto';
import { INDEX_SCHEDULE_JOB_NAME } from './documents.scheduler';
import {
  DOC_A,
  DOC_B,
  DOC_C,
  DOC_D,
  HINT_SENT,
  buildDocumentsTestModule,
  deferred,
  docOf,
  docRecord,
  seed,
  tableView,
  uid,
  uploadFile,
  versionOf,
  versionRecord,
  waitUntil,
} from '../../../test/support/documents-fixtures';
import type {
  DocumentsHarness,
  DocumentsTestOptions,
} from '../../../test/support/documents-fixtures';
import { createLogCapture } from '../../../test/support/log-capture';

// ★ nestjs-pino 루트 로거는 파일당 하나다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

let h!: DocumentsHarness;
let alive = false;

/** 테스트 모듈을 새로 올린다. 이미 올라 있으면 먼저 닫는다. */
async function boot(opts: Partial<Omit<DocumentsTestOptions, 'stream'>> = {}): Promise<void> {
  if (alive) await h.close();
  capture.clear();
  h = await buildDocumentsTestModule({ stream: capture.stream, ...opts });
  alive = true;
}

beforeEach(async () => {
  await boot();
});

/** 멈춰 둔 표·이미지 처리를 푸는 함수다. afterEach가 부른다. */
let releaseHints: (() => void) | null = null;

afterEach(async () => {
  // ★ 닫기(drain) 전에 먼저 푼다
  releaseHints?.();
  releaseHints = null;
  if (alive) {
    alive = false;
    await h.close();
  }
});

/** 이벤트 루프를 몇 번 돌려 대기 중인 작업이 진행할 기회를 준다. */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** msg가 같은 로그 줄을 모은다. */
function logLines(msg: string): Record<string, unknown>[] {
  return capture.parsed().filter((line) => line.msg === msg);
}

/** Db 호출 중 find 횟수다. */
function findCalls(): number {
  return h.db.calls.filter((call) => call.op === 'find').length;
}

const PENDING_DELETE = { deleteChunks: true, metadata: false };
const PENDING_META = { deleteChunks: false, metadata: true };

/** 색인 대기열에 든 문서(버전 1)와 그 버전 레코드를 시드한다. 요청 직전 조건(queued·작업 ID 없음·마지막 버전)을 만족한다. */
async function seedQueued(
  docId: string,
  docOver: Partial<ReturnType<typeof docRecord>> = {},
  versionOver: Partial<ReturnType<typeof versionRecord>> = {},
): Promise<void> {
  await seed(
    h.db,
    [
      docRecord({
        docId,
        name: docId,
        processingState: 'queued',
        queuedVersion: '1',
        latestVersion: '1',
        ...docOver,
      }),
    ],
    [versionRecord({ docId, jobId: null, result: null, ...versionOver })],
  );
}

describe('REQ-BE-1.9.9', () => {
  it('T-RES-1 기동하면 captioning·uploaded 문서의 표·이미지 처리를 잇고 삭제·교체 문서는 건너뛰며 색인은 요청하지 않는다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'captioning', latestVersion: '2' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'uploaded' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'captioning', deleted: true }),
        docRecord({
          docId: DOC_D,
          name: 'd',
          processingState: 'captioning',
          searchState: 'replaced',
        }),
      ],
      [
        versionRecord({ docId: DOC_A, version: '1' }),
        versionRecord({ docId: DOC_A, version: '2', origin: 'reindex', jobId: null }),
        versionRecord({ docId: DOC_B, jobId: null }),
        versionRecord({ docId: DOC_C }),
        versionRecord({ docId: DOC_D }),
      ],
    );
    await h.scheduler.resume();
    await h.drain();
    const hinted = h.assets.generateHints.mock.calls.map((call) => [call[0], call[1]]);
    expect(hinted).toHaveLength(2);
    expect(hinted).toContainEqual([DOC_A, '2']);
    expect(hinted).toContainEqual([DOC_B, '1']);
    // ★ 기동 처리는 색인을 요청하지 않는다 (REQ-BE-1.10.8)
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-PR3-RES-1 한 문서의 조회가 던져도 나머지 문서는 처리하고 task_failed를 남긴다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'captioning' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'captioning' }),
      ],
      [versionRecord({ docId: DOC_A, jobId: null }), versionRecord({ docId: DOC_B, jobId: null })],
    );
    const real = h.repo.findVersion.bind(h.repo);
    jest.spyOn(h.repo, 'findVersion').mockImplementation(async (docId, version) => {
      // ★ A의 버전 조회만 던진다
      if (docId === DOC_A) throw new Error('boom');
      return real(docId, version);
    });
    await expect(h.scheduler.resume()).resolves.toBeUndefined();
    await h.drain();
    const hinted = h.assets.generateHints.mock.calls.map((call) => call[0]);
    expect(hinted).toContain(DOC_B);
    expect(hinted).not.toContain(DOC_A);
    const failed = logLines('documents.task_failed').filter((line) => line.task === 'resume');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.every((line) => line.docId === DOC_A)).toBe(true);
    // 기동 처리 요약 로그는 끝까지 남는다
    expect(logLines('documents.resume')).toHaveLength(1);
  });

  it('T-PR3-RES-3 상태 맞추기가 던져도 resume 로그가 남고 표·이미지 처리를 잇는다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'captioning' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'indexing' }),
      ],
      [versionRecord({ docId: DOC_A, jobId: null }), versionRecord({ docId: DOC_B })],
    );
    h.indexing.reconcile.mockRejectedValue(new Error('boom'));
    await expect(h.scheduler.resume()).resolves.toBeUndefined();
    await h.drain();
    expect(h.indexing.reconcile).toHaveBeenCalledTimes(1);
    expect(logLines('documents.resume')).toHaveLength(1);
    expect(h.assets.generateHints.mock.calls.map((call) => call[0])).toContain(DOC_A);
    const failed = logLines('documents.task_failed').filter((line) => line.task === 'resume');
    expect(failed).toHaveLength(1);
    expect(failed[0].docId).toBeNull();
  });

  it('T-PR3-DUP-3 표·이미지 처리가 도는 중에 기동 처리가 겹쳐도 같은 버전을 두 번 처리하지 않는다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'uploaded', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, jobId: null })],
    );
    const gate = deferred<{ generated: number; temporary: number; stopped: boolean }>();
    // ★ 테스트가 중간에 실패해도 afterEach의 drain이 끝나도록 해제 함수를 남긴다
    releaseHints = () => gate.resolve({ generated: 0, temporary: 0, stopped: false });
    h.assets.generateHints.mockImplementation(() => gate.promise);
    // 업로드 직후 처리가 표·이미지 처리에서 멈춰 있다
    h.lifecycle.startProcessing(DOC_A, '1');
    await waitUntil(() => h.assets.generateHints.mock.calls.length === 1);
    // ★ 그동안 기동 처리를 끝까지 돌린다 — 7단계가 같은 버전의 처리를 다시 시작하려 한다
    await h.scheduler.resume();
    await tick();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);

    gate.resolve({ generated: 0, temporary: 0, stopped: false });
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    const captioning = h.logs
      .recordsOf('processing_state')
      .filter((input) => input.detail?.toState === 'captioning');
    expect(captioning).toHaveLength(1);
    // ★ 처리가 끝나면 대기열에 들어갈 뿐 색인은 요청하지 않는다 (REQ-BE-1.9.3, 1.10.2)
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(0);
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
  });

  // ── 이 프로세스에서 진행 중인 선점은 기동 복구에서 뺀다 (되돌리기 표는 REQ-BE-1.10.4 describe) ──

  const PREPARED: PreparedVersion = {
    indexingMarkdown: 'IDX',
    unmatchedImages: [],
    assetCount: 0,
  };

  /** 완료 문서(버전 1)를 시드한다. */
  async function seedCompleted(): Promise<void> {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord({ docId: DOC_A })]);
  }

  /** 결과 Promise를 곧바로 값으로 바꿔 처리되지 않은 거부가 되지 않게 한다. */
  function settle(work: Promise<unknown>): Promise<unknown> {
    return work.then(
      () => 'resolved' as unknown,
      (error: unknown) => error,
    );
  }

  it('T-FU-CLAIM-1 내용 다시 올리기가 선점한 뒤 새 버전을 쓰기 전에 기동 처리가 돌아도 이전 버전으로 되돌리지 않는다', async () => {
    await seedCompleted();
    const gate = deferred<PreparedVersion>();
    h.assets.prepareVersion.mockImplementationOnce(() => gate.promise);
    const outcome = settle(h.service.uploadContents(DOC_A, [uploadFile('new.md', '# 새 내용')]));
    await waitUntil(() => h.assets.prepareVersion.mock.calls.length > 0);
    // ★ 선점은 끝났고 버전 2 레코드는 아직 없다
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(docOf(h.db, DOC_A).processingState).toBe('uploaded');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();

    await h.scheduler.resume();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('2');
    expect(doc.processingState).toBe('uploaded');
    expect(logLines('documents.resume')[0].recovered).toBe(0);
    expect(h.logs.recordsOf('processing_state').filter((r) => r.docId === DOC_A)).toEqual([]);

    gate.resolve(PREPARED);
    expect(await outcome).toBe('resolved');
    await h.drain();
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionOf(h.db, DOC_A, '2')).toBeDefined();
    // ★ 요청이 성공으로 끝나면 선점 표시가 풀린다
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(false);
  });

  it('T-FU-CLAIM-2 재색인 선점 중에도 같다', async () => {
    await seedCompleted();
    const gate = deferred<void>();
    h.assets.inheritVersion.mockImplementationOnce(() => gate.promise);
    const outcome = settle(h.service.reindex(DOC_A));
    await waitUntil(() => h.assets.inheritVersion.mock.calls.length > 0);

    await h.scheduler.resume();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('2');
    expect(doc.processingState).toBe('queued');
    expect(logLines('documents.resume')[0].recovered).toBe(0);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();

    gate.resolve();
    expect(await outcome).toBe('resolved');
    await h.drain();
    // ★ 재색인은 대기열에 넣기까지만 한다 — 색인 요청은 다음 예약 색인이 보낸다 (REQ-BE-1.7.1)
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
    await h.scheduler.runScheduledIndex();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex.mock.calls[0][0]).toMatchObject({ version: '2', force: true });
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(false);
  });

  it('T-FU-CLAIM-2b 요약·캡션 편집 선점 중에도 같고 끝나면 표시가 풀린다', async () => {
    await seedCompleted();
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    const gate = deferred<void>();
    h.assets.inheritVersion.mockImplementationOnce(() => gate.promise);
    const body = Object.assign(new EditDocumentDto(), {
      assets: [{ placeholder_id: 't1', text: HINT_SENT }],
    });
    const outcome = settle(h.service.edit(DOC_A, body));
    await waitUntil(() => h.assets.inheritVersion.mock.calls.length > 0);
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(true);

    await h.scheduler.resume();
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(logLines('documents.resume')[0].recovered).toBe(0);

    gate.resolve();
    expect(await outcome).toBe('resolved');
    await h.drain();
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(false);
  });

  it('T-FU-CLAIM-3 선점 되돌리기가 실패해 끝난 요청의 문서는 기동 처리가 이전 버전으로 되돌린다', async () => {
    await seedCompleted();
    const gate = deferred<PreparedVersion>();
    h.assets.prepareVersion.mockImplementationOnce(() => gate.promise);
    const outcome = settle(h.service.uploadContents(DOC_A, [uploadFile('new.md', '# 새 내용')]));
    await waitUntil(() => h.assets.prepareVersion.mock.calls.length > 0);
    // ★ 다음 한 번(선점 되돌리기)의 문서 갱신이 실패한다
    jest.spyOn(h.repo, 'updateDocument').mockRejectedValueOnce(new Error('rollback boom'));
    gate.reject(new Error('prepare boom'));
    expect(await outcome).toMatchObject({ message: 'prepare boom' });

    await h.scheduler.resume();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('1');
    expect(doc.processingState).toBe('completed');
    expect(logLines('documents.resume')[0].recovered).toBe(1);
  });

  it('T-FU-CLAIM-4 같은 버전의 선점 표시는 건수로 세어 모두 풀려야 풀린다', () => {
    h.lifecycle.beginClaim(DOC_A, '2');
    h.lifecycle.beginClaim(DOC_A, '2');
    h.lifecycle.endClaim(DOC_A, '2');
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(true);
    h.lifecycle.endClaim(DOC_A, '2');
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(false);
  });

  it('T-FU-CLAIM-5 선점 갱신이 어긋나거나 던져도 표시가 남지 않는다', async () => {
    // 선점 갱신이 어긋나면 DocumentLockedError이고 표시가 남지 않는다
    await seedCompleted();
    jest.spyOn(h.repo, 'updateDocument').mockResolvedValueOnce(false);
    await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(false);

    // 선점 갱신이 던져도 표시가 남지 않는다
    jest.spyOn(h.repo, 'updateDocument').mockRejectedValueOnce(new Error('db'));
    await expect(h.service.reindex(DOC_A)).rejects.toThrow('db');
    expect(h.lifecycle.isClaiming(DOC_A, '2')).toBe(false);
  });

  it('T-FU-CLAIM-6 기동 복구가 버전 레코드를 조회하는 사이 같은 버전이 다시 선점되면 되돌리지 않는다', async () => {
    // ★ 버전 2 레코드가 없는 선점 상태 — 실패한 요청의 되돌리기와 재시도 선점 사이에 스냅샷이 찍힌 경우다
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '2', processingState: 'uploaded' })],
      [versionRecord({ docId: DOC_A, version: '1' })],
    );
    const reached = deferred<void>();
    const gate = deferred<void>();
    const real = h.repo.findVersion.bind(h.repo);
    jest.spyOn(h.repo, 'findVersion').mockImplementationOnce(async (docId, version) => {
      reached.resolve();
      await gate.promise;
      return real(docId, version);
    });
    const resuming = h.scheduler.resume();
    await reached.promise;
    // ★ 첫 확인(표시 없음)을 지난 뒤 재시도 요청이 같은 버전을 선점한다
    h.lifecycle.beginClaim(DOC_A, '2');
    gate.resolve();
    await resuming;
    expect(logLines('documents.resume')[0].recovered).toBe(0);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    h.lifecycle.endClaim(DOC_A, '2');
  });
});

describe('REQ-BE-1.10.4', () => {
  // ★ 기동 때 선점 되돌리기 표 — 마지막 버전 레코드가 없고 이 프로세스의 선점도 아닌 처리 중 문서다
  interface RestoreCase {
    name: string;
    start: ProcessingState;
    startQueued: string | null;
    prev: Parameters<typeof versionRecord>[0];
    state: ProcessingState;
    queued: string | null;
  }
  const RESTORE_CASES: RestoreCase[] = [
    {
      name: '직전 버전에 결과가 있으면 completed·대기열 밖으로 되돌린다',
      start: 'queued',
      startQueued: '3',
      prev: { result: { chunkCount: 2, fallbackUsed: false } },
      state: 'completed',
      queued: null,
    },
    {
      name: '직전 버전이 실패였으면 failed·대기열 밖으로 되돌리고 사유 코드를 기록한다',
      start: 'uploaded',
      startQueued: null,
      prev: {
        result: null,
        failure: { code: 'PARSE_FAILED', message: 'm', headingPath: null, placeholderId: null },
      },
      state: 'failed',
      queued: null,
    },
    {
      name: '직전 버전에 결과도 실패도 없고 작업 ID가 없으면 queued·직전 버전 대기열로 되돌린다',
      start: 'captioning',
      startQueued: null,
      prev: { result: null, jobId: null },
      state: 'queued',
      queued: '2',
    },
    {
      name: '직전 버전에 결과도 실패도 없고 작업 ID가 있으면 queued·대기열 밖으로 되돌린다',
      start: 'indexing',
      startQueued: null,
      prev: { result: null, jobId: 'job-9' },
      state: 'queued',
      queued: null,
    },
  ];

  it.each(RESTORE_CASES)('T-RES-5 $name', async (c) => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          processingState: c.start,
          queuedVersion: c.startQueued,
          latestVersion: '3',
          searchableVersion: '1',
        }),
      ],
      [versionRecord({ docId: DOC_A, version: '2', ...c.prev })],
    );
    await h.scheduler.resume();
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('2');
    expect(doc.processingState).toBe(c.state);
    expect(doc.queuedVersion).toBe(c.queued);
    // ★ 검색되는 버전은 건드리지 않는다
    expect(doc.searchableVersion).toBe('1');
    expect(logLines('documents.resume')[0].recovered).toBe(1);
    const record = h.logs.recordsOf('processing_state').find((r) => r.docId === DOC_A);
    if (c.state === 'completed') expect(record).toBeDefined();
    if (c.state === 'failed') {
      expect(record?.outcome).toBe('failure');
      expect(record?.detail?.reasonCode).toBe('PARSE_FAILED');
    }
  });

  it('T-RES-5d 직전 버전은 레코드가 있는 가장 큰 버전을 숫자로 고른다', async () => {
    // ★ 문자열 비교면 '9'보다 '10' 쪽이 앞서 잘못 고른다 — 마지막 버전 10의 레코드는 없다
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'uploaded', latestVersion: '10' })],
      [
        versionRecord({
          docId: DOC_A,
          version: '1',
          result: { chunkCount: 1, fallbackUsed: false },
        }),
        versionRecord({
          docId: DOC_A,
          version: '9',
          result: null,
          failure: { code: 'PARSE_FAILED', message: 'm', headingPath: null, placeholderId: null },
        }),
      ],
    );
    await h.scheduler.resume();
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('9');
    expect(doc.processingState).toBe('failed');
    expect(logLines('documents.resume')[0].recovered).toBe(1);
  });

  it('T-RES-5e 교체됨·삭제됨 문서는 되돌리지 않는다', async () => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          processingState: 'uploaded',
          searchState: 'replaced',
          latestVersion: '3',
        }),
        docRecord({
          docId: DOC_B,
          processingState: 'captioning',
          deleted: true,
          latestVersion: '3',
        }),
      ],
      [
        versionRecord({ docId: DOC_A, version: '2' }),
        versionRecord({ docId: DOC_B, version: '2' }),
      ],
    );
    await h.scheduler.resume();
    await h.drain();
    expect(docOf(h.db, DOC_A).latestVersion).toBe('3');
    expect(docOf(h.db, DOC_A).processingState).toBe('uploaded');
    expect(docOf(h.db, DOC_B).latestVersion).toBe('3');
    expect(docOf(h.db, DOC_B).processingState).toBe('captioning');
    expect(logLines('documents.resume')[0].recovered).toBe(0);
    expect(h.logs.recordsOf('processing_state')).toEqual([]);
  });
});

describe('REQ-BE-1.10.8', () => {
  it('T-RES-Q1 기동 처리는 대기열 문서의 대기열을 바꾸지 않고 색인도 요청하지 않는다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B, { latestVersion: '2', queuedVersion: '2' }, { version: '2' });
    await seed(h.db, [], [versionRecord({ docId: DOC_B, version: '1', jobId: null })]);
    await h.scheduler.resume();
    await h.drain();
    // ★ 재시작해도 대기열은 그대로 남아 다음 예약 색인을 기다린다
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
    expect(docOf(h.db, DOC_B).queuedVersion).toBe('2');
    expect(docOf(h.db, DOC_B).processingState).toBe('queued');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBeNull();
    expect(logLines('documents.resume')[0]).toMatchObject({
      captioning: 0,
      reconciled: 0,
      recovered: 0,
    });
  });
});

describe('REQ-BE-1.9.11', () => {
  it('T-RES-3 대기열 밖 queued·indexing 문서만 한 번에 상태 맞추기에 넘기고 resume 로그에 개수를 남긴다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'queued' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'indexing' }),
        docRecord({
          docId: DOC_C,
          name: 'c',
          processingState: 'indexing',
          searchState: 'replaced',
        }),
        docRecord({ docId: DOC_D, name: 'd', processingState: 'queued', deleted: true }),
      ],
      [DOC_A, DOC_B, DOC_C, DOC_D].map((docId) => versionRecord({ docId })),
    );
    // ★ 대기열 문서(queuedVersion 있음)는 상태 맞추기에서 빠진다
    await seedQueued(uid(5));
    await h.scheduler.resume();
    await h.drain();
    expect(h.indexing.reconcile).toHaveBeenCalledTimes(1);
    expect(new Set(h.indexing.reconcile.mock.calls[0][0])).toEqual(new Set([DOC_A, DOC_B]));
    const lines = logLines('documents.resume');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ captioning: 0, reconciled: 2, recovered: 0 });
    // ★ requeued 필드는 없다 (색인 재요청 폐기)
    expect(lines[0]).not.toHaveProperty('requeued');
  });
});

describe('REQ-BE-3.3.1', () => {
  it('T-RES-4 이벤트 구독이 준비되기 전에는 기동 처리를 하지 않고 준비되면 돈다', async () => {
    const gate = deferred();
    await boot({ ready: { waitUntilReady: () => gate.promise } });
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'captioning' })],
      [versionRecord({ docId: DOC_A, jobId: null })],
    );
    const finds = findCalls();
    h.scheduler.onApplicationBootstrap();
    await tick();
    expect(findCalls()).toBe(finds);
    expect(h.indexing.reconcile).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    gate.resolve();
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalled();
    expect(h.indexing.reconcile).toHaveBeenCalled();
  });

  it('T-REC-Q1 기동 처리와 runReconcile 모두 대기열 문서를 상태 맞추기에 넘기지 않는다', async () => {
    await seedQueued(DOC_A);
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_B, name: 'b', processingState: 'queued' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'indexing' }),
      ],
      [versionRecord({ docId: DOC_B }), versionRecord({ docId: DOC_C })],
    );
    expect(await h.scheduler.runReconcile()).toBe(2);
    expect(new Set(h.indexing.reconcile.mock.calls[0][0])).toEqual(new Set([DOC_B, DOC_C]));

    h.indexing.reconcile.mockClear();
    await h.scheduler.resume();
    await h.drain();
    expect(h.indexing.reconcile).toHaveBeenCalledTimes(1);
    expect(new Set(h.indexing.reconcile.mock.calls[0][0])).toEqual(new Set([DOC_B, DOC_C]));
  });

  it('T-JOB-1 기동하면 몇 주기 뒤 상태 맞추기와 재요청이 주기마다 돈다', async () => {
    await boot({ config: { RECONCILE_INTERVAL_MS: 30, RAG_RETRY_INTERVAL_MS: 30 } });
    // ★ 대상 문서를 둔다. 대상이 없을 때 호출을 생략하는 구현도 통과해야 한다
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, pendingRag: PENDING_META }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'queued' }),
      ],
      [versionRecord({ docId: DOC_A }), versionRecord({ docId: DOC_B })],
    );
    h.scheduler.onApplicationBootstrap();
    // 기동 처리 한 번과 별개로 주기마다 불리는지 보려고 두 번 이상을 기다린다
    await waitUntil(() => h.indexing.reconcile.mock.calls.length >= 2);
    const reconciled = h.indexing.reconcile.mock.calls.map((call) => new Set(call[0]));
    expect(reconciled.every((ids) => ids.has(DOC_B))).toBe(true);
    await waitUntil(() => docOf(h.db, DOC_A).pendingRag.metadata === false);
    expect(h.indexing.updateMetadata).toHaveBeenCalledWith(
      DOC_A,
      expect.any(String),
      null,
      expect.any(AbortSignal),
    );
    // ★ 두 인터벌은 harness.close()가 지운다
    await h.drain();
  });

  it('T-JOB-2 상태 맞추기가 끝나지 않으면 두 번째 호출은 0을 바로 돌려준다', async () => {
    const gate = deferred();
    h.indexing.reconcile.mockReturnValue(gate.promise);
    const first = h.scheduler.runReconcile();
    await waitUntil(() => h.indexing.reconcile.mock.calls.length === 1);
    expect(await h.scheduler.runReconcile()).toBe(0);
    expect(h.indexing.reconcile).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
  });
});

describe('REQ-BE-1.10.1', () => {
  /** 등록된 예약 색인 크론 작업이다. */
  const indexJob = () => h.registry.getCronJob(INDEX_SCHEDULE_JOB_NAME);

  it('T-SCH-TIMER-1 기동하면 예약 색인 크론 작업을 KST 일정으로 등록해 시작하고 일정 사이에는 요청하지 않는다', async () => {
    expect(INDEX_SCHEDULE_JOB_NAME).toBe('documents.scheduled_index');
    await seedQueued(DOC_A);
    h.scheduler.onApplicationBootstrap();
    await h.drain();
    const job = indexJob();
    expect(job.isActive).toBe(true);
    expect(job.cronTime.timeZone).toBe('Asia/Seoul');
    // 기본 일정 0 0 * * * → 다음 KST 00:00 = 15:00:00Z
    const next = job.nextDate().toJSDate();
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect([next.getUTCHours(), next.getUTCMinutes(), next.getUTCSeconds()]).toEqual([15, 0, 0]);
    // ★ 등록만으로는 요청이 가지 않는다
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();

    // 설정을 바꾸면 그 일정이다 — 30 6 * * * → KST 06:30 = 21:30:00Z
    await boot({ config: { INDEX_SCHEDULE_CRON: '30 6 * * *' } });
    h.scheduler.onApplicationBootstrap();
    await h.drain();
    const other = indexJob().nextDate().toJSDate();
    expect([other.getUTCHours(), other.getUTCMinutes(), other.getUTCSeconds()]).toEqual([
      21, 30, 0,
    ]);

    // ★ close가 크론 작업을 지운다
    alive = false;
    await h.close();
    expect(h.registry.getCronJobs().size).toBe(0);
  });

  it('T-SCH-TIMER-2 일정이 오면 대기열 문서마다 색인을 요청하고 index_scheduled 로그를 남긴다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    h.scheduler.onApplicationBootstrap();
    await h.drain();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    await indexJob().fireOnTick();
    await waitUntil(() => h.indexing.requestIndex.mock.calls.length >= 2);
    await h.drain();
    const requested = h.indexing.requestIndex.mock.calls.map((call) => call[0].docId);
    expect(new Set(requested)).toEqual(new Set([DOC_A, DOC_B]));
    expect(requested).toHaveLength(2);
    const lines = logLines('documents.index_scheduled');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ requested: 2, unreachable: 0 });
  });

  it('T-SCH-TIMER-3 앞 실행이 끝나지 않았으면 두 번째 실행은 바로 끝나고 요청이 늘지 않는다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    const gate = deferred<IndexRequestOutcome>();
    h.indexing.requestIndex.mockReturnValueOnce(gate.promise);
    const first = h.scheduler.runScheduledIndex();
    await waitUntil(() => h.indexing.requestIndex.mock.calls.length === 1);
    // ★ 앞 실행이 첫 문서에서 멈춰 있는 동안 다시 불러도 아무것도 하지 않는다
    await h.scheduler.runScheduledIndex();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    gate.resolve({ kind: 'accepted', jobId: 'job-x' });
    await first;
    // 앞 실행이 둘째 문서까지 마쳐 문서마다 한 번씩이다
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(2);
  });

  it('T-SCH-TIMER-4 종료 중에 일정이 와도 작업을 시작하지 않는다', async () => {
    await seedQueued(DOC_A);
    h.scheduler.onApplicationBootstrap();
    await h.drain();
    const job = indexJob();
    await h.tasks.beforeApplicationShutdown();
    expect(h.tasks.stopping).toBe(true);
    await job.fireOnTick();
    await tick();
    await h.drain();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(logLines('documents.index_scheduled')).toHaveLength(0);
  });

  it('T-SCH-TIMER-5 오지 않는 일정이면 기동은 던지지 않고 크론 작업 없이 경고만 남기며 next_index_at은 null이다', async () => {
    await boot({ config: { INDEX_SCHEDULE_CRON: '0 0 31 2 *' } });
    await seedQueued(DOC_A);
    await expect(Promise.resolve(h.scheduler.onApplicationBootstrap())).resolves.not.toThrow();
    await h.drain();
    expect(h.registry.getCronJobs().has(INDEX_SCHEDULE_JOB_NAME)).toBe(false);
    const warned = capture
      .parsed()
      .filter((line) => line.msg === 'documents.index_schedule_unavailable');
    expect(warned).toHaveLength(1);
    expect(warned[0].level).toBe(40);
    // ★ 필드는 key뿐이다 — 표현식 값과 cron의 오류 메시지는 로그에 없다
    const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
    expect(Object.keys(warned[0]).filter((key) => !PINO_BASE.includes(key))).toEqual(['key']);
    expect(warned[0].key).toBe('INDEX_SCHEDULE_CRON');
    expect(capture.lines.join('\n')).not.toContain('0 0 31 2 *');

    // 대기열 문서의 in_index_queue는 그대로, 다음 시각만 null이다
    const page = await h.service.list(Object.assign(new ListDocumentsQueryDto(), {}));
    const item = page.items.find((row) => row.doc_id === DOC_A);
    expect(item?.in_index_queue).toBe(true);
    expect(item?.next_index_at).toBeNull();
    const detail = await h.service.getDetail(DOC_A);
    expect(detail.in_index_queue).toBe(true);
    expect(detail.next_index_at).toBeNull();
  });
});

describe('REQ-BE-1.8.4', () => {
  it('T-JOB-3a 청크 삭제가 실패하면 표시가 남고 다음 실행에서 지워지며 데이터도 지운다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, deleted: true, pendingRag: PENDING_DELETE })],
      [versionRecord({ docId: DOC_A })],
    );
    h.indexing.deleteChunks.mockResolvedValueOnce(false);
    await h.scheduler.runRagRetry();
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
    await h.scheduler.runRagRetry();
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(false);
    expect(doc.purged).toBe(true);
  });

  it('T-JOB-3b 이름·판 정보 표시가 남은 문서는 다시 보내고 표시를 지운다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, pendingRag: PENDING_META })],
      [versionRecord({ docId: DOC_A })],
    );
    await h.scheduler.runRagRetry();
    expect(h.indexing.updateMetadata).toHaveBeenCalledTimes(1);
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);
  });

  it('T-JOB-3c 삭제됐지만 데이터가 남은 문서는 청크 삭제 없이 데이터만 지운다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, deleted: true })],
      [versionRecord({ docId: DOC_A })],
    );
    await h.scheduler.runRagRetry();
    expect(h.indexing.deleteChunks).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(versionOf(h.db, DOC_A, '1')).toBeUndefined();
  });

  it('T-JOB-3d 교체된 문서의 이름·판 정보 표시는 호출 없이 지운다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, searchState: 'replaced', pendingRag: PENDING_META })],
      [versionRecord({ docId: DOC_A })],
    );
    await h.scheduler.runRagRetry();
    expect(h.indexing.updateMetadata).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);
  });

  it('T-JOB-3e 한 문서가 예외를 던져도 다른 문서는 처리하고 task_failed를 남긴다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', deleted: true, pendingRag: PENDING_DELETE }),
        docRecord({ docId: DOC_B, name: 'b', deleted: true, pendingRag: PENDING_DELETE }),
      ],
      [versionRecord({ docId: DOC_A }), versionRecord({ docId: DOC_B })],
    );
    h.indexing.deleteChunks.mockImplementation(async (docId: string) => {
      if (docId === DOC_A) throw new Error('boom');
      return true;
    });
    await h.scheduler.runRagRetry();
    expect(docOf(h.db, DOC_B).purged).toBe(true);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
    const failed = logLines('documents.task_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].task).toBe('rag_retry');
    expect(failed[0].docId).toBe(DOC_A);
  });

  it('T-JOB-4 재요청이 실행 중이면 두 번째 호출은 아무것도 하지 않는다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, deleted: true, pendingRag: PENDING_DELETE })],
      [versionRecord({ docId: DOC_A })],
    );
    const gate = deferred<boolean>();
    h.indexing.deleteChunks.mockReturnValue(gate.promise);
    const first = h.scheduler.runRagRetry();
    await waitUntil(() => h.indexing.deleteChunks.mock.calls.length === 1);
    await h.scheduler.runRagRetry();
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);
    gate.resolve(true);
    await first;
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-FU-PURGE-2 재요청의 데이터 삭제도 청크 삭제 진행 표시 안에서 돈다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, deleted: true })],
      [versionRecord({ docId: DOC_A })],
    );
    // ★ purge를 직접 부르지 않고 syncChunkDeletion 안에서 돈다
    const spy = jest.spyOn(h.lifecycle, 'syncChunkDeletion');
    await h.scheduler.runRagRetry();
    expect(spy).toHaveBeenCalledWith(DOC_A);
    expect(h.indexing.deleteChunks).not.toHaveBeenCalled();
    const doc = docOf(h.db, DOC_A);
    expect(doc.purged).toBe(true);
    expect(versionOf(h.db, DOC_A, '1')).toBeUndefined();
  });
});

describe('REQ-BE-1.9.11', () => {
  it('T-LEGACY-1b queuedVersion 필드가 없는 queued 문서도 대기열 밖이라 상태 맞추기 대상이다', async () => {
    const legacy: Partial<ReturnType<typeof docRecord>> = docRecord({
      docId: DOC_A,
      name: 'a',
      processingState: 'queued',
    });
    delete legacy.queuedVersion;
    await seed(h.db, [legacy as ReturnType<typeof docRecord>], [versionRecord({ docId: DOC_A })]);
    await h.scheduler.resume();
    await h.drain();
    expect(h.indexing.reconcile).toHaveBeenCalledTimes(1);
    expect(new Set(h.indexing.reconcile.mock.calls[0][0])).toEqual(new Set([DOC_A]));
  });
});
