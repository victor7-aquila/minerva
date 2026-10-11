import { AssetsService } from '../../assets';
import type { HintContext, HintKind, HintRunResult } from '../../assets';
import {
  DOC_A,
  DOC_B,
  DOC_C,
  DOC_D,
  FAILMSG_SENT,
  IDX_SENT,
  MD_SENT,
  NAME_SENT,
  buildDocumentsTestModule,
  callOrder,
  createFakeAssets,
  deferred,
  expectSafeKoreanMessage,
  fakePending,
  docOf,
  docRecord,
  ed,
  jobEvent,
  seed,
  seedDoc as seedDocIn,
  uid,
  uploadFile,
  versionOf,
  versionRecord,
} from '../../../test/support/documents-fixtures';
import type { DocumentsHarness } from '../../../test/support/documents-fixtures';
import { createLogCapture } from '../../../test/support/log-capture';
import type { DocumentRecord, DocumentVersionRecord } from '../interfaces/documents.types';

// ★ nestjs-pino 루트 로거는 파일당 하나다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

let h!: DocumentsHarness;
let alive = false;

beforeEach(async () => {
  capture.clear();
  h = await buildDocumentsTestModule({ stream: capture.stream });
  alive = true;
});

afterEach(async () => {
  if (alive) {
    alive = false;
    await h.close();
  }
});

/** 문서 한 개를 시드한다. */
function seedDoc(over: Partial<DocumentRecord> = {}): Promise<DocumentRecord> {
  return seedDocIn(h.db, over);
}

/** Db의 문서에 값을 직접 쓴다(테스트 중 다른 요청이 끼어든 것을 흉내 낸다). */
async function patchDoc(docId: string, set: Record<string, unknown>): Promise<void> {
  await h.db.collection('documents').updateOne({ docId }, { $set: set });
}

/** 한 문서의 처리 상태 기록을 (전, 후) 쌍으로 모은다. */
function transitionsOf(docId: string): Array<[string | undefined, string | undefined]> {
  return h.logs
    .recordsOf('processing_state')
    .filter((input) => input.docId === docId)
    .map((input) => [input.detail?.fromState, input.detail?.toState]);
}

/** 이름 로그 줄 중 msg가 같은 것만 모은다. */
function logLines(msg: string): Record<string, unknown>[] {
  return capture.parsed().filter((line) => line.msg === msg);
}

/** pino가 줄마다 붙이는 기본 필드다. 로그 필드 검사에서 뺀다. */
const PINO_BASE_KEYS = ['level', 'time', 'pid', 'hostname', 'context', 'msg', 'name'];

/** 색인 요청 결과 세 가지(응답을 받은 경우)다. */
const OUTCOMES = [
  ['accepted', { kind: 'accepted', jobId: 'job-9' }],
  ['reused', { kind: 'reused', jobId: 'job-r' }],
  ['rejected', { kind: 'rejected', code: 'INVALID_REQUEST' }],
] as const;

/** seedQueued가 문서에 붙이는 이름이다. 문서마다 달라 이름·판 중복을 피한다. */
function queuedName(docId: string): string {
  return `n-${docId.slice(0, 4)}`;
}

/**
 * 색인 대기열(queuedVersion)에 든 문서와 그 마지막 버전 레코드를 시드한다.
 * ★ 버전 레코드는 아직 요청 전이라 작업 ID·결과가 없다
 */
async function seedQueued(
  docId: string,
  over: Partial<DocumentRecord> = {},
  verOver: Partial<DocumentVersionRecord> = {},
): Promise<void> {
  const latest = over.latestVersion ?? '1';
  await seed(
    h.db,
    [
      docRecord({
        docId,
        name: queuedName(docId),
        processingState: 'queued',
        latestVersion: latest,
        queuedVersion: latest,
        ...over,
      }),
    ],
    [versionRecord({ docId, version: latest, jobId: null, result: null, ...verOver })],
  );
}

/** 색인 요청이 불린 문서 ID를 불린 순서대로 모은다. */
function requestedDocIds(): string[] {
  return h.indexing.requestIndex.mock.calls.map(([input]) => input.docId);
}

/** 문서·버전·기록 호출 수의 스냅샷이다. */
function snapshot() {
  return {
    docs: h.db.dump('documents'),
    versions: h.db.dump('document_versions'),
    records: h.logs.record.mock.calls.length,
  };
}

/** 가짜 generateHints를 감싼다. 핸들러가 값을 돌려주면 그 값이 결과가 되고, 돌려주지 않으면 원래 가짜가 처리한다. */
function interceptHints(
  handler: (
    docId: string,
    version: string,
    kind: HintKind,
    ctx: HintContext,
  ) => Promise<HintRunResult | undefined>,
): void {
  const inner = h.assets.generateHints.getMockImplementation();
  if (inner === undefined) throw new Error('fakePending을 먼저 부른다');
  h.assets.generateHints.mockImplementation(async (docId, version, kind, ctx) => {
    const own = await handler(docId, version, kind, ctx);
    return own ?? inner(docId, version, kind, ctx);
  });
}

/** 첫 generateHints 호출 한 번에만 부르는 핸들러로 감싼다. */
function onFirstHint(fn: () => Promise<void>): void {
  let first = true;
  interceptHints(async () => {
    if (first) {
      first = false;
      await fn();
    }
    return undefined;
  });
}

/** 그 문서에 불린 generateHints 종류를 불린 순서대로 모은다. */
function hintsOf(docId: string): string[] {
  return callOrder(h)
    .filter(([kind, id]) => id === docId && kind !== 'index')
    .map(([kind]) => kind);
}

/** callOrder 결과가 (종류, 문서 집합) 단계 순서와 정확히 같은지 본다. 단계 안의 문서 순서는 따지지 않는다. */
function expectPhases(order: Array<[string, string]>, phases: Array<[string, string[]]>): void {
  let at = 0;
  for (const [kind, ids] of phases) {
    const slice = order.slice(at, at + ids.length);
    expect(slice.map(([k]) => k)).toEqual(ids.map(() => kind));
    expect(new Set(slice.map(([, d]) => d))).toEqual(new Set(ids));
    at += ids.length;
  }
  expect(order).toHaveLength(at);
}

/** updateDocument 필터에서 docId를 꺼낸다. */
function filterDocId(filter: unknown): unknown {
  return (filter as { docId?: unknown }).docId;
}

/** 교체가 일어난 문서의 모습이다(교체됨·실패·대기열 밖). */
const REPLACED_PATCH = {
  searchState: 'replaced',
  processingState: 'failed',
  queuedVersion: null,
} as const;

/** 해당 문서의 captioning 기록 입력을 모은다. */
function captioningRecords(docId: string) {
  return h.logs.recordsOf('captioning').filter((input) => input.docId === docId);
}

describe('REQ-BE-1.9.2', () => {
  it('T-CAP-1 만들 요약·캡션이 있는 대기열 문서만 첫 요청 시점에 captioning이고 대기열에서 빠져 있다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 2, table: 0 },
      [DOC_B]: { image: 0, table: 0 },
    });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    const during: Record<string, DocumentRecord> = {};
    const trans: Record<string, Array<[string | undefined, string | undefined]>> = {};
    onFirstHint(async () => {
      for (const id of [DOC_A, DOC_B]) {
        during[id] = docOf(h.db, id);
        trans[id] = transitionsOf(id);
      }
    });
    await h.lifecycle.runScheduledIndex();
    expect(during[DOC_A]).toMatchObject({ processingState: 'captioning', queuedVersion: null });
    expect(during[DOC_B]).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    // ★ 기록은 요약·캡션을 만들 문서만 queued → captioning이다
    expect(trans[DOC_A]).toEqual([['queued', 'captioning']]);
    expect(trans[DOC_B]).toEqual([]);
  });

  it('T-CAP-2 모든 대상의 captioning 전환이 첫 generateHints보다 먼저다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 0 },
      [DOC_B]: { image: 1, table: 0 },
      [DOC_C]: { image: 0, table: 1 },
    });
    for (const id of [DOC_A, DOC_B, DOC_C]) await seedQueued(id);
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.runScheduledIndex();
    const toCaptioning = spy.mock.calls
      .map(([, set], i) => ({ set, order: spy.mock.invocationCallOrder[i] }))
      .filter(({ set }) => set.processingState === 'captioning');
    expect(toCaptioning).toHaveLength(3);
    const firstHint = Math.min(...h.assets.generateHints.mock.invocationCallOrder);
    expect(Math.max(...toCaptioning.map(({ order }) => order))).toBeLessThan(firstHint);
  });

  it.each([
    ['latestVersion이 바뀌면', { latestVersion: '2' }],
    ['queuedVersion이 바뀌면', { queuedVersion: '2' }],
    ['processingState가 바뀌면', { processingState: 'indexing' }],
  ] as const)(
    'T-CAP-3 2단계 갱신 직전에 다른 요청이 끼어들어 %s 갱신이 어긋나고 요약·캡션도 색인 요청도 없다',
    async (_label, patch) => {
      fakePending(h, { [DOC_A]: { image: 2, table: 0 } });
      await seedQueued(DOC_A);
      const real = h.repo.updateDocument.bind(h.repo);
      jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
        // ★ 읽은 뒤 쓰기 전에 다른 요청이 끼어든 것을 흉내 낸다
        if (set.processingState === 'captioning') await patchDoc(DOC_A, { ...patch });
        return real(filter, set);
      });
      const result = await h.lifecycle.runScheduledIndex();
      expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
      expect(docOf(h.db, DOC_A).processingState).not.toBe('captioning');
      expect(transitionsOf(DOC_A).filter(([, to]) => to === 'captioning')).toEqual([]);
      expect(h.assets.generateHints).not.toHaveBeenCalled();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );

  it('T-CAP-4 업로드·재색인 요청만으로는(예약 색인 없이) captioning이 되지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.reindex(DOC_A);
    await h.service.upload([uploadFile('n.md', '본문')], [{ file_name: 'n.md', name: 'N' }]);
    await h.drain();
    expect(h.db.dump('documents').every((d) => d.processingState !== 'captioning')).toBe(true);
    expect(
      h.logs
        .recordsOf('processing_state')
        .filter((input) => input.detail?.toState === 'captioning'),
    ).toEqual([]);
    expect(h.logs.recordsOf('captioning')).toEqual([]);
    expect(h.assets.generateHints).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.9.3', () => {
  it('T-Q-READY-1 markQueued는 업로드됨을 색인 대기로 바꾸고 대기열에 넣으며 요약·캡션도 색인도 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    await expect(h.lifecycle.markQueued(DOC_A, '1')).resolves.toBe(true);
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
    expect(transitionsOf(DOC_A)).toEqual([['uploaded', 'queued']]);
    // ★ 요약·캡션도 색인도 예약 색인만 요청한다
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(h.assets.pendingHints).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.10.2', () => {
  it('T-Q-READY-2 markQueued의 갱신 하나가 처리 상태와 대기열을 함께 쓴다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.markQueued(DOC_A, '1');
    // ★ 처리 상태를 queued로 쓰는 갱신은 하나뿐이고, 그 갱신이 대기열도 함께 쓴다
    const toQueued = spy.mock.calls.filter(([, set]) => set.processingState === 'queued');
    expect(toQueued).toHaveLength(1);
    expect(toQueued[0][1]).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    // 대기열에 넣는 갱신도 그 하나뿐이다 (대기열만 쓰는 갱신이 따로 없다)
    expect(spy.mock.calls.filter(([, set]) => 'queuedVersion' in set)).toHaveLength(1);
  });

  it.each([
    [
      '처리 상태가 바뀌면',
      { processingState: 'indexing' },
      { processingState: 'indexing', latestVersion: '1' },
    ],
    [
      '새 버전이 생기면',
      { latestVersion: '2', processingState: 'uploaded' },
      { processingState: 'uploaded', latestVersion: '2' },
    ],
  ] as const)(
    'T-Q-READY-5 그 사이 %s 갱신이 어긋나 처리 상태와 대기열이 둘 다 그대로다',
    async (_label, patch, expected) => {
      await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
      const real = h.repo.updateDocument.bind(h.repo);
      // ★ 읽은 뒤 쓰기 전에 다른 요청이 끼어든 것을 흉내 낸다
      jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
        if (set.queuedVersion === '1') await patchDoc(DOC_A, { ...patch });
        return real(filter, set);
      });
      await expect(h.lifecycle.markQueued(DOC_A, '1')).resolves.toBe(false);
      const doc = docOf(h.db, DOC_A);
      expect(doc).toMatchObject(expected);
      expect(doc.queuedVersion).toBeNull();
      expect(transitionsOf(DOC_A)).toEqual([]);
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );

  /** 처리 상태를 queued로 쓰는 갱신을 모은다. */
  async function queuedWrites(run: () => Promise<unknown>) {
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await run();
    await h.drain();
    return spy.mock.calls.filter(([, set]) => set.processingState === 'queued');
  }

  const FIVE_MOMENTS: Array<[string, () => Promise<unknown>]> = [
    [
      'markQueued',
      async () => {
        await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
        await h.lifecycle.markQueued(DOC_A, '1');
      },
    ],
    [
      '예약 색인의 요약·캡션 완료',
      async () => {
        fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
        await seedQueued(DOC_A);
        await h.lifecycle.runScheduledIndex();
      },
    ],
    [
      '예약 색인의 미완료 되돌리기',
      async () => {
        fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
        await seedQueued(DOC_A);
        interceptHints(async () => {
          throw new Error('boom');
        });
        await h.lifecycle.runScheduledIndex();
      },
    ],
    [
      '기동 requeueCaptioning',
      async () => {
        const doc = await seedDoc({ docId: DOC_A, processingState: 'captioning' });
        await h.lifecycle.requeueCaptioning(doc);
      },
    ],
    [
      'requeue',
      async () => {
        await seedDoc({ docId: DOC_A, processingState: 'failed' });
        await patchVersion(DOC_A, '1', { result: null, failure: failureOf('PARSE_FAILED') });
        await h.service.requeue(DOC_A);
      },
    ],
  ];

  it.each(FIVE_MOMENTS)(
    'T-Q-READY-4 %s: 처리 상태를 queued로 쓰는 갱신이 queuedVersion도 함께 쓴다',
    async (_label, run) => {
      const writes = await queuedWrites(run);
      expect(writes.length).toBeGreaterThanOrEqual(1);
      for (const [, set] of writes) {
        expect(set).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
      }
    },
  );
});

