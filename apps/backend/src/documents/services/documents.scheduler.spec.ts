import {
  DOC_A,
  DOC_B,
  DOC_C,
  DOC_D,
  buildDocumentsTestModule,
  deferred,
  docOf,
  docRecord,
  seed,
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

afterEach(async () => {
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

describe('REQ-BE-1.9.9', () => {
  it('T-RES-1 기동하면 captioning·uploaded 문서의 표·이미지 처리를 잇고 삭제·교체 문서는 건너뛴다', async () => {
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
    const forced = new Map(
      h.indexing.requestIndex.mock.calls.map((call) => [call[0].docId, call[0].force]),
    );
    expect(forced.get(DOC_A)).toBe(true);
    expect(forced.get(DOC_B)).toBe(false);
    expect(forced.has(DOC_C)).toBe(false);
    expect(forced.has(DOC_D)).toBe(false);
  });
});

describe('REQ-BE-1.9.10', () => {
  it('T-RES-2 작업 ID 없는 queued 문서만 색인을 다시 요청하고 reindex 버전은 force다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'queued' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'queued' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'queued' }),
      ],
      [
        versionRecord({ docId: DOC_A, origin: 'hints', jobId: null }),
        versionRecord({ docId: DOC_B, jobId: 'job-1' }),
        versionRecord({ docId: DOC_C, origin: 'reindex', jobId: null }),
      ],
    );
    await h.scheduler.resume();
    await h.drain();
    const forced = new Map(
      h.indexing.requestIndex.mock.calls.map((call) => [call[0].docId, call[0].force]),
    );
    expect(forced.size).toBe(2);
    expect(forced.get(DOC_A)).toBe(false);
    expect(forced.get(DOC_C)).toBe(true);
    expect(forced.has(DOC_B)).toBe(false);
  });

  it('T-RES-5a 마지막 버전 레코드가 없으면 이전 버전으로 되돌리고 결과가 있으면 completed다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', latestVersion: '3' })],
      [
        versionRecord({
          docId: DOC_A,
          version: '2',
          result: { chunkCount: 2, fallbackUsed: false },
        }),
      ],
    );
    await h.scheduler.resume();
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('2');
    expect(doc.processingState).toBe('completed');
    expect(logLines('documents.resume')[0].recovered).toBe(1);
    expect(h.logs.recordsOf('processing_state').some((r) => r.docId === DOC_A)).toBe(true);
  });

  it('T-RES-5c uploaded·captioning·indexing 문서도 마지막 버전 레코드가 없으면 이전 버전으로 되돌린다', async () => {
    const states = ['uploaded', 'captioning', 'indexing'] as const;
    const ids = [DOC_A, DOC_B, DOC_C];
    await seed(
      h.db,
      ids.map((docId, i) =>
        docRecord({ docId, name: docId, processingState: states[i], latestVersion: '2' }),
      ),
      ids.map((docId) => versionRecord({ docId, version: '1' })),
    );
    await h.scheduler.resume();
    await h.drain();
    // ★ 되돌린 뒤 처리 상태는 구현이 정한 순서에 따르므로 마지막 버전만 본다
    for (const docId of ids) expect(docOf(h.db, docId).latestVersion).toBe('1');
    expect(logLines('documents.resume')[0].recovered).toBe(3);
  });

  it('T-RES-5b 이전 버전이 실패였으면 failed로 되돌리고 사유 코드를 기록한다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', latestVersion: '3' })],
      [
        versionRecord({
          docId: DOC_A,
          version: '2',
          result: null,
          failure: { code: 'PARSE_FAILED', message: 'm', headingPath: null, placeholderId: null },
        }),
      ],
    );
    await h.scheduler.resume();
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('2');
    expect(doc.processingState).toBe('failed');
    const record = h.logs.recordsOf('processing_state').find((r) => r.docId === DOC_A);
    expect(record?.outcome).toBe('failure');
    expect(record?.detail?.reasonCode).toBe('PARSE_FAILED');
  });
});

describe('REQ-BE-1.9.11', () => {
  it('T-RES-3 queued·indexing 문서만 한 번에 상태 맞추기에 넘기고 resume 로그에 개수를 남긴다', async () => {
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
    await h.scheduler.resume();
    await h.drain();
    expect(h.indexing.reconcile).toHaveBeenCalledTimes(1);
    expect(new Set(h.indexing.reconcile.mock.calls[0][0])).toEqual(new Set([DOC_A, DOC_B]));
    const lines = logLines('documents.resume');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ captioning: 0, requeued: 0, reconciled: 2, recovered: 0 });
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
    expect(h.indexing.updateMetadata).toHaveBeenCalledWith(DOC_A, expect.any(String), null);
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