describe('REQ-BE-1.10.2', () => {
  it.each([
    [
      '새 버전이 생기면',
      { latestVersion: '2', processingState: 'uploaded' },
      { processingState: 'uploaded', latestVersion: '2' },
    ],
    [
      '처리 상태가 바뀌면',
      { processingState: 'indexing' },
      { processingState: 'indexing', latestVersion: '1' },
    ],
  ] as const)(
    'T-Q-READY-6 기동 requeueCaptioning은 읽은 뒤 %s 갱신이 어긋나 처리 상태와 queuedVersion이 둘 다 그대로다',
    async (_label, patch, expected) => {
      const doc = await seedDoc({ docId: DOC_A, processingState: 'captioning' });
      const real = h.repo.updateDocument.bind(h.repo);
      let intercepted = false;
      // ★ 읽은 뒤 쓰기 전에 다른 요청이 끼어든 것을 흉내 낸다
      jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
        if (set.processingState === 'queued') {
          intercepted = true;
          await patchDoc(DOC_A, { ...patch });
        }
        return real(filter, set);
      });
      await expect(h.lifecycle.requeueCaptioning(doc)).resolves.toBe(false);
      // 끼어들기가 실제로 일어난 뒤의 결과여야 공허하지 않다
      expect(intercepted).toBe(true);
      const after = docOf(h.db, DOC_A);
      expect(after).toMatchObject(expected);
      expect(after.queuedVersion).toBeNull();
      expect(transitionsOf(DOC_A)).toEqual([]);
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['삭제', { deleted: true }],
    ['교체', { searchState: 'replaced' }],
  ] as const)(
    'T-Q-READY-7 기동 requeueCaptioning은 읽은 뒤 %s된 captioning 문서를 queued로 바꾸지 않는다',
    async (_label, patch) => {
      const doc = await seedDoc({ docId: DOC_A, processingState: 'captioning' });
      await patchDoc(DOC_A, { ...patch });
      await expect(h.lifecycle.requeueCaptioning(doc)).resolves.toBe(false);
      expect(docOf(h.db, DOC_A)).toMatchObject({
        processingState: 'captioning',
        queuedVersion: null,
      });
      expect(transitionsOf(DOC_A)).toEqual([]);
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );
});

describe('REQ-BE-1.8.3', () => {
  it.each([
    ['삭제', { deleted: true }, 'deleted'],
    ['교체', { searchState: 'replaced' }, 'replaced'],
  ] as const)(
    'T-Q-STOP-1 응답 뒤 갱신 전에 %s되면 queued가 되지 않고 processing_stopped(사유)가 남는다',
    async (_label, patch, reason) => {
      await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
      await patchDoc(DOC_A, { ...patch });
      h.lifecycle.startQueueing(DOC_A, '1');
      await h.drain();
      const doc = docOf(h.db, DOC_A);
      expect(doc.processingState).toBe('uploaded');
      expect(doc.queuedVersion).toBeNull();
      expect(transitionsOf(DOC_A)).toEqual([]);
      const stopped = logLines('documents.processing_stopped');
      expect(stopped).toHaveLength(1);
      expect(stopped[0].reason).toBe(reason);
    },
  );

  it('T-PROC-3 예약 색인의 요약·캡션 중 삭제되면 shouldContinue가 거짓이 되어 남은 요약·캡션·색인 요청이 없다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    const answers: boolean[] = [];
    interceptHints(async (_docId, _version, _kind, ctx) => {
      answers.push(await ctx.shouldContinue());
      await patchDoc(DOC_A, { deleted: true, queuedVersion: null });
      answers.push(await ctx.shouldContinue());
      return { generated: 0, temporary: 0, stopped: !answers[1], remaining: 2 };
    });
    await h.lifecycle.runScheduledIndex();
    expect(answers).toEqual([true, false]);
    // ★ 이미지 캡션에서 멈췄으므로 표 요약도 색인 요청도 없다
    expect(hintsOf(DOC_A)).toEqual(['image']);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
    const stopped = logLines('documents.processing_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].reason).toBe('deleted');
  });

  it('T-PROC-5 요약·캡션을 마친 직후 삭제되면 queued로 되돌리지 않고 색인을 요청하지 않는다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    interceptHints(async () => {
      await patchDoc(DOC_A, { deleted: true, queuedVersion: null });
      return { generated: 1, temporary: 0, stopped: false, remaining: 0 };
    });
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('captioning');
    expect(doc.queuedVersion).toBeNull();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('deleted');
    expect(captioningRecords(DOC_A)).toEqual([]);
  });
});

describe('REQ-BE-1.2.8', () => {
  it('T-PROC-4 예약 색인의 요약·캡션 중 교체되면 사유가 replaced이고 되돌리지 않고 요청이 없다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    interceptHints(async (_docId, _version, _kind, ctx) => {
      await patchDoc(DOC_A, { ...REPLACED_PATCH });
      const go = await ctx.shouldContinue();
      return { generated: 0, temporary: 0, stopped: !go, remaining: 2 };
    });
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(hintsOf(DOC_A)).toEqual(['image']);
    expect(logLines('documents.processing_stopped')[0].reason).toBe('replaced');
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'failed', queuedVersion: null });
  });

  it('T-PROC-8 요약·캡션을 마친 직후 교체되면 되돌리지 않고 색인을 요청하지 않는다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    interceptHints(async () => {
      await patchDoc(DOC_A, { ...REPLACED_PATCH });
      return { generated: 1, temporary: 0, stopped: false, remaining: 0 };
    });
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'failed', queuedVersion: null });
    expect(logLines('documents.processing_stopped')[0].reason).toBe('replaced');
    expect(captioningRecords(DOC_A)).toEqual([]);
  });
});

describe('REQ-BE-1.9.12', () => {
  it('T-PROC-6 요약·캡션 중 종료가 시작되면 남은 단계가 없고 captioning 그대로이며 사유가 shutdown이다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    let shutdown: Promise<void> | undefined;
    interceptHints(async (_docId, _version, _kind, ctx) => {
      shutdown = h.tasks.beforeApplicationShutdown();
      const go = await ctx.shouldContinue();
      return { generated: 0, temporary: 0, stopped: !go, remaining: 2 };
    });
    await h.lifecycle.runScheduledIndex();
    await shutdown;
    expect(hintsOf(DOC_A)).toEqual(['image']);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('shutdown');
    // ★ 종료로 끊긴 실행은 되돌리지 않는다 — 다음 기동이 queued로 되돌린다
    expect(docOf(h.db, DOC_A)).toMatchObject({
      processingState: 'captioning',
      queuedVersion: null,
    });
  });
});

describe('REQ-BE-1.9.11', () => {
  it('T-EXCL-1 대기열 값이 남은 삭제됨·교체됨 문서는 요약·캡션 생성과 색인 요청 대상에 없다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 1 },
      [DOC_B]: { image: 1, table: 1 },
    });
    // ★ 불변 조건을 깨 둔 시드다 — 예약 색인이 상태를 한 번 더 걸러야 한다
    await seedQueued(DOC_A, { deleted: true });
    await seedQueued(DOC_B, { searchState: 'replaced' });
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
    expect(h.assets.pendingHints).not.toHaveBeenCalled();
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.10.9', () => {
  it('T-ORD-1 이미지 캡션이 모든 문서에 끝난 뒤 표 요약, 그다음 색인 요청 순서다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 1 },
      [DOC_B]: { image: 1, table: 1 },
    });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    await h.lifecycle.runScheduledIndex();
    // ★ 문서 순서는 따지지 않고 단계 경계는 엄격히 본다
    expectPhases(callOrder(h), [
      ['image', [DOC_A, DOC_B]],
      ['table', [DOC_A, DOC_B]],
      ['index', [DOC_A, DOC_B]],
    ]);
  });

  it('T-ORD-2 표만 pending인 문서의 표 요약은 이미지만 pending인 문서의 이미지 캡션보다 뒤다', async () => {
    fakePending(h, {
      [DOC_C]: { image: 0, table: 1 },
      [DOC_D]: { image: 1, table: 0 },
    });
    await seedQueued(DOC_C);
    await seedQueued(DOC_D);
    await h.lifecycle.runScheduledIndex();
    const order = callOrder(h);
    const at = (kind: string, docId: string) =>
      order.findIndex(([k, d]) => k === kind && d === docId);
    expect(at('table', DOC_C)).toBeGreaterThan(at('image', DOC_D));
    // ★ 표만 남은 문서도 이미지 호출이 한 번 있다 — remaining이 표 수로 돌아온다
    expect(hintsOf(DOC_C)).toEqual(['image', 'table']);
    const imageCall = h.assets.generateHints.mock.calls.findIndex(
      ([docId, , kind]) => docId === DOC_C && kind === 'image',
    );
    await expect(h.assets.generateHints.mock.results[imageCall].value).resolves.toMatchObject({
      generated: 0,
      remaining: 1,
    });
  });

  it('T-ORD-3 이미지 캡션에서 마친 문서(remaining 0)에는 표 요약 호출이 없다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 2, table: 0 },
      [DOC_B]: { image: 1, table: 1 },
    });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    await h.lifecycle.runScheduledIndex();
    expect(hintsOf(DOC_A)).toEqual(['image']);
    expect(hintsOf(DOC_B)).toEqual(['image', 'table']);
  });

  it('T-ORD-4 이미지 캡션에서 stopped인 문서는 표 요약·색인 요청이 없고 다른 문서는 계속되며 실행 끝에 queued가 된다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 1 },
      [DOC_B]: { image: 1, table: 1 },
    });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    // ★ 가짜가 문서 상태를 바꾸지 않고 stopped만 돌려준다
    interceptHints(async (docId, _version, kind) =>
      docId === DOC_A && kind === 'image'
        ? { generated: 0, temporary: 0, stopped: true, remaining: 2 }
        : undefined,
    );
    await h.lifecycle.runScheduledIndex();
    expect(hintsOf(DOC_A)).toEqual(['image']);
    expect(hintsOf(DOC_B)).toEqual(['image', 'table']);
    expect(requestedDocIds()).toEqual([DOC_B]);
    // 실행 끝에 REQ-BE-1.9.14로 queued가 된다 (그 실행의 색인 요청은 여전히 없다)
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
  });

  it('T-ORD-5 shouldContinue는 삭제·교체·latestVersion 변경·captioning 아님·종료 중이면 거짓이고 아니면 참이다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    const answers: boolean[] = [];
    let shutdown: Promise<void> | undefined;
    interceptHints(async (_docId, _version, _kind, ctx) => {
      answers.push(await ctx.shouldContinue());
      const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
        [{ deleted: true }, { deleted: false }],
        [{ searchState: 'replaced' }, { searchState: 'searchable' }],
        [{ latestVersion: '2' }, { latestVersion: '1' }],
        [{ processingState: 'queued' }, { processingState: 'captioning' }],
      ];
      for (const [change, restore] of cases) {
        await patchDoc(DOC_A, change);
        answers.push(await ctx.shouldContinue());
        await patchDoc(DOC_A, restore);
      }
      answers.push(await ctx.shouldContinue());
      shutdown = h.tasks.beforeApplicationShutdown();
      answers.push(await ctx.shouldContinue());
      return { generated: 0, temporary: 0, stopped: true, remaining: 1 };
    });
    await h.lifecycle.runScheduledIndex();
    await shutdown;
    // 처음 참, 네 가지 변경은 거짓, 복원하면 참, 종료 중이면 거짓
    expect(answers).toEqual([true, false, false, false, false, true, false]);
  });
});

describe('REQ-BE-1.9.13', () => {
  it('T-DONE-1 이미지만 남은 문서는 image 뒤, 표가 남은 문서는 table 뒤 queued가 되고 갱신 하나가 대기열도 쓴다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 0 },
      [DOC_B]: { image: 0, table: 1 },
      [DOC_C]: { image: 1, table: 1 },
    });
    for (const id of [DOC_A, DOC_B, DOC_C]) await seedQueued(id);
    const afterImage: Record<string, DocumentRecord> = {};
    interceptHints(async (_docId, _version, kind) => {
      if (kind === 'table' && afterImage[DOC_A] === undefined) {
        afterImage[DOC_A] = docOf(h.db, DOC_A);
        afterImage[DOC_B] = docOf(h.db, DOC_B);
      }
      return undefined;
    });
    const atIndex: Record<string, DocumentRecord> = {};
    h.indexing.requestIndex.mockImplementation(async () => {
      for (const id of [DOC_A, DOC_B, DOC_C]) atIndex[id] ??= docOf(h.db, id);
      return { kind: 'accepted', jobId: 'job-x' };
    });
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.runScheduledIndex();
    // image 뒤: 이미지만 남았던 문서는 이미 queued이고 표가 남은 문서는 아직 captioning이다
    expect(afterImage[DOC_A]).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    expect(afterImage[DOC_B]).toMatchObject({ processingState: 'captioning', queuedVersion: null });
    // 색인 요청 시점에는 모두 queued이고 대기열의 그 버전이다
    for (const id of [DOC_A, DOC_B, DOC_C]) {
      expect(atIndex[id]).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
      // ★ 처리 상태와 대기열을 함께 쓰는 갱신이 문서마다 하나다
      const writes = spy.mock.calls.filter(
        ([filter, set]) => filterDocId(filter) === id && set.processingState === 'queued',
      );
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toEqual({ processingState: 'queued', queuedVersion: '1' });
    }
  });

  it('T-DONE-2 captioning 기록이 문서마다 하나이고 count는 generated 합, failedCount는 temporary 합이며 합이 0이면 기록이 없다', async () => {
    await seedQueued(DOC_A, { name: '문서A', edition: ed('v1') });
    await seedQueued(DOC_C);
    h.assets.pendingHints.mockResolvedValue(1);
    h.assets.generateHints.mockImplementation(async (docId, _version, kind) => {
      if (docId === DOC_A && kind === 'image') {
        return { generated: 2, temporary: 1, stopped: false, remaining: 1 };
      }
      if (docId === DOC_A) return { generated: 1, temporary: 0, stopped: false, remaining: 0 };
      // C는 만들 것이 이미 없어졌다(generated 0)
      return { generated: 0, temporary: 0, stopped: false, remaining: 0 };
    });
    await h.lifecycle.runScheduledIndex();
    const records = h.logs.recordsOf('captioning');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'captioning',
      docId: DOC_A,
      name: '문서A',
      editionLabel: 'v1',
      outcome: 'success',
      detail: { count: 3, failedCount: 1 },
    });
    // 기록이 없는 문서도 queued로 돌아온다
    expect(docOf(h.db, DOC_C)).toMatchObject({ processingState: 'queued', queuedVersion: null });
    expect(transitionsOf(DOC_C)).toEqual([
      ['queued', 'captioning'],
      ['captioning', 'queued'],
    ]);
  });

  it.each([
    ['삭제', { deleted: true, queuedVersion: null }],
    ['교체', { ...REPLACED_PATCH }],
  ] as const)(
    'T-DONE-3 이미지 캡션과 표 요약 사이에 %s되면 queued로 돌아가지 않고 captioning 기록이 없다',
    async (label, patch) => {
      fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
      await seedQueued(DOC_A);
      await patchVersion(DOC_A, '1', { failure: failureOf('REPLACED') });
      interceptHints(async (docId, _version, kind) => {
        if (docId === DOC_A && kind === 'table') await patchDoc(DOC_A, { ...patch });
        return undefined;
      });
      await h.lifecycle.runScheduledIndex();
      const doc = docOf(h.db, DOC_A);
      expect(doc.processingState).not.toBe('queued');
      expect(doc.queuedVersion).toBeNull();
      expect(captioningRecords(DOC_A)).toEqual([]);
      expect(transitionsOf(DOC_A)).toEqual([['queued', 'captioning']]);
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
      if (label === '교체') {
        // ★ 교체면 failed(REPLACED) 그대로다
        expect(doc.processingState).toBe('failed');
        expect(versionOf(h.db, DOC_A, '1')?.failure).toMatchObject({ code: 'REPLACED' });
      }
    },
  );

  it.each([
    ['latestVersion이 바뀌면', { latestVersion: '2', processingState: 'uploaded' }],
    ['처리 상태를 다른 요청이 바꾸면', { processingState: 'indexing' }],
  ] as const)(
    'T-DONE-5 단계 사이에 %s 조건이 어긋나 queued로 돌아가지 않고 captioning 기록도 남기지 않는다',
    async (_label, patch) => {
      fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
      await seedQueued(DOC_A);
      interceptHints(async (docId, _version, kind) => {
        if (docId === DOC_A && kind === 'table') await patchDoc(DOC_A, { ...patch });
        return undefined;
      });
      await h.lifecycle.runScheduledIndex();
      const doc = docOf(h.db, DOC_A);
      // ★ 끼어든 값이 그대로이고 대기열에도 되돌아가지 않는다
      expect(doc).toMatchObject({ ...patch, queuedVersion: null });
      expect(captioningRecords(DOC_A)).toEqual([]);
      expect(transitionsOf(DOC_A)).toEqual([['queued', 'captioning']]);
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );

  it('T-DONE-4 기록 순서는 captioning 기록 → captioning → queued 처리 상태 기록이다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    await h.lifecycle.runScheduledIndex();
    const calls = h.logs.record.mock.calls.map(([input]) => input);
    const captionAt = calls.findIndex((i) => i.kind === 'captioning' && i.docId === DOC_A);
    const backAt = calls.findIndex(
      (i) =>
        i.kind === 'processing_state' &&
        i.docId === DOC_A &&
        i.detail?.fromState === 'captioning' &&
        i.detail?.toState === 'queued',
    );
    expect(captionAt).toBeGreaterThanOrEqual(0);
    expect(backAt).toBeGreaterThan(captionAt);
  });
});

describe('REQ-BE-1.10.7', () => {
  it('T-QOUT-1 예약 색인이 captioning으로 바꾸면 같은 갱신에서 queuedVersion이 null이다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.runScheduledIndex();
    const toCaptioning = spy.mock.calls.filter(([, set]) => set.processingState === 'captioning');
    expect(toCaptioning).toHaveLength(1);
    expect(toCaptioning[0][1]).toEqual({ processingState: 'captioning', queuedVersion: null });
  });
});

describe('REQ-BE-1.10.1', () => {
  it('T-SCH-7 요약·캡션을 마친 문서도 같은 실행에서 색인 요청이 가고 force는 origin 규칙이다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 0 },
      [DOC_B]: { image: 0, table: 1 },
    });
    await seedQueued(DOC_A, {}, { origin: 'reindex' });
    await seedQueued(DOC_B, {}, { origin: 'upload' });
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 2, requested: 2, unreachable: 0 });
    const forces = new Map(
      h.indexing.requestIndex.mock.calls.map(([input]) => [input.docId, input.force]),
    );
    expect(forces.get(DOC_A)).toBe(true);
    expect(forces.get(DOC_B)).toBe(false);
  });

  it('T-SCH-8 실행 중 대기열에 들어온 문서(markQueued, requeue)는 그 실행에서 요약·캡션·색인이 없고 다음 실행에서 요청된다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 0 },
      [DOC_C]: { image: 1, table: 0 },
      [DOC_D]: { image: 1, table: 0 },
    });
    await seedQueued(DOC_A);
    await seedDoc({
      docId: DOC_C,
      processingState: 'uploaded',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await seedDoc({ docId: DOC_D, processingState: 'failed' });
    await patchVersion(DOC_D, '1', { result: null, failure: failureOf('PARSE_FAILED') });
    onFirstHint(async () => {
      // ★ 첫 요약·캡션 요청을 기다리는 동안 새 업로드와 실패 문서 되돌리기가 대기열에 들어온다
      await h.lifecycle.markQueued(DOC_C, '1');
      await h.service.requeue(DOC_D);
    });
    await h.lifecycle.runScheduledIndex();
    expect(hintsOf(DOC_C)).toEqual([]);
    expect(hintsOf(DOC_D)).toEqual([]);
    expect(requestedDocIds()).toEqual([DOC_A]);
    expect(docOf(h.db, DOC_C)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    expect(docOf(h.db, DOC_D)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });

    await h.lifecycle.runScheduledIndex();
    expect(hintsOf(DOC_C)).toEqual(['image']);
    expect(hintsOf(DOC_D)).toEqual(['image']);
    expect(new Set(requestedDocIds())).toEqual(new Set([DOC_A, DOC_C, DOC_D]));
  });

  it('T-SCH-9 pending 0으로 queued에 남은 대상이 실행 중 요약·캡션 편집으로 버전 2가 되면 버전 1·2 모두 요청하지 않고 버전 2는 대기열에 남는다', async () => {
    fakePending(h, { [DOC_B]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    onFirstHint(async () => {
      // 요약·캡션 편집이 끼어들어 새 버전을 대기열에 넣은 것을 흉내 낸다
      await seed(
        h.db,
        [],
        [versionRecord({ docId: DOC_A, version: '2', origin: 'hints', jobId: null })],
      );
      await patchDoc(DOC_A, { latestVersion: '2', queuedVersion: '2' });
    });
    const result = await h.lifecycle.runScheduledIndex();
    expect(requestedDocIds()).toEqual([DOC_B]);
    expect(result.requested).toBe(1);
    expect(docOf(h.db, DOC_A)).toMatchObject({
      processingState: 'queued',
      latestVersion: '2',
      queuedVersion: '2',
    });
  });

  it('T-SCH-10 pending 0 대상이 실행 중 내용 다시 올리기로 uploaded가 되면 요청하지 않는다', async () => {
    fakePending(h, { [DOC_B]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    onFirstHint(async () => {
      await patchDoc(DOC_A, {
        processingState: 'uploaded',
        latestVersion: '2',
        queuedVersion: null,
      });
    });
    await h.lifecycle.runScheduledIndex();
    expect(requestedDocIds()).toEqual([DOC_B]);
    expect(docOf(h.db, DOC_A)).toMatchObject({
      processingState: 'uploaded',
      latestVersion: '2',
      queuedVersion: null,
    });
  });

  it('T-SCH-11 (불변식 I-1) 2단계 갱신이 어긋난 pending 1 이상 문서는 대기열이 그대로여도 5단계에서 요청하지 않는다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 2, table: 0 },
      [DOC_B]: { image: 0, table: 0 },
    });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    const real = h.repo.updateDocument.bind(h.repo);
    // ★ captioning 갱신만 어긋나게 한다 — 문서는 queued·대기열 그대로 남는다
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
      if (set.processingState === 'captioning') return false;
      return real(filter, set);
    });
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 1, unreachable: 0 });
    expect(requestedDocIds()).toEqual([DOC_B]);
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
  });

  it('T-SCH-12 선점 중인 문서는 대상에서 빠져 pendingHints도 부르지 않는다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
    await seedQueued(DOC_A);
    h.lifecycle.beginClaim(DOC_A, '2');
    try {
      const result = await h.lifecycle.runScheduledIndex();
      expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
      expect(h.assets.pendingHints).not.toHaveBeenCalled();
      expect(h.assets.generateHints).not.toHaveBeenCalled();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
      expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    } finally {
      h.lifecycle.endClaim(DOC_A, '2');
    }
  });

  it('T-SCH-13 결과가 captioned·requested·unreachable 값을 담는다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 0 },
      [DOC_B]: { image: 0, table: 0 },
      [DOC_C]: { image: 0, table: 0 },
    });
    for (const id of [DOC_A, DOC_B, DOC_C]) await seedQueued(id);
    h.indexing.requestIndex.mockImplementation(async (input) =>
      input.docId === DOC_C ? { kind: 'unreachable' } : { kind: 'accepted', jobId: 'job-x' },
    );
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 1, requested: 3, unreachable: 1 });
  });

  it.each(['pendingHints', 'generateHints'] as const)(
    'T-SCH-14 한 문서의 %s가 던져도 task_failed(scheduled_index) 하나만 남고 그 문서는 요청이 없으며 다른 문서는 끝까지 간다',
    async (which) => {
      fakePending(h, {
        [DOC_A]: { image: 1, table: 1 },
        [DOC_B]: { image: 1, table: 1 },
      });
      await seedQueued(DOC_A);
      await seedQueued(DOC_B);
      if (which === 'pendingHints') {
        const inner = h.assets.pendingHints.getMockImplementation();
        h.assets.pendingHints.mockImplementation(async (docId, version) => {
          if (docId === DOC_A) throw new Error(FAILMSG_SENT);
          return inner ? inner(docId, version) : 0;
        });
      } else {
        interceptHints(async (docId, _version, kind) => {
          if (docId === DOC_A && kind === 'image') throw new Error(FAILMSG_SENT);
          return undefined;
        });
      }
      await h.lifecycle.runScheduledIndex();
      const failed = logLines('documents.task_failed').filter((l) => l.task === 'scheduled_index');
      expect(failed).toHaveLength(1);
      expect(failed[0].docId).toBe(DOC_A);
      // ★ 오류 메시지는 로그에 남지 않는다
      expect(capture.lines.join('\n')).not.toContain(FAILMSG_SENT);
      expect(requestedDocIds()).toEqual([DOC_B]);
      expect(hintsOf(DOC_A)).toEqual(which === 'pendingHints' ? [] : ['image']);
      expect(hintsOf(DOC_B)).toEqual(['image', 'table']);
    },
  );
});

describe('REQ-BE-1.9.14', () => {
  /** 실행 시나리오에서 A가 image 단계에서 던지고 B는 정상인 구성을 만든다. */
  async function setupAThrows(): Promise<void> {
    fakePending(h, {
      [DOC_A]: { image: 2, table: 1 },
      [DOC_B]: { image: 1, table: 1 },
    });
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    interceptHints(async (docId, _version, kind) => {
      if (docId === DOC_A && kind === 'image') throw new Error(FAILMSG_SENT);
      return undefined;
    });
  }

  it('T-UNF-1 image 단계에서 던진 문서는 그 실행에서 table·색인 요청이 없고 실행 끝에 queued+대기열이며 다른 문서는 정상이다', async () => {
    await setupAThrows();
    await h.lifecycle.runScheduledIndex();
    expect(hintsOf(DOC_A)).toEqual(['image']);
    expect(requestedDocIds()).toEqual([DOC_B]);
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    expect(transitionsOf(DOC_A)).toEqual([
      ['queued', 'captioning'],
      ['captioning', 'queued'],
    ]);
    expect(hintsOf(DOC_B)).toEqual(['image', 'table']);
    expect(capture.lines.join('\n')).not.toContain(FAILMSG_SENT);
  });

  it('T-UNF-2 table 단계 뒤에도 remaining이 0이 아닌 문서는 같은 결과다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    interceptHints(async (docId, _version, kind) =>
      docId === DOC_A && kind === 'table'
        ? { generated: 0, temporary: 0, stopped: false, remaining: 1 }
        : undefined,
    );
    await h.lifecycle.runScheduledIndex();
    expect(hintsOf(DOC_A)).toEqual(['image', 'table']);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    expect(transitionsOf(DOC_A)).toEqual([
      ['queued', 'captioning'],
      ['captioning', 'queued'],
    ]);
  });

  it('T-UNF-3 되돌림은 그 실행의 색인 요청 단계 뒤다', async () => {
    await setupAThrows();
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.runScheduledIndex();
    const revertAt = spy.mock.calls.findIndex(
      ([filter, set]) => filterDocId(filter) === DOC_A && set.processingState === 'queued',
    );
    expect(revertAt).toBeGreaterThanOrEqual(0);
    const lastRequest = Math.max(...h.indexing.requestIndex.mock.invocationCallOrder);
    expect(spy.mock.invocationCallOrder[revertAt]).toBeGreaterThan(lastRequest);
  });

  it('T-UNF-4 되돌린 문서는 다음 실행에서 남은 pending만 요청되고 이번에는 마치면 색인 요청이 간다', async () => {
    const map = fakePending(h, { [DOC_A]: { image: 3, table: 0 } });
    await seedQueued(DOC_A);
    const inner = h.assets.generateHints.getMockImplementation();
    let failOnce = true;
    h.assets.generateHints.mockImplementation(async (docId, version, kind, ctx) => {
      if (failOnce) {
        failOnce = false;
        // 하나를 저장한 뒤 던진다
        map[DOC_A].image -= 1;
        throw new Error('boom');
      }
      return inner ? inner(docId, version, kind, ctx) : Promise.reject(new Error('no impl'));
    });
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });

    h.assets.generateHints.mockClear();
    const result = await h.lifecycle.runScheduledIndex();
    expect(result.captioned).toBe(1);
    // ★ 남은 두 개만 요청한다
    const second = h.assets.generateHints.mock.results[0].value as Promise<HintRunResult>;
    await expect(second).resolves.toMatchObject({ generated: 2, remaining: 0 });
    expect(requestedDocIds()).toEqual([DOC_A]);
  });

  it.each([
    ['삭제', { deleted: true, queuedVersion: null }],
    ['교체', { ...REPLACED_PATCH }],
  ] as const)('T-UNF-5 예외 뒤 실행 끝 전에 %s된 문서는 되돌리지 않는다', async (label, patch) => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    await patchVersion(DOC_A, '1', { failure: failureOf('REPLACED') });
    interceptHints(async () => {
      await patchDoc(DOC_A, { ...patch });
      throw new Error('boom');
    });
    await h.lifecycle.runScheduledIndex();
    const doc = docOf(h.db, DOC_A);
    expect(doc.queuedVersion).toBeNull();
    expect(doc.processingState).not.toBe('queued');
    if (label === '교체') {
      expect(doc.processingState).toBe('failed');
      expect(versionOf(h.db, DOC_A, '1')?.failure).toMatchObject({ code: 'REPLACED' });
    }
  });

  it('T-UNF-6 실행 중 종료가 시작되면 되돌리지 않고 captioning 그대로다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedQueued(DOC_A);
    let shutdown: Promise<void> | undefined;
    interceptHints(async () => {
      shutdown = h.tasks.beforeApplicationShutdown();
      throw new Error('boom');
    });
    await h.lifecycle.runScheduledIndex();
    await shutdown;
    // ★ 다음 기동의 REQ-BE-1.9.12 몫이다
    expect(docOf(h.db, DOC_A)).toMatchObject({
      processingState: 'captioning',
      queuedVersion: null,
    });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-UNF-7 되돌리는 갱신 하나가 processingState queued와 queuedVersion을 함께 쓴다', async () => {
    await setupAThrows();
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.runScheduledIndex();
    const reverts = spy.mock.calls.filter(
      ([filter, set]) => filterDocId(filter) === DOC_A && set.processingState === 'queued',
    );
    expect(reverts).toHaveLength(1);
    expect(reverts[0][1]).toEqual({ processingState: 'queued', queuedVersion: '1' });
  });

  it.each([
    ['처리 상태', { processingState: 'indexing' }],
    ['latestVersion', { latestVersion: '2' }],
  ] as const)(
    'T-UNF-7 끼어든 %s 변경으로 조건이 어긋나면 처리 상태와 대기열이 둘 다 그대로다',
    async (_label, patch) => {
      await setupAThrows();
      const real = h.repo.updateDocument.bind(h.repo);
      jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
        // ★ 되돌리는 갱신 직전에 다른 요청이 끼어든다
        if (filterDocId(filter) === DOC_A && set.processingState === 'queued') {
          await patchDoc(DOC_A, { ...patch });
        }
        return real(filter, set);
      });
      await h.lifecycle.runScheduledIndex();
      const doc = docOf(h.db, DOC_A);
      expect(doc.queuedVersion).toBeNull();
      expect(doc).toMatchObject(patch);
    },
  );

  it('T-UNF-8 되돌린 문서마다 failure 기록 하나가 남고 detail은 count·failedCount뿐이며 generated 0이어도 남는다', async () => {
    await seedQueued(DOC_A, { name: '문서A', edition: ed('v1') });
    await seedQueued(DOC_C);
    h.assets.pendingHints.mockResolvedValue(1);
    h.assets.generateHints.mockImplementation(async (docId, _version, kind) => {
      if (docId === DOC_A && kind === 'image') {
        return { generated: 2, temporary: 1, stopped: false, remaining: 1 };
      }
      throw new Error('boom');
    });
    await h.lifecycle.runScheduledIndex();
    const a = captioningRecords(DOC_A);
    const c = captioningRecords(DOC_C);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      outcome: 'failure',
      name: '문서A',
      editionLabel: 'v1',
    });
    // ★ 다른 키·문장이 없다
    expect(a[0].detail).toEqual({ count: 2, failedCount: 1 });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ outcome: 'failure', name: queuedName(DOC_C), editionLabel: null });
    expect(c[0].detail).toEqual({ count: 0, failedCount: 0 });
    // 기록 순서: captioning 기록 → captioning → queued 처리 상태 기록
    const calls = h.logs.record.mock.calls.map(([input]) => input);
    for (const id of [DOC_A, DOC_C]) {
      const captionAt = calls.findIndex((i) => i.kind === 'captioning' && i.docId === id);
      const backAt = calls.findIndex(
        (i) =>
          i.kind === 'processing_state' &&
          i.docId === id &&
          i.detail?.fromState === 'captioning' &&
          i.detail?.toState === 'queued',
      );
      expect(captionAt).toBeGreaterThanOrEqual(0);
      expect(backAt).toBeGreaterThan(captionAt);
    }
  });

  /** T-UNF-9가 시작한 종료 대기다. 테스트 끝에서 기다린다. */
  let unf9Shutdown: Promise<void> | undefined;

  it.each([
    [
      '삭제',
      async () => {
        await patchDoc(DOC_A, { deleted: true, queuedVersion: null });
      },
    ],
    [
      '교체',
      async () => {
        await patchDoc(DOC_A, { ...REPLACED_PATCH });
      },
    ],
    [
      '끼어든 상태 변경',
      async () => {
        await patchDoc(DOC_A, { processingState: 'indexing' });
      },
    ],
    [
      '종료',
      async () => {
        unf9Shutdown = h.tasks.beforeApplicationShutdown();
      },
    ],
  ] as Array<[string, () => Promise<void>]>)(
    'T-UNF-9 되돌리지 못한 경우(%s)는 captioning 기록도 processing_state 기록도 없다',
    async (_label, interfere) => {
      fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
      await seedQueued(DOC_A);
      interceptHints(async () => {
        await interfere();
        throw new Error('boom');
      });
      await h.lifecycle.runScheduledIndex();
      await unf9Shutdown;
      expect(captioningRecords(DOC_A)).toEqual([]);
      // 2단계의 queued → captioning 하나만 있다
      expect(transitionsOf(DOC_A)).toEqual([['queued', 'captioning']]);
    },
  );
});

describe('REQ-BE-1.10.1', () => {
  it('T-SURF-FAKE 가짜 assets의 메서드가 실제 AssetsService 프로토타입의 메서드와 이름·인자 수가 같다', () => {
    // ★ 하네스가 실제 시그니처에서 벗어나는 것을 막는다. documents가 쓰지 않는 공개 메서드는 가짜에 없다
    const NOT_USED_BY_DOCUMENTS = ['readImage', 'onModuleInit'];
    const real = AssetsService.prototype as unknown as Record<string, unknown>;
    const fake = createFakeAssets() as unknown as Record<
      string,
      { getMockImplementation(): { length: number } | undefined }
    >;
    const fakeNames = Object.keys(fake).sort();
    const missing = fakeNames.filter((name) => typeof real[name] !== 'function');
    expect(missing).toEqual([]);
    // 인자 수가 같다 (generateHints 4, rebuildVersion 3, pendingHints 2 …)
    const arity = (name: string): number | undefined => fake[name].getMockImplementation()?.length;
    const mismatched = fakeNames.filter(
      (name) => arity(name) !== (real[name] as { length: number }).length,
    );
    expect(mismatched).toEqual([]);
    // 가짜에 없는 공개 메서드는 documents가 쓰지 않는 것뿐이다
    for (const name of NOT_USED_BY_DOCUMENTS) expect(typeof real[name]).toBe('function');
    expect(fakeNames).toEqual(
      expect.arrayContaining([
        'generateHints',
        'pendingHints',
        'rebuildVersion',
        'prepareVersion',
        'inheritVersion',
        'markTemporaryForRegeneration',
        'hintsFor',
        'listViews',
        'imageUrls',
        'restore',
        'deleteDocument',
      ]),
    );
  });
});

describe('REQ-BE-1.10.1', () => {
  it('T-SCH-1 대기열 문서마다 한 번씩 색인을 요청하고 force는 reindex만 참이다', async () => {
    await seedQueued(DOC_A, {}, { origin: 'upload' });
    await seedQueued(DOC_B, {}, { origin: 'hints' });
    await seedQueued(DOC_C, {}, { origin: 'reindex' });
    h.assets.hintsFor.mockImplementation(async (docId, version) => [
      { placeholderId: 't1', text: `요약-${docId}-${version}` },
    ]);
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 3, unreachable: 0 });
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(3);
    const inputs = new Map(
      h.indexing.requestIndex.mock.calls.map(([input]) => [input.docId, input]),
    );
    for (const [docId, force] of [
      [DOC_A, false],
      [DOC_B, false],
      [DOC_C, true],
    ] as const) {
      expect(inputs.get(docId)).toEqual({
        docId,
        version: '1',
        indexingMarkdown: IDX_SENT,
        hints: [{ placeholderId: 't1', text: `요약-${docId}-1` }],
        name: queuedName(docId),
        edition: null,
        force,
      });
    }
  });

  it('T-SCH-2 대기열 밖의 queued(RAG 접수)·completed·failed 문서는 요청하지 않는다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'queued', queuedVersion: null }),
        docRecord({ docId: DOC_B, name: 'b' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'failed' }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C, result: null, failure: failureOf('PARSE_FAILED') }),
      ],
    );
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-SCH-3 선점 중인 문서는 건너뛰고 대기열에 남으며 선점이 끝나면 다음 일정에서 요청한다', async () => {
    await seedQueued(DOC_A);
    h.lifecycle.beginClaim(DOC_A, '2');
    try {
      const result = await h.lifecycle.runScheduledIndex();
      expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
      expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
    } finally {
      h.lifecycle.endClaim(DOC_A, '2');
    }
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-SCH-3b 요청 직전(hintsFor 대기 중)에 선점이 시작되면 요청하지 않고 대기열에 남긴다', async () => {
    await seedQueued(DOC_A);
    // ★ 맨 앞 검사는 통과하고 hintsFor await 동안 선점이 시작되는 상황이다
    h.assets.hintsFor.mockImplementation(async () => {
      h.lifecycle.beginClaim(DOC_A, '2');
      return [];
    });
    try {
      const result = await h.lifecycle.runScheduledIndex();
      expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
      expect(docOf(h.db, DOC_A)).toMatchObject({ queuedVersion: '1', processingState: 'queued' });
    } finally {
      h.lifecycle.endClaim(DOC_A, '2');
    }
    h.assets.hintsFor.mockResolvedValue([]);
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-SCH-4 마지막 버전 레코드가 없으면 건너뛰고 대기열에 남긴다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A, processingState: 'queued', queuedVersion: '1' })]);
    await seedQueued(DOC_B);
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 1, unreachable: 0 });
    expect(requestedDocIds()).toEqual([DOC_B]);
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
  });

  it('T-SCH-5 한 문서의 요청이 던져도 다음 문서를 요청하고 task_failed가 남는다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    h.indexing.requestIndex.mockImplementation(async (input) => {
      if (input.docId === DOC_A) throw new Error('boom');
      return { kind: 'accepted', jobId: 'job-b' };
    });
    await h.lifecycle.runScheduledIndex();
    expect(new Set(requestedDocIds())).toEqual(new Set([DOC_A, DOC_B]));
    const failed = logLines('documents.task_failed').filter((l) => l.task === 'scheduled_index');
    expect(failed).toHaveLength(1);
    expect(failed[0].docId).toBe(DOC_A);
    // 던진 문서는 대기열에 남고, 요청한 문서는 대기열에서 빠진다
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
    expect(docOf(h.db, DOC_B).queuedVersion).toBeNull();
  });

  it('T-SCH-6 documents.index_scheduled 로그가 requeued·captioned·requested·unreachable 수만 담는다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    h.indexing.requestIndex.mockImplementation(async (input) =>
      input.docId === DOC_A ? { kind: 'accepted', jobId: 'job-a' } : { kind: 'unreachable' },
    );
    await h.scheduler.runScheduledIndex();
    const lines = logLines('documents.index_scheduled');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ requeued: 0, captioned: 0, requested: 2, unreachable: 1 });
    // ★ 필드는 requeued·captioned·requested·unreachable뿐이다 (pino 기본 필드는 뺀다)
    const keys = Object.keys(lines[0])
      .filter((key) => !PINO_BASE_KEYS.includes(key))
      .sort();
    expect(keys).toEqual(['captioned', 'requested', 'requeued', 'unreachable']);
    const text = JSON.stringify(lines[0]);
    for (const sentinel of [NAME_SENT, MD_SENT, IDX_SENT]) expect(text).not.toContain(sentinel);
  });
});

describe('REQ-BE-1.9.4', () => {
  it('T-SCH-R1 accepted면 작업 ID를 버전에 쓰고 처리 상태는 queued, 대기열은 비운다', async () => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockResolvedValue({ kind: 'accepted', jobId: 'job-9' });
    await h.lifecycle.runScheduledIndex();
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBe('job-9');
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBeNull();
    expect(transitionsOf(DOC_A)).toEqual([]);
  });

  it('T-SCH-R2 reused면 검색되는 버전의 결과를 이어받아 완료하고 searchableVersion은 그대로다', async () => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          latestVersion: '2',
          searchableVersion: '1',
          processingState: 'queued',
          queuedVersion: '2',
        }),
      ],
      [
        versionRecord({
          docId: DOC_A,
          version: '1',
          result: { chunkCount: 7, fallbackUsed: false },
        }),
        versionRecord({
          docId: DOC_A,
          version: '2',
          origin: 'reindex',
          jobId: null,
          result: null,
        }),
      ],
    );
    h.indexing.requestIndex.mockResolvedValue({ kind: 'reused', jobId: 'job-r' });
    await h.lifecycle.runScheduledIndex();
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.jobId).toBe('job-r');
    expect(v2?.result).toEqual({ chunkCount: 7, fallbackUsed: false });
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('completed');
    expect(doc.queuedVersion).toBeNull();
    expect(doc.searchableVersion).toBe('1');
    expect(transitionsOf(DOC_A)).toEqual([['queued', 'completed']]);
  });

  it.each([
    ['PAYLOAD_TOO_LARGE', '색인용 MD가 RAG Server의 크기 한도를 넘어 색인하지 못했습니다'],
    ['INVALID_REQUEST', 'RAG Server가 색인 요청을 형식 오류로 거부했습니다'],
  ] as const)(
    'T-SCH-R3 rejected(%s)면 failed이고 RAG Server가 준 코드가 실패 사유다',
    async (code, message) => {
      await seedQueued(DOC_A);
      h.indexing.requestIndex.mockResolvedValue({ kind: 'rejected', code });
      await h.lifecycle.runScheduledIndex();
      const doc = docOf(h.db, DOC_A);
      expect(doc.processingState).toBe('failed');
      expect(doc.queuedVersion).toBeNull();
      expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual({
        code,
        message,
        headingPath: null,
        placeholderId: null,
      });
      const record = h.logs.recordsOf('processing_state').at(-1);
      expect(record?.outcome).toBe('failure');
      expect(record?.detail).toMatchObject({
        fromState: 'queued',
        toState: 'failed',
        reasonCode: code,
      });
    },
  );

  it('T-SCH-R4 unreachable이면 처리 상태·대기열·실패 사유·기록이 하나도 바뀌지 않는다', async () => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockResolvedValue({ kind: 'unreachable' });
    const before = snapshot();
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 1, unreachable: 1 });
    expect(snapshot()).toEqual(before);
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
    expect(versionOf(h.db, DOC_A, '1')?.failure).toBeNull();
    expect(h.logs.recordsOf('processing_state')).toEqual([]);
  });

  it('T-SCH-R5 요청하는 사이 새 버전이 생기면 처리 상태는 안 바뀌고 작업 ID는 요청한 버전에 남는다', async () => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockImplementation(async () => {
      // 요약·캡션 편집이 끼어들어 새 버전을 대기열에 넣은 것을 흉내 낸다
      await patchDoc(DOC_A, { latestVersion: '2', queuedVersion: '2' });
      return { kind: 'accepted', jobId: 'job-9' };
    });
    await h.lifecycle.runScheduledIndex();
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBe('job-9');
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.latestVersion).toBe('2');
    expect(doc.queuedVersion).toBe('2');
  });

  it.each(OUTCOMES)(
    'T-SCH-R6 요청하는 사이 requestSeq가 바뀌면 %s 결과는 버전·처리 상태·대기열을 바꾸지 않는다',
    async (_label, outcome) => {
      await seedQueued(DOC_A);
      h.indexing.requestIndex.mockImplementation(async () => {
        // ★ 실패 되돌리기 1단계가 그 버전을 다시 요청 대상으로 돌린 것을 흉내 낸다
        await h.repo.requeueVersion(DOC_A, '1');
        return outcome;
      });
      await h.lifecycle.runScheduledIndex();
      expect(versionOf(h.db, DOC_A, '1')).toMatchObject({
        jobId: null,
        result: null,
        failure: null,
        requestSeq: 1,
      });
      expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
      expect(h.logs.recordsOf('processing_state')).toEqual([]);
    },
  );

  it.each([
    ['reused', { kind: 'reused', jobId: 'job-r' }],
    ['rejected', { kind: 'rejected', code: 'INVALID_REQUEST' }],
  ] as const)(
    'T-SCH-R7 요청 중 running 이벤트로 indexing이 되면 %s 결과가 덮지 않는다',
    async (_label, outcome) => {
      await seedQueued(DOC_A);
      h.indexing.requestIndex.mockImplementation(async () => {
        await h.lifecycle.onJobStateChanged(
          jobEvent({ docId: DOC_A, jobState: 'running', searchableVersion: null, result: null }),
        );
        return outcome;
      });
      await h.lifecycle.runScheduledIndex();
      const doc = docOf(h.db, DOC_A);
      expect(doc.processingState).toBe('indexing');
      expect(doc.queuedVersion).toBeNull();
    },
  );
});

describe('REQ-BE-1.10.3', () => {
  it.each(OUTCOMES)('T-SCH-Q1 %s 응답을 받으면 대기열에서 뺀다', async (_label, outcome) => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockResolvedValue(outcome);
    await h.lifecycle.runScheduledIndex();
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
  });

  it('T-SCH-Q2 unreachable이면 대기열에 남고 다음 일정에서 같은 버전을 다시 요청한다', async () => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockResolvedValueOnce({ kind: 'unreachable' });
    await h.lifecycle.runScheduledIndex();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(2);
    expect(
      h.indexing.requestIndex.mock.calls.map(([input]) => [input.docId, input.version]),
    ).toEqual([
      [DOC_A, '1'],
      [DOC_A, '1'],
    ]);
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
  });

  it('T-SCH-Q3 requestSeq가 바뀌어 버린 결과는 대기열을 건드리지 않는다', async () => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockImplementation(async () => {
      await h.repo.requeueVersion(DOC_A, '1');
      return { kind: 'accepted', jobId: 'job-late' };
    });
    await h.lifecycle.runScheduledIndex();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
  });

  it('T-SCH-Q4 요청 중 그 버전이 대기열에서 빠졌으면(내용 다시 올리기) 대기열과 처리 상태를 건드리지 않는다', async () => {
    await seedQueued(DOC_A);
    h.indexing.requestIndex.mockImplementation(async () => {
      await patchDoc(DOC_A, {
        processingState: 'uploaded',
        latestVersion: '2',
        queuedVersion: null,
      });
      return { kind: 'reused', jobId: 'job-r' };
    });
    await h.lifecycle.runScheduledIndex();
    expect(docOf(h.db, DOC_A)).toMatchObject({
      processingState: 'uploaded',
      latestVersion: '2',
      queuedVersion: null,
    });
  });
});

describe('REQ-BE-1.10.1', () => {
  it.each([
    ['새 버전이 대기열을 교체', { latestVersion: '2', queuedVersion: '2' }],
    ['내용 다시 올리기로 대기열이 비워짐', { processingState: 'uploaded', queuedVersion: null }],
  ] as const)(
    'T-SCH-RECHK-1 앞 문서를 요청하는 사이 다음 문서의 %s이면 그 문서의 옛 버전은 요청하지 않는다',
    async (_label, patch) => {
      await seedQueued(DOC_A);
      await seedQueued(DOC_B);
      h.indexing.requestIndex.mockImplementationOnce(async (input) => {
        const other = input.docId === DOC_A ? DOC_B : DOC_A;
        await patchDoc(other, { ...patch });
        return { kind: 'accepted', jobId: 'job-first' };
      });
      await h.lifecycle.runScheduledIndex();
      await h.drain();
      // ★ 첫 문서 한 건뿐이다 — 둘째 문서는 바뀐 대기열을 다시 읽고 건너뛴다
      expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
      expect(requestedDocIds()).toHaveLength(1);
    },
  );
});

describe('REQ-BE-1.9.11', () => {
  it('T-SCH-EX-1 queuedVersion이 남아 있어도 삭제됨·교체됨 문서는 요청하지 않는다', async () => {
    // ★ 불변 조건을 깨 둔 시드다 — 예약 색인이 상태를 한 번 더 걸러야 한다
    await seedQueued(DOC_A, { deleted: true });
    await seedQueued(DOC_B, { searchState: 'replaced' });
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.8.3', () => {
  it('T-SCH-DEL-1 대기열 문서를 지우면 다음 예약 색인에서 요청하지 않는다', async () => {
    await seedQueued(DOC_A);
    await h.service.remove(DOC_A);
    await h.drain();
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-SCH-DEL-1b 대기열 조회 뒤 앞 문서를 요청하는 사이 다음 문서가 삭제되면 요청 직전 재검사가 멈춘다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    // ★ 첫 요청 안에서 아직 요청하지 않은 다른 문서를 지운다 — 대기열 조회 단계는 이미 지났다
    h.indexing.requestIndex.mockImplementationOnce(async (input) => {
      const other = input.docId === DOC_A ? DOC_B : DOC_A;
      await patchDoc(other, { deleted: true });
      return { kind: 'accepted', jobId: 'job-first' };
    });
    await h.lifecycle.runScheduledIndex();
    await h.drain();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    expect(requestedDocIds()).toHaveLength(1);
  });
});

describe('REQ-BE-1.8.4', () => {
  it.each([
    ['삭제', { deleted: true }],
    ['교체', { searchState: 'replaced' }],
  ] as const)(
    'T-SCH-DEL-2 예약 색인 요청 중에 %s되면 청크 삭제 표시를 쓰고 백그라운드로 지운다',
    async (_label, patch) => {
      await seedQueued(DOC_A);
      h.indexing.requestIndex.mockImplementation(async () => {
        await patchDoc(DOC_A, { ...patch });
        return { kind: 'accepted', jobId: 'job-x' };
      });
      await h.lifecycle.runScheduledIndex();
      expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
      await h.drain();
      expect(h.indexing.deleteChunks).toHaveBeenCalledWith(DOC_A, expect.any(AbortSignal));
    },
  );
});

describe('REQ-BE-3.1.1', () => {
  it('T-IDX-5 예약 색인 요청에 그 버전의 색인용 MD·요약·캡션과 요청 때의 이름·판·force를 담는다', async () => {
    await seedQueued(
      DOC_A,
      { name: '문서', edition: ed('v1', '2025-03-04') },
      { indexingMarkdown: '색인용 본문', origin: 'reindex' },
    );
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: '요약' }]);
    await h.lifecycle.runScheduledIndex();
    expect(h.assets.hintsFor).toHaveBeenCalledWith(DOC_A, '1');
    expect(h.indexing.requestIndex).toHaveBeenCalledWith({
      docId: DOC_A,
      version: '1',
      indexingMarkdown: '색인용 본문',
      hints: [{ placeholderId: 't1', text: '요약' }],
      name: '문서',
      edition: { label: 'v1', editionDate: '2025-03-04' },
      force: true,
    });
  });
});

describe('REQ-BE-1.10.7', () => {
  it('T-Q-OUT-1 대기열 문서를 지우면 같은 갱신에서 대기열에서 빠진다', async () => {
    await seedQueued(DOC_A);
    await h.service.remove(DOC_A);
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.deleted).toBe(true);
    expect(doc.queuedVersion).toBeNull();
  });

  it('T-Q-OUT-2 대기열 문서가 교체되면 대기열에서 빠지고 REPLACED로 실패한다', async () => {
    const early = { name: 'N', edition: ed('v1') };
    await seedQueued(DOC_A, {
      ...early,
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await seedDoc({
      docId: DOC_B,
      ...early,
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    await h.drain();
    const a = docOf(h.db, DOC_A);
    expect(a.searchState).toBe('replaced');
    expect(a.processingState).toBe('failed');
    expect(a.queuedVersion).toBeNull();
    expect(versionOf(h.db, DOC_A, '1')?.failure).toMatchObject({ code: 'REPLACED' });
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['running', 'indexing'],
    ['succeeded', 'completed'],
    ['failed', 'failed'],
  ] as const)(
    'T-Q-OUT-3 대기열 문서에 %s 이벤트가 오면 %s가 되고 대기열에서 빠진다',
    async (jobState, expected) => {
      await seedQueued(DOC_A, { searchState: 'not_searchable', searchableVersion: null });
      const done = jobState === 'succeeded';
      await h.lifecycle.onJobStateChanged(
        jobEvent({
          docId: DOC_A,
          jobState,
          searchableVersion: done ? '1' : null,
          result: done ? { chunkCount: 5, fallbackUsed: false } : null,
          failure: jobState === 'failed' ? failureOf('PARSE_FAILED', 'm', ['H'], 't1') : null,
        }),
      );
      await h.drain();
      const doc = docOf(h.db, DOC_A);
      expect(doc.processingState).toBe(expected);
      expect(doc.queuedVersion).toBeNull();
      await h.lifecycle.runScheduledIndex();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );
});

describe('REQ-BE-1.9.5', () => {
  it('T-EVT-1 running·succeeded·failed 이벤트가 처리 상태와 버전 결과·사유, 기록을 만든다', async () => {
    await seedDoc({
      docId: DOC_A,
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await seedDoc({
      docId: DOC_B,
      name: '다른',
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId: DOC_A, jobState: 'running', searchableVersion: null, result: null }),
    );
    expect(docOf(h.db, DOC_A).processingState).toBe('indexing');
    // ★ 실행 중 이벤트로는 검색 가능이 되지 않고, 성공 이벤트에서만 된다
    expect(docOf(h.db, DOC_A).searchState).toBe('not_searchable');
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        jobState: 'succeeded',
        result: { chunkCount: 5, fallbackUsed: true },
      }),
    );
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    expect(versionOf(h.db, DOC_A, '1')?.result).toEqual({ chunkCount: 5, fallbackUsed: true });
    expect(transitionsOf(DOC_A)).toEqual([
      ['queued', 'indexing'],
      ['indexing', 'completed'],
    ]);

    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_B,
        jobState: 'failed',
        searchableVersion: null,
        result: null,
        failure: {
          code: 'PARSE_FAILED',
          message: FAILMSG_SENT,
          headingPath: ['H'],
          placeholderId: 't1',
        },
      }),
    );
    expect(docOf(h.db, DOC_B).processingState).toBe('failed');
    expect(versionOf(h.db, DOC_B, '1')?.failure).toEqual({
      code: 'PARSE_FAILED',
      message: FAILMSG_SENT,
      headingPath: ['H'],
      placeholderId: 't1',
    });
    const failure = h.logs.recordsOf('processing_state').find((r) => r.docId === DOC_B);
    expect(failure?.outcome).toBe('failure');
    expect(failure?.detail?.reasonCode).toBe('PARSE_FAILED');
  });

  it('T-EVT-8 같은 성공 이벤트를 두 번 받아도 상태 기록은 하나다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'queued' });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    const after = docOf(h.db, DOC_A);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    expect(docOf(h.db, DOC_A)).toEqual(after);
    expect(h.logs.recordsOf('processing_state')).toHaveLength(1);
  });

  it('T-EVT-10 조건부 갱신이 한 번 어긋나도 다시 읽어 반영하고 기록은 하나다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'queued' });
    const spy = jest.spyOn(h.repo, 'updateDocument').mockResolvedValueOnce(false);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(h.logs.recordsOf('processing_state')).toHaveLength(1);
  });
});

describe('REQ-BE-1.9.6', () => {
  it('T-EVT-12 조건부 갱신이 계속 어긋나면 포기하고 상태·기록을 그대로 둔다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'queued' });
    const before = snapshot();
    const spy = jest.spyOn(h.repo, 'updateDocument').mockResolvedValue(false);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    // ★ 무한히 다시 시도하지 않는다
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
    expect(snapshot()).toEqual(before);
  });

  it('T-EVT-2 오래된 버전·superseded·교체됨·삭제됨·없는 문서의 이벤트는 아무것도 바꾸지 않는다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', latestVersion: '2', processingState: 'queued' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'queued', searchState: 'replaced' }),
        docRecord({
          docId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: 'c',
          processingState: 'queued',
          deleted: true,
        }),
      ],
      [
        versionRecord({ docId: DOC_A, version: '1' }),
        versionRecord({ docId: DOC_A, version: '2' }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      ],
    );
    const before = snapshot();
    const events = [
      jobEvent({ docId: DOC_A, version: '1' }),
      jobEvent({ docId: DOC_A, version: '2', jobState: 'superseded' }),
      jobEvent({ docId: DOC_B }),
      jobEvent({ docId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      jobEvent({ docId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
    ];
    for (const event of events) await h.lifecycle.onJobStateChanged(event);
    expect(snapshot()).toEqual(before);
  });

  it('T-EVT-3 완료된 문서에 늦게 온 같은 버전의 running·queued는 무시한다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'completed' });
    const before = snapshot();
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A, jobState: 'running' }));
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A, jobState: 'queued' }));
    expect(snapshot()).toEqual(before);
  });

  /** 기록된 작업 ID와 다른 작업의 이벤트가 오기 전 문서(색인 대기, 검색 불가)와 버전을 시드한다. */
  async function seedOtherJob(): Promise<void> {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          processingState: 'queued',
          searchState: 'not_searchable',
          searchableVersion: null,
        }),
      ],
      [versionRecord({ docId: DOC_A, jobId: 'job-2', result: null })],
    );
  }

  it('T-FU-JOB-1 버전에 기록된 jobId와 다른 작업의 succeeded 이벤트는 상태·검색 상태·결과·기록을 바꾸지 않는다', async () => {
    await seedOtherJob();
    const before = snapshot();
    await h.lifecycle.onJobStateChanged(
      jobEvent({ jobId: 'job-1', jobState: 'succeeded', searchableVersion: '1' }),
    );
    await h.drain();
    expect(snapshot()).toEqual(before);
    expect(transitionsOf(DOC_A)).toEqual([]);
    expect(h.logs.recordsOf('replace')).toEqual([]);
  });

  it('T-FU-JOB-3 상태 맞추기에서 온 다른 작업의 이벤트도 반영하지 않는다', async () => {
    await seedOtherJob();
    const before = snapshot();
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        jobId: 'job-1',
        jobState: 'succeeded',
        searchableVersion: '1',
        source: 'reconcile',
      }),
    );
    expect(snapshot()).toEqual(before);
  });

  it('T-FU-JOB-4 버전에 jobId가 아직 없으면 그 버전의 이벤트를 반영한다', async () => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          processingState: 'queued',
          searchState: 'not_searchable',
          searchableVersion: null,
        }),
      ],
      [versionRecord({ docId: DOC_A, jobId: null, result: null })],
    );
    await h.lifecycle.onJobStateChanged(
      jobEvent({ jobId: 'job-9', jobState: 'succeeded', searchableVersion: '1' }),
    );
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(versionOf(h.db, DOC_A, '1')?.result).toEqual({ chunkCount: 5, fallbackUsed: false });
    expect(transitionsOf(DOC_A)).toHaveLength(1);
  });

  it('T-FU-JOB-5 기록된 jobId와 같은 작업의 이벤트는 반영한다', async () => {
    await seedOtherJob();
    await h.lifecycle.onJobStateChanged(
      jobEvent({ jobId: 'job-2', jobState: 'succeeded', searchableVersion: '1' }),
    );
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
  });
});

describe('REQ-BE-1.9.7', () => {
  it('T-EVT-5 처음 검색 가능이 되면 먼저 들어온 같은 판 문서를 교체한다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seedDoc({
      docId: DOC_B,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId: DOC_B, jobState: 'succeeded', searchableVersion: '1' }),
    );
    const b = docOf(h.db, DOC_B);
    expect(b.searchState).toBe('searchable');
    expect(b.searchableVersion).toBe('1');
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    expect(h.logs.recordsOf('replace')).toHaveLength(1);
    await h.drain();
  });

  it('T-EVT-6 검색되는 버전은 더 큰 값으로만 바뀐다', async () => {
    for (const incoming of ['2', null]) {
      await seedDoc({
        docId: incoming === null ? DOC_B : DOC_A,
        name: incoming === null ? 'b' : 'a',
        latestVersion: '3',
        searchableVersion: '3',
        processingState: 'queued',
      });
      await h.lifecycle.onJobStateChanged(
        jobEvent({
          docId: incoming === null ? DOC_B : DOC_A,
          version: '3',
          searchableVersion: incoming,
        }),
      );
    }
    expect(docOf(h.db, DOC_A).searchableVersion).toBe('3');
    expect(docOf(h.db, DOC_B).searchableVersion).toBe('3');
  });
});

describe('REQ-BE-1.9.8', () => {
  it('T-EVT-7 검색 가능 문서의 새 버전이 실패해도 검색 가능은 유지된다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '2', processingState: 'indexing' })],
      [
        versionRecord({ docId: DOC_A, version: '1' }),
        versionRecord({ docId: DOC_A, version: '2' }),
      ],
    );
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        version: '2',
        jobState: 'failed',
        searchableVersion: '1',
        result: null,
        failure: { code: 'X', message: 'm', headingPath: null, placeholderId: null },
      }),
    );
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('failed');
    expect(doc.searchState).toBe('searchable');
    expect(doc.searchableVersion).toBe('1');
  });
});

describe('REQ-BE-1.2.6', () => {
  it('T-EVT-9 교체된 문서는 성공 이벤트가 와도 교체됨 그대로다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'indexing', searchState: 'replaced' });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    const doc = docOf(h.db, DOC_A);
    expect(doc.searchState).toBe('replaced');
    expect(doc.processingState).toBe('indexing');
  });
});

describe('REQ-BE-1.2.8', () => {
  it('T-EVT-11 교체가 일어나는 이벤트는 청크 삭제를 기다리지 않고 돌아온다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seedDoc({
      docId: DOC_B,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    const gate = deferred<boolean>();
    h.indexing.deleteChunks.mockReturnValue(gate.promise);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    gate.resolve(true);
    await h.drain();
  });

  it('T-REP-3 처리 중인 후보는 REPLACED 사유로 실패시키고 청크 삭제 표시를 쓴다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
      processingState: 'indexing',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await seedDoc({
      docId: DOC_B,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    h.indexing.deleteChunks.mockResolvedValueOnce(false);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
    const replacedFailure = versionOf(h.db, DOC_A, '1')?.failure;
    expect(replacedFailure).toMatchObject({ code: 'REPLACED' });
    expectSafeKoreanMessage(replacedFailure?.message ?? '');
    const record = h.logs.recordsOf('processing_state').find((r) => r.docId === DOC_A);
    expect(record?.outcome).toBe('failure');
    expect(record?.detail?.reasonCode).toBe('REPLACED');
    // 청크 삭제가 실패하면 표시가 남는다
    await h.drain();
    expect(h.indexing.deleteChunks).toHaveBeenCalledWith(DOC_A, expect.any(AbortSignal));
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
    // 다음 시도가 성공하면 표시가 지워진다
    await h.lifecycle.syncChunkDeletion(DOC_A);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(false);
  });

  it('T-REP-4 처리가 끝난 후보는 처리 상태를 그대로 두고 교체됨만 된다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seedDoc({
      docId: DOC_B,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    const a = docOf(h.db, DOC_A);
    expect(a.processingState).toBe('completed');
    expect(a.searchState).toBe('replaced');
    await h.drain();
  });
});

describe('REQ-BE-1.2.5', () => {
  /** 같은 판 후보(A)와 남을 문서(B)를 만든다. */
  async function pair(a: Partial<DocumentRecord>, b: Partial<DocumentRecord>): Promise<void> {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
      ...a,
    });
    await seedDoc({
      docId: DOC_B,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
      ...b,
    });
  }

  it('T-REP-1a 먼저 들어온 검색 가능 문서는 나중 문서가 검색 가능이 되면 교체된다', async () => {
    await pair({}, {});
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    expect(docOf(h.db, DOC_B).searchState).toBe('searchable');
    await h.drain();
  });

  it('T-REP-1b 나중 문서가 먼저 끝나면 먼저 들어온 처리 중 문서가 교체되고 뒤 이벤트는 무시된다', async () => {
    await pair(
      { processingState: 'indexing', searchState: 'not_searchable', searchableVersion: null },
      {},
    );
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    const a = docOf(h.db, DOC_A);
    expect(a.searchState).toBe('replaced');
    expect(a.processingState).toBe('failed');
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    const afterLate = docOf(h.db, DOC_A);
    expect(afterLate.searchState).toBe('replaced');
    expect(afterLate.processingState).toBe('failed');
    expect(docOf(h.db, DOC_B).searchState).toBe('searchable');
    await h.drain();
  });

  it('T-REP-1c 먼저 들어온 문서가 먼저 검색 가능이 돼도 나중 문서는 교체되지 않고 나중 문서가 될 때 교체된다', async () => {
    await pair(
      { processingState: 'queued', searchState: 'not_searchable', searchableVersion: null },
      {},
    );
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    expect(docOf(h.db, DOC_B).searchState).toBe('not_searchable');
    expect(h.logs.recordsOf('replace')).toHaveLength(0);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    expect(docOf(h.db, DOC_B).searchState).toBe('searchable');
    await h.drain();
  });

  it('T-REP-1d 판 정보가 없는 같은 이름 문서끼리도 먼저 들어온 문서가 교체된다', async () => {
    await pair({ edition: null }, { edition: null });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    await h.drain();
  });

  it('T-REP-1e 판 표기가 다르면 교체하지 않는다', async () => {
    await pair({ edition: ed('v1') }, { edition: ed('v2') });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    expect(h.logs.recordsOf('replace')).toHaveLength(0);
  });

  it('T-REP-1f 삭제된 문서는 후보가 아니다', async () => {
    await pair({ deleted: true }, {});
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    expect(h.logs.recordsOf('replace')).toHaveLength(0);
  });

  it('T-REP-2 교체 기록과 로그에 교체된 문서와 교체한 문서가 담긴다', async () => {
    await pair({ name: 'N' }, {});
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    const replaces = h.logs.recordsOf('replace');
    expect(replaces).toHaveLength(1);
    expect(replaces[0]).toMatchObject({
      docId: DOC_A,
      name: 'N',
      editionLabel: 'v1',
      outcome: 'success',
      detail: { replacedByDocId: DOC_B },
    });
    const lines = logLines('documents.replaced');
    expect(lines).toHaveLength(1);
    expect(lines[0].docId).toBe(DOC_A);
    expect(lines[0].replacedBy).toBe(DOC_B);
    await h.drain();
  });

  it('T-REP-7 교체 대상이 여러 개면 모두 교체되고 문서마다 교체 기록·로그·청크 삭제가 남는다', async () => {
    const [a1, a2, a3, a4, a5] = [1, 2, 3, 4, 5].map((n) => uid(n));
    const early = { name: 'N', edition: ed('v1') };
    await seedDoc({ docId: a1, ...early, editionEnteredAt: new Date('2026-10-01T00:00:00Z') });
    await seedDoc({
      docId: a2,
      ...early,
      editionEnteredAt: new Date('2026-10-01T01:00:00Z'),
      processingState: 'indexing',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    // 남을 문서보다 판에 더 늦게 들어온 문서와 삭제된 문서는 건드리지 않는다
    await seedDoc({ docId: a3, ...early, editionEnteredAt: new Date('2026-10-05T00:00:00Z') });
    await seedDoc({
      docId: a4,
      ...early,
      editionEnteredAt: new Date('2026-10-01T02:00:00Z'),
      deleted: true,
    });
    await seedDoc({ docId: a5, ...early, editionEnteredAt: new Date('2026-10-01T03:00:00Z') });
    await seedDoc({
      docId: DOC_B,
      ...early,
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
      processingState: 'queued',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    await h.drain();
    expect(docOf(h.db, a1).searchState).toBe('replaced');
    expect(docOf(h.db, a1).processingState).toBe('completed');
    expect(docOf(h.db, a5).searchState).toBe('replaced');
    expect(docOf(h.db, a5).processingState).toBe('completed');
    // 처리 중이던 문서는 문서별로 REPLACED 실패가 된다
    expect(docOf(h.db, a2).searchState).toBe('replaced');
    expect(docOf(h.db, a2).processingState).toBe('failed');
    expect(versionOf(h.db, a2, '1')?.failure).toMatchObject({ code: 'REPLACED' });
    expect(docOf(h.db, a3).searchState).toBe('searchable');
    expect(docOf(h.db, a4).searchState).toBe('searchable');
    expect(docOf(h.db, DOC_B).searchState).toBe('searchable');
    const replaced = new Set([a1, a2, a5]);
    const recorded = h.logs.recordsOf('replace');
    expect(recorded).toHaveLength(3);
    expect(new Set(recorded.map((r) => r.docId))).toEqual(replaced);
    expect(recorded.every((r) => r.detail?.replacedByDocId === DOC_B)).toBe(true);
    expect(new Set(logLines('documents.replaced').map((line) => line.docId))).toEqual(replaced);
    expect(new Set(h.indexing.deleteChunks.mock.calls.map((call) => call[0]))).toEqual(replaced);
  });

  it('T-REP-5 남을 문서가 검색 가능이 아니면 아무것도 바뀌지 않는다', async () => {
    await pair({}, {});
    const before = snapshot();
    await h.lifecycle.replaceOlderSiblings(DOC_B);
    expect(snapshot()).toEqual(before);
  });

  it('T-REP-6 후보가 판에 더 늦게 들어왔으면 교체하지 않는다', async () => {
    await seedDoc({
      docId: DOC_B,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-05T00:00:00Z'),
    });
    await h.lifecycle.replaceOlderSiblings(DOC_B);
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    expect(h.logs.recordsOf('replace')).toHaveLength(0);
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-CLEAN-1 데이터 삭제가 실패해도 다음에는 청크 삭제 없이 데이터만 지운다', async () => {
    await seedDoc({
      docId: DOC_A,
      deleted: true,
      pendingRag: { deleteChunks: true, metadata: false },
    });
    h.assets.deleteDocument.mockRejectedValueOnce(new Error('boom'));
    await h.lifecycle.syncChunkDeletion(DOC_A).catch(() => undefined);
    let doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(false);
    expect(doc.purged).toBe(false);
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(1);
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);

    await h.lifecycle.syncChunkDeletion(DOC_A);
    doc = docOf(h.db, DOC_A);
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);
    expect(doc.purged).toBe(true);
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(0);
  });
});

describe('REQ-BE-1.2.8', () => {
  it('T-CLEAN-2 교체된 문서는 청크만 지우고 데이터는 남긴다', async () => {
    await seedDoc({
      docId: DOC_A,
      searchState: 'replaced',
      pendingRag: { deleteChunks: true, metadata: false },
    });
    await h.lifecycle.syncChunkDeletion(DOC_A);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(false);
    expect(h.assets.deleteDocument).not.toHaveBeenCalled();
    expect(h.db.dump('document_versions')).toHaveLength(1);
  });
});

describe('REQ-BE-3.4.2', () => {
  const pending = { deleteChunks: false, metadata: true };

  it('T-META-1 성공하면 표시를 지우고, 그사이 바뀌었으면 남기며, 삭제·교체 문서는 호출 없이 지운다', async () => {
    await seedDoc({ docId: DOC_A, name: 'a', pendingRag: pending });
    await h.lifecycle.syncMetadata(DOC_A);
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);

    await seedDoc({ docId: DOC_B, name: 'b', pendingRag: pending });
    h.indexing.updateMetadata.mockImplementationOnce(async () => {
      await patchDoc(DOC_B, { updatedAt: new Date('2030-01-01T00:00:00Z') });
      return true;
    });
    await h.lifecycle.syncMetadata(DOC_B);
    expect(docOf(h.db, DOC_B).pendingRag.metadata).toBe(true);

    const calls = h.indexing.updateMetadata.mock.calls.length;
    await seedDoc({
      docId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'c',
      deleted: true,
      pendingRag: pending,
    });
    await seedDoc({
      docId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'd',
      searchState: 'replaced',
      pendingRag: pending,
    });
    await h.lifecycle.syncMetadata('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await h.lifecycle.syncMetadata('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(h.indexing.updateMetadata.mock.calls.length).toBe(calls);
    expect(docOf(h.db, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc').pendingRag.metadata).toBe(false);
    expect(docOf(h.db, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd').pendingRag.metadata).toBe(false);
  });

  it('T-META-2 이름·판 정보 변경에 종료 신호를 넘기고, 종료로 끊기면 표시를 남긴다', async () => {
    await seedDoc({ docId: DOC_A, name: 'a', pendingRag: pending });
    h.indexing.updateMetadata.mockImplementation(
      (_docId: string, _name: string, _edition: unknown, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );
    const running = h.lifecycle.syncMetadata(DOC_A);
    await tick();
    expect(h.indexing.updateMetadata).toHaveBeenCalledTimes(1);
    expect(h.indexing.updateMetadata.mock.calls[0][3]).toBe(h.tasks.stopSignal);

    await h.tasks.beforeApplicationShutdown();
    await running;
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(true);
  });
});

/** Db의 버전 레코드에 값을 직접 쓴다(먼저 성공한 쪽이 쓴 값을 흉내 낸다). */
async function patchVersion(
  docId: string,
  version: string,
  set: Record<string, unknown>,
): Promise<void> {
  await h.db.collection('document_versions').updateOne({ docId, version }, { $set: set });
}

/** 실패 사유를 만든다. */
function failureOf(
  code: string,
  message = 'x',
  headingPath: string[] | null = null,
  placeholderId: string | null = null,
) {
  return { code, message, headingPath, placeholderId };
}

describe('REQ-BE-1.9.5', () => {
  it('T-EVT-14 failed 이벤트 반영이 어긋나 포기하면 쓰기 전 사유로 되돌아간다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, result: null, failure: failureOf('OLD') })],
    );
    const before = snapshot();
    jest.spyOn(h.repo, 'updateDocument').mockResolvedValue(false);
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        jobState: 'failed',
        searchableVersion: null,
        result: null,
        failure: failureOf('PARSE_FAILED', 'm', ['H'], 't1'),
      }),
    );
    expect(snapshot()).toEqual(before);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(failureOf('OLD'));
  });

  it('T-EVT-15 먼저 성공한 쪽이 쓴 실패 사유가 있으면 지는 쪽의 되돌리기가 그 값을 지우지 않는다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, result: null, failure: null })],
    );
    const winner = failureOf('INDEX_FAILED', '먼저 성공한 쪽');
    let first = true;
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async () => {
      if (first) {
        first = false;
        await patchVersion(DOC_A, '1', { failure: winner });
        await patchDoc(DOC_A, { processingState: 'failed' });
      }
      return false;
    });
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        jobState: 'failed',
        searchableVersion: null,
        result: null,
        failure: failureOf('PARSE_FAILED', 'm', ['H'], 't1'),
      }),
    );
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(winner);
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
  });

  it('T-EVT-16 먼저 성공한 쪽이 쓴 결과가 있으면 succeeded 되돌리기가 그 결과를 지우지 않는다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, result: null, failure: null })],
    );
    const winner = { chunkCount: 99, fallbackUsed: true };
    let first = true;
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async () => {
      if (first) {
        first = false;
        await patchVersion(DOC_A, '1', { result: winner });
        await patchDoc(DOC_A, { processingState: 'completed' });
      }
      return false;
    });
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        searchableVersion: null,
        result: { chunkCount: 5, fallbackUsed: false },
      }),
    );
    expect(versionOf(h.db, DOC_A, '1')?.result).toEqual(winner);
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
  });

  it('T-EVT-17 실패 사유의 모든 필드가 내가 쓴 값 그대로일 때만 쓰기 전 사유로 되돌린다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, result: null, failure: failureOf('OLD') })],
    );
    const mine = failureOf('PARSE_FAILED', 'm', ['H'], 't1');
    let beforeRollback: unknown;
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async () => {
      beforeRollback = versionOf(h.db, DOC_A, '1')?.failure;
      return false;
    });
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        jobState: 'failed',
        searchableVersion: null,
        result: null,
        failure: mine,
      }),
    );
    // 되돌리기 직전의 사유가 내가 쓴 값과 모든 필드에서 같았다
    expect(beforeRollback).toEqual(mine);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(failureOf('OLD'));
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
  });

  it('T-EVT-18 실패 사유의 중첩 값 하나(placeholderId)만 달라도 먼저 성공한 쪽의 값을 보존한다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, result: null, failure: failureOf('OLD') })],
    );
    const winner = failureOf('PARSE_FAILED', 'm', null, 'other');
    let first = true;
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async () => {
      if (first) {
        first = false;
        await patchVersion(DOC_A, '1', { failure: winner });
        await patchDoc(DOC_A, { processingState: 'failed' });
      }
      return false;
    });
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        jobState: 'failed',
        searchableVersion: null,
        result: null,
        failure: failureOf('PARSE_FAILED', 'm', null, null),
      }),
    );
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(winner);
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
  });
});

/** 이벤트 루프를 한 바퀴 돌려 대기 중인 비동기 작업을 진행시킨다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 청크 삭제 표시가 켜진 교체됨 문서를 시드한다. */
function seedReplacedPending(deleted = false): Promise<DocumentRecord> {
  return seedDoc({
    docId: DOC_A,
    deleted,
    searchState: deleted ? 'searchable' : 'replaced',
    pendingRag: { deleteChunks: true, metadata: false },
  });
}

/** 첫 deleteChunks 호출을 붙잡아 두고, 그 호출이 실제로 시작됐다는 신호를 돌려준다. */
function holdFirstDelete() {
  const first = deferred<boolean>();
  const started = deferred<void>();
  h.indexing.deleteChunks.mockImplementationOnce(() => {
    started.resolve();
    return first.promise;
  });
  return { first, started: started.promise };
}

describe('REQ-BE-1.8.4', () => {
  it('T-DEL-7 청크 삭제에 종료 신호를 넘기고, 종료로 끊기면 표시를 남기고 데이터를 지우지 않는다', async () => {
    await seedDoc({
      docId: DOC_A,
      deleted: true,
      pendingRag: { deleteChunks: true, metadata: false },
    });
    // 끊기면 거짓을 돌려주는 rag 호출을 흉내 낸다 (indexing은 끊긴 요청을 거짓으로 바꾼다)
    h.indexing.deleteChunks.mockImplementation(
      (_docId: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );
    const running = h.lifecycle.syncChunkDeletion(DOC_A);
    await tick();
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);
    // ★ 아무 신호가 아니라 작업 실행기의 종료 신호여야 종료 때 끊긴다
    expect(h.indexing.deleteChunks.mock.calls[0][1]).toBe(h.tasks.stopSignal);

    await h.tasks.beforeApplicationShutdown();
    await running;
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(true);
    expect(doc.purged).toBe(false);
    expect(h.assets.deleteDocument).not.toHaveBeenCalled();
  });

  it('T-DEL-4 삭제 요청이 대기 중일 때 같은 문서의 재요청이 오면 삭제를 다시 부르고 표시는 false로 끝난다', async () => {
    await seedReplacedPending();
    const { first, started } = holdFirstDelete();
    h.indexing.deleteChunks.mockResolvedValue(true);
    const running = h.lifecycle.syncChunkDeletion(DOC_A);
    await started;
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);
    // ★ 진행 중의 재요청은 바로 돌아오고 dirty만 세운다
    await h.lifecycle.syncChunkDeletion(DOC_A);
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await running;
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(2);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(false);
  });

  it('T-DEL-5 진행 중이던 삭제가 표시를 지웠어도 재실행이 표시를 되살려 삭제를 다시 부른다', async () => {
    await seedReplacedPending();
    const { first, started } = holdFirstDelete();
    const second = deferred<boolean>();
    h.indexing.deleteChunks.mockReturnValueOnce(second.promise);
    const running = h.lifecycle.syncChunkDeletion(DOC_A);
    await started;
    await h.lifecycle.syncChunkDeletion(DOC_A);
    first.resolve(true);
    await tick();
    // 재실행의 삭제 요청이 나가 있는 동안 표시는 켜져 있다
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(2);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
    second.resolve(true);
    await running;
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(false);
  });

  it('T-DEL-6 재요청이 없었으면 삭제는 한 번만 부르고 다시 돌지 않는다', async () => {
    await seedReplacedPending();
    await h.lifecycle.syncChunkDeletion(DOC_A);
    await tick();
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(1);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(false);
  });

  it('T-DEL-7 재실행의 삭제가 실패하면 표시가 true로 남아 주기 작업이 잇는다', async () => {
    await seedReplacedPending();
    const { first, started } = holdFirstDelete();
    h.indexing.deleteChunks.mockResolvedValueOnce(false);
    const running = h.lifecycle.syncChunkDeletion(DOC_A);
    await started;
    await h.lifecycle.syncChunkDeletion(DOC_A);
    first.resolve(true);
    await running;
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(2);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-DEL-8 삭제된 문서에서도 재실행 뒤 데이터 정리가 이어지고 표시가 지워진다', async () => {
    await seedReplacedPending(true);
    const { first, started } = holdFirstDelete();
    h.indexing.deleteChunks.mockResolvedValue(true);
    const running = h.lifecycle.syncChunkDeletion(DOC_A);
    await started;
    await h.lifecycle.syncChunkDeletion(DOC_A);
    first.resolve(true);
    await running;
    expect(h.indexing.deleteChunks).toHaveBeenCalledTimes(2);
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(false);
    expect(doc.purged).toBe(true);
  });

  it('T-PR3-DEL-4a 새 버전을 쓴 뒤 문서가 삭제됐으면 purged를 거짓으로 되돌렸다가 데이터를 다시 지운다', async () => {
    // ★ 그사이 데이터 삭제(purge)가 끝나 purged가 true인 상태에서 새 버전의 데이터가 남은 경우다
    await seedDoc({ docId: DOC_A, deleted: true, purged: true });
    const sets: unknown[] = [];
    const real = h.repo.updateDocument.bind(h.repo);
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
      sets.push(set);
      return real(filter, set);
    });
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    expect(sets).toContainEqual({ purged: false });
    // 청크 삭제는 백그라운드로 걸리므로 이 시점에는 아직 거짓이다
    expect(docOf(h.db, DOC_A).purged).toBe(false);
    await h.drain();
    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(DOC_A);
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(0);
  });

  it('T-PR3-DEL-4b 삭제되지 않은 문서와 없는 문서는 아무것도 바꾸지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    const before = snapshot();
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    await h.lifecycle.recheckAfterVersionWrite(DOC_B);
    await h.drain();
    expect(snapshot()).toEqual(before);
    expect(h.indexing.deleteChunks).not.toHaveBeenCalled();
    expect(h.assets.deleteDocument).not.toHaveBeenCalled();
  });

  it('T-PR3-DEL-4c 문서 조회가 실패해도 예외를 던지지 않는다', async () => {
    await seedDoc({ docId: DOC_A, deleted: true, purged: true });
    jest.spyOn(h.repo, 'findDocument').mockRejectedValue(new Error('boom'));
    // ★ 삼킨다 — 호출자의 결과·오류가 우선이다
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_A)).resolves.toBeNull();
  });

  it('T-FU-PURGE-1 데이터 삭제가 purged를 쓰기 직전에 새 버전이 쓰이고 recheck가 돌아도 새 버전 데이터까지 지운다', async () => {
    await seedDoc({ docId: DOC_A, deleted: true, purged: false });
    await patchDoc(DOC_A, { 'pendingRag.deleteChunks': true });
    // ★ purged: true를 쓰는 호출에서 멈춘다
    const reached = deferred<void>();
    const gate = deferred<void>();
    const real = h.repo.updateDocument.bind(h.repo);
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
      if (set.purged === true) {
        reached.resolve();
        await gate.promise;
      }
      return real(filter, set);
    });
    const running = h.lifecycle.syncChunkDeletion(DOC_A);
    await reached.promise;
    // 새 버전 쓰기를 흉내 낸다
    await h.db
      .collection('document_versions')
      .insertOne({ ...versionRecord({ docId: DOC_A, version: '2' }) });
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    gate.resolve();
    await running;
    await h.drain();
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(0);
    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(h.assets.deleteDocument.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('T-FU-ORDER-4 recheckAfterVersionWrite는 삭제됨·교체됨·그대로를 돌려준다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', deleted: true, purged: true }),
        docRecord({ docId: DOC_B, name: 'b', searchState: 'replaced', processingState: 'failed' }),
        docRecord({ docId: DOC_C, name: 'c' }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C }),
      ],
    );
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_A)).resolves.toBe('deleted');
    // 없는 문서는 이을 처리가 없으므로 삭제된 것과 같다
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_D)).resolves.toBe('deleted');
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_B)).resolves.toBe('replaced');
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_C)).resolves.toBeNull();
    await h.drain();
    // 조회 실패는 삼키고 null이다
    jest.spyOn(h.repo, 'findDocument').mockRejectedValue(new Error('boom'));
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_C)).resolves.toBeNull();
  });
});

describe('REQ-BE-1.2.8', () => {
  /** 교체됨·실패 상태의 문서를 만든다. */
  function seedReplacedFailed(latestVersion = '1'): Promise<DocumentRecord> {
    return seedDoc({
      docId: DOC_A,
      searchState: 'replaced',
      processingState: 'failed',
      latestVersion,
    });
  }

  it('T-PR3-REPL-2a 교체·실패 문서의 마지막 버전에 사유가 없으면 REPLACED 사유를 쓴다', async () => {
    await seedReplacedFailed();
    await patchVersion(DOC_A, '1', { failure: null });
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    const failure = versionOf(h.db, DOC_A, '1')?.failure;
    expect(failure).toMatchObject({ code: 'REPLACED' });
    expectSafeKoreanMessage(failure?.message ?? '');
  });

  it('T-PR3-REPL-2b 이미 사유가 있으면 덮지 않는다', async () => {
    await seedReplacedFailed();
    const existing = failureOf('PARSE_FAILED', '먼저 쓴 사유');
    await patchVersion(DOC_A, '1', { failure: existing });
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(existing);
  });

  it('T-PR3-REPL-2c 다시 읽은 문서의 마지막 버전에만 쓰고 다른 버전에는 쓰지 않는다', async () => {
    await seedReplacedFailed('2');
    await patchVersion(DOC_A, '1', { failure: null });
    await patchVersion(DOC_A, '2', { failure: null });
    // ★ 인자 없이 다시 읽은 문서의 latestVersion(2) 버전에 쓴다. 버전 1은 건드리지 않는다
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toBeNull();
    expect(versionOf(h.db, DOC_A, '2')?.failure).toMatchObject({ code: 'REPLACED' });
  });

  it('T-PR3-REPL-2d 교체되지 않았거나 실패가 아닌 문서에는 쓰지 않는다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'a',
      searchState: 'searchable',
      processingState: 'failed',
    });
    await seedDoc({
      docId: DOC_B,
      name: 'b',
      searchState: 'replaced',
      processingState: 'completed',
    });
    await h.lifecycle.recheckAfterVersionWrite(DOC_A);
    await h.lifecycle.recheckAfterVersionWrite(DOC_B);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toBeNull();
    expect(versionOf(h.db, DOC_B, '1')?.failure).toBeNull();
  });
});

describe('REQ-BE-1.9.5', () => {
  it('T-PR3-DROP-1 반영을 세 번 모두 못 하면 documents.event_dropped가 한 번 남는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'queued' });
    const spy = jest.spyOn(h.repo, 'updateDocument').mockResolvedValue(false);
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A, jobState: 'succeeded' }));
    expect(spy).toHaveBeenCalledTimes(3);
    const lines = logLines('documents.event_dropped');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ docId: DOC_A, version: '1', jobState: 'succeeded' });
    // ★ 필드는 정확히 docId·version·jobState뿐이다 (pino 기본 필드는 뺀다)
    const pinoBase = ['level', 'time', 'pid', 'hostname', 'context', 'msg', 'name'];
    const keys = Object.keys(lines[0])
      .filter((key) => !pinoBase.includes(key))
      .sort();
    expect(keys).toEqual(['docId', 'jobState', 'version']);
  });

  it('T-PR3-DROP-1b 반영하거나 반영할 것이 없으면 event_dropped를 남기지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'queued' });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    // 이미 반영된 같은 이벤트와 오래된 버전의 이벤트는 반영할 것이 없다
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A }));
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A, version: '9' }));
    expect(logLines('documents.event_dropped')).toHaveLength(0);
  });
});

describe('REQ-BE-1.1.9', () => {
  it('T-PR3-DUP-1 같은 버전의 startQueueing을 두 번 불러도 uploaded → queued 기록은 하나다', async () => {
    await seedDoc({
      docId: DOC_A,
      processingState: 'uploaded',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    // ★ 중복을 막는 것은 조건부 갱신이다 — 둘째 호출은 uploaded가 아니라서 건너뛴다
    h.lifecycle.startQueueing(DOC_A, '1');
    h.lifecycle.startQueueing(DOC_A, '1');
    await h.drain();
    expect(transitionsOf(DOC_A)).toEqual([['uploaded', 'queued']]);
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.9.5', () => {
  it('T-EVT-Q1 queued 이벤트는 대기열을 채우지 않는다', async () => {
    await seedQueued(DOC_A);
    // 대기열 밖의 queued(RAG 접수)다
    await seedDoc({ docId: DOC_B, name: 'b', processingState: 'queued' });
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A, jobState: 'queued' }));
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B, jobState: 'queued' }));
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    expect(docOf(h.db, DOC_B)).toMatchObject({ processingState: 'queued', queuedVersion: null });
  });

  it.each(['RAG_UNREACHABLE', 'PARSE_FAILED', 'REPLACED'])(
    'T-EVT-F1 실패 코드 %s 문서는 같은 버전의 어떤 이벤트로도 상태·결과·사유가 바뀌지 않는다',
    async (code) => {
      await seed(
        h.db,
        [docRecord({ docId: DOC_A, processingState: 'failed' })],
        [versionRecord({ docId: DOC_A, result: null, failure: failureOf(code, '기존 사유') })],
      );
      const before = snapshot();
      for (const jobState of ['queued', 'running', 'succeeded', 'failed'] as const) {
        await h.lifecycle.onJobStateChanged(
          jobEvent({
            docId: DOC_A,
            jobState,
            result: jobState === 'succeeded' ? { chunkCount: 4, fallbackUsed: false } : null,
            failure: jobState === 'failed' ? failureOf('PARSE_FAILED', 'm', ['H'], 't1') : null,
          }),
        );
      }
      expect(snapshot()).toEqual(before);
      expect(docOf(h.db, DOC_A).processingState).toBe('failed');
      expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(failureOf(code, '기존 사유'));
      expect(versionOf(h.db, DOC_A, '1')?.result).toBeNull();
      expect(h.logs.recordsOf('processing_state')).toEqual([]);
    },
  );

  it.each([
    ['지금 값보다 크면 갱신한다', '1', 'searchable', '2', '2', 'searchable'],
    ['검색되는 버전이 없었으면 갱신한다', null, 'not_searchable', '1', '1', 'searchable'],
    ['지금 값보다 작으면 그대로다', '2', 'searchable', '1', '2', 'searchable'],
  ] as const)(
    'T-EVT-F2 실패 문서도 이벤트의 searchableVersion이 %s (처리 상태는 failed 그대로)',
    async (_label, current, currentState, incoming, expectedVersion, expectedState) => {
      await seed(
        h.db,
        [
          docRecord({
            docId: DOC_A,
            latestVersion: '2',
            processingState: 'failed',
            searchState: currentState,
            searchableVersion: current,
          }),
        ],
        [
          versionRecord({ docId: DOC_A, version: '1' }),
          versionRecord({
            docId: DOC_A,
            version: '2',
            result: null,
            failure: failureOf('PARSE_FAILED', '기존 사유'),
          }),
        ],
      );
      await h.lifecycle.onJobStateChanged(
        jobEvent({
          docId: DOC_A,
          version: '2',
          jobState: 'succeeded',
          searchableVersion: incoming,
        }),
      );
      await h.drain();
      const doc = docOf(h.db, DOC_A);
      expect(doc.searchableVersion).toBe(expectedVersion);
      expect(doc.searchState).toBe(expectedState);
      expect(doc.processingState).toBe('failed');
      expect(versionOf(h.db, DOC_A, '2')?.failure).toEqual(failureOf('PARSE_FAILED', '기존 사유'));
      expect(versionOf(h.db, DOC_A, '2')?.result).toBeNull();
      expect(h.logs.recordsOf('processing_state')).toEqual([]);
    },
  );
});

/** 마이그레이션 전 버전 레코드다 — requestSeq 필드가 아예 없다. */
function legacyVersion(over: Partial<DocumentVersionRecord> = {}): DocumentVersionRecord {
  const record: Partial<DocumentVersionRecord> = versionRecord(over);
  delete record.requestSeq;
  return record as DocumentVersionRecord;
}

/** 마이그레이션 전 문서 레코드다 — queuedVersion 필드가 아예 없다. */
function legacyDoc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  const record: Partial<DocumentRecord> = docRecord(over);
  delete record.queuedVersion;
  return record as DocumentRecord;
}

describe('REQ-BE-1.9.4', () => {
  it('T-LEGACY-2 requestSeq 필드가 없는 옛 버전 레코드도 요청이 accepted면 작업 ID가 쓰이고 대기열에서 빠진다', async () => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          name: queuedName(DOC_A),
          processingState: 'queued',
          queuedVersion: '1',
        }),
      ],
      [legacyVersion({ docId: DOC_A, jobId: null, result: null })],
    );
    expect(versionOf(h.db, DOC_A, '1')).not.toHaveProperty('requestSeq');
    h.indexing.requestIndex.mockResolvedValue({ kind: 'accepted', jobId: 'job-legacy' });
    await h.lifecycle.runScheduledIndex();
    await h.drain();
    // ★ requestSeq: 0 조건으로 쓰면 필드 없는 레코드와 맞지 않아 작업 ID가 영영 안 써진다
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBe('job-legacy');
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
  });
});

describe('REQ-BE-1.10.1', () => {
  it('T-LEGACY-1 queuedVersion 필드가 없는 queued 문서는 대기열 밖(RAG 접수)이라 예약 색인이 요청하지 않는다', async () => {
    await seed(
      h.db,
      [legacyDoc({ docId: DOC_A, name: 'a', processingState: 'queued' })],
      [versionRecord({ docId: DOC_A })],
    );
    expect(docOf(h.db, DOC_A)).not.toHaveProperty('queuedVersion');
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.10.10', () => {
  /** 앞 실행이 되돌리지 못해 captioning으로 남은 문서를 시드한다. */
  async function seedCaptioning(docId: string, over: Partial<DocumentRecord> = {}): Promise<void> {
    await seed(
      h.db,
      [
        docRecord({
          docId,
          name: queuedName(docId),
          processingState: 'captioning',
          latestVersion: '1',
          queuedVersion: null,
          ...over,
        }),
      ],
      [versionRecord({ docId, version: '1', jobId: null, result: null })],
    );
  }

  it('T-REQ10-1 시작 때 남은 captioning 문서를 queued+대기열로 되돌려 그 실행에서 남은 것만 만들고 색인 요청까지 간다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 1 } });
    await seedCaptioning(DOC_A);
    await seedQueued(DOC_B);
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toMatchObject({ requeued: 1, captioned: 1, requested: 2 });
    expect(hintsOf(DOC_A)).toEqual(['image', 'table']);
    expect([...requestedDocIds()].sort()).toEqual([DOC_A, DOC_B].sort());
    // ★ 되돌림이 대상 읽기보다 먼저라 같은 실행에서 다시 captioning을 거친다
    expect(transitionsOf(DOC_A)).toEqual([
      ['captioning', 'queued'],
      ['queued', 'captioning'],
      ['captioning', 'queued'],
    ]);
  });

  it('T-REQ10-2 삭제됨·교체됨인 captioning 문서는 되돌리지 않고 대상에도 없다', async () => {
    fakePending(h, {
      [DOC_A]: { image: 1, table: 0 },
      [DOC_B]: { image: 1, table: 0 },
    });
    await seedCaptioning(DOC_A, { deleted: true });
    await seedCaptioning(DOC_B, { searchState: 'replaced' });
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 0, unreachable: 0 });
    expect(docOf(h.db, DOC_A).processingState).toBe('captioning');
    expect(docOf(h.db, DOC_B).processingState).toBe('captioning');
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-REQ10-3 되돌리는 갱신이 던지면 그 문서는 captioning으로 남고 오류 메시지 없이 기록되며 다른 문서는 처리된다', async () => {
    fakePending(h, { [DOC_A]: { image: 1, table: 0 } });
    await seedCaptioning(DOC_A);
    await seedQueued(DOC_B);
    const spy = jest.spyOn(h.repo, 'updateDocument');
    spy.mockRejectedValueOnce(new Error(FAILMSG_SENT));
    const result = await h.lifecycle.runScheduledIndex();
    expect(result.requeued).toBe(0);
    expect(docOf(h.db, DOC_A).processingState).toBe('captioning');
    expect(requestedDocIds()).toEqual([DOC_B]);
    expect(logLines('documents.task_failed')).toEqual([
      expect.objectContaining({ task: 'scheduled_index', docId: DOC_A }),
    ]);
    expect(capture.lines.join('\n')).not.toContain(FAILMSG_SENT);
  });

  it('T-REQ10-4 남은 captioning 문서가 없으면 requeued는 0이고 다른 단계는 그대로다', async () => {
    await seedQueued(DOC_A);
    const result = await h.lifecycle.runScheduledIndex();
    expect(result).toEqual({ requeued: 0, captioned: 0, requested: 1, unreachable: 0 });
  });
});
