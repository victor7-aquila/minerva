import type { ProcessingState } from '../../common';
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
  deferred,
  expectSafeKoreanMessage,
  docOf,
  docRecord,
  ed,
  jobEvent,
  seed,
  seedDoc as seedDocIn,
  uid,
  versionOf,
  versionRecord,
  waitUntil,
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

describe('REQ-BE-1.9.2', () => {
  it('T-PROC-1 표·이미지 처리를 시작하기 전에 이미 captioning이다', async () => {
    await seedDoc({
      docId: DOC_A,
      processingState: 'uploaded',
      searchState: 'not_searchable',
      searchableVersion: null,
    });
    let during: ProcessingState | undefined;
    h.assets.generateHints.mockImplementation(async () => {
      during = docOf(h.db, DOC_A).processingState;
      return { generated: 0, temporary: 0, stopped: false };
    });
    await h.lifecycle.processVersion(DOC_A, '1');
    expect(during).toBe('captioning');
    expect(transitionsOf(DOC_A)[0]).toEqual(['uploaded', 'captioning']);
  });
});

describe('REQ-BE-1.9.3', () => {
  it('T-Q-READY-1 표·이미지 처리가 끝나면 색인 대기가 되어 대기열에 들어가고 색인은 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    await h.lifecycle.processVersion(DOC_A, '1');
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
    // ★ 색인 요청은 예약 색인만 한다
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(transitionsOf(DOC_A)).toEqual([
      ['uploaded', 'captioning'],
      ['captioning', 'queued'],
    ]);
  });
});

describe('REQ-BE-1.8.3', () => {
  it('T-PROC-3 처리 중 삭제되면 다음 확인에서 멈추고 색인을 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    const answers: boolean[] = [];
    h.assets.generateHints.mockImplementation(async (_docId, _version, ctx) => {
      answers.push(await ctx.shouldContinue());
      await patchDoc(DOC_A, { deleted: true });
      answers.push(await ctx.shouldContinue());
      return { generated: 0, temporary: 0, stopped: !answers[1] };
    });
    await h.lifecycle.processVersion(DOC_A, '1');
    expect(answers).toEqual([true, false]);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
    const stopped = logLines('documents.processing_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].reason).toBe('deleted');
  });

  it('T-PROC-5 표·이미지 처리 직후 삭제되면 대기열에 넣지 않고 색인을 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    h.assets.generateHints.mockImplementation(async () => {
      await patchDoc(DOC_A, { deleted: true });
      return { generated: 1, temporary: 0, stopped: false };
    });
    await h.lifecycle.processVersion(DOC_A, '1');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('deleted');
  });
});

describe('REQ-BE-1.2.8', () => {
  it('T-PROC-4 처리 중 교체되면 이유가 replaced다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    h.assets.generateHints.mockImplementation(async (_docId, _version, ctx) => {
      await patchDoc(DOC_A, { searchState: 'replaced' });
      const go = await ctx.shouldContinue();
      return { generated: 0, temporary: 0, stopped: !go };
    });
    await h.lifecycle.processVersion(DOC_A, '1');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('replaced');
  });
});

describe('REQ-BE-1.2.8', () => {
  it('T-PROC-8 표·이미지 처리 직후 교체되었으면 대기열에 넣지 않고 색인을 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    h.assets.generateHints.mockImplementation(async () => {
      await patchDoc(DOC_A, { searchState: 'replaced' });
      return { generated: 1, temporary: 0, stopped: false };
    });
    await h.lifecycle.processVersion(DOC_A, '1');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
  });
});

describe('REQ-BE-1.9.9', () => {
  it('T-PROC-6 종료 중에는 계속하지 않고 처리 상태를 그대로 둔다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    let shutdown: Promise<void> | undefined;
    h.assets.generateHints.mockImplementation(async (_docId, _version, ctx) => {
      shutdown = h.tasks.beforeApplicationShutdown();
      const go = await ctx.shouldContinue();
      return { generated: 0, temporary: 0, stopped: !go };
    });
    await h.lifecycle.processVersion(DOC_A, '1');
    await shutdown;
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('shutdown');
    expect(docOf(h.db, DOC_A).processingState).toBe('captioning');
  });
});

describe('REQ-BE-1.1.9', () => {
  it('T-PROC-7 요약·캡션 만들기에 문서의 이름과 판 표기를 넘긴다', async () => {
    await seedDoc({ docId: DOC_A, name: '설계서', edition: ed('v3'), processingState: 'uploaded' });
    await h.lifecycle.processVersion(DOC_A, '1');
    const ctx = h.assets.generateHints.mock.calls[0][2];
    expect(ctx.name).toBe('설계서');
    expect(ctx.editionLabel).toBe('v3');
  });
});

describe('REQ-BE-1.10.2', () => {
  it('T-Q-READY-2 색인 준비 갱신 하나가 처리 상태와 대기열을 함께 쓴다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    const spy = jest.spyOn(h.repo, 'updateDocument');
    await h.lifecycle.processVersion(DOC_A, '1');
    // ★ 처리 상태를 queued로 쓰는 갱신은 하나뿐이고, 그 갱신이 대기열도 함께 쓴다
    const toQueued = spy.mock.calls.filter(([, set]) => set.processingState === 'queued');
    expect(toQueued).toHaveLength(1);
    expect(toQueued[0][1]).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    // 대기열에 넣는 갱신도 그 하나뿐이다 (대기열만 쓰는 갱신이 따로 없다)
    expect(spy.mock.calls.filter(([, set]) => 'queuedVersion' in set)).toHaveLength(1);
  });

  it.each([
    ['처리 상태가 바뀌면', { processingState: 'indexing' }, { processingState: 'indexing' }],
    [
      '새 버전이 생기면',
      { latestVersion: '2' },
      { processingState: 'captioning', latestVersion: '2' },
    ],
  ] as const)(
    'T-Q-READY-2 그 사이 %s 갱신이 어긋나 처리 상태와 대기열이 둘 다 그대로다',
    async (_label, patch, expected) => {
      await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
      const real = h.repo.updateDocument.bind(h.repo);
      // ★ 읽은 뒤 쓰기 전에 다른 요청이 끼어든 것을 흉내 낸다
      jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
        if (set.queuedVersion === '1') await patchDoc(DOC_A, { ...patch });
        return real(filter, set);
      });
      await h.lifecycle.processVersion(DOC_A, '1');
      const doc = docOf(h.db, DOC_A);
      expect(doc).toMatchObject(expected);
      expect(doc.queuedVersion).toBeNull();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );
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
    expect(result).toEqual({ requested: 3, unreachable: 0 });
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
    expect(result).toEqual({ requested: 0, unreachable: 0 });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-SCH-3 선점 중인 문서는 건너뛰고 대기열에 남으며 선점이 끝나면 다음 일정에서 요청한다', async () => {
    await seedQueued(DOC_A);
    h.lifecycle.beginClaim(DOC_A, '2');
    try {
      const result = await h.lifecycle.runScheduledIndex();
      expect(result).toEqual({ requested: 0, unreachable: 0 });
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
      expect(result).toEqual({ requested: 0, unreachable: 0 });
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
    expect(result).toEqual({ requested: 1, unreachable: 0 });
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

  it('T-SCH-6 documents.index_scheduled 로그가 requested·unreachable 수만 담는다', async () => {
    await seedQueued(DOC_A);
    await seedQueued(DOC_B);
    h.indexing.requestIndex.mockImplementation(async (input) =>
      input.docId === DOC_A ? { kind: 'accepted', jobId: 'job-a' } : { kind: 'unreachable' },
    );
    await h.scheduler.runScheduledIndex();
    const lines = logLines('documents.index_scheduled');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ requested: 2, unreachable: 1 });
    // ★ 필드는 requested·unreachable뿐이다 (pino 기본 필드는 뺀다)
    const keys = Object.keys(lines[0])
      .filter((key) => !PINO_BASE_KEYS.includes(key))
      .sort();
    expect(keys).toEqual(['requested', 'unreachable']);
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
    expect(result).toEqual({ requested: 1, unreachable: 1 });
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
    expect(result).toEqual({ requested: 0, unreachable: 0 });
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
  /** 멈춘 표·이미지 처리의 결과 타입이다. */
  type HintResult = { generated: number; temporary: number; stopped: boolean };

  /** 테스트가 중간에 실패해도 멈춘 처리를 풀어 afterEach의 drain이 끝나게 한다. */
  let release: (() => void) | null = null;
  afterEach(() => {
    release?.();
    release = null;
  });

  /** captioning 전이 기록(uploaded → captioning)의 수를 센다. */
  function captioningRecords(docId: string): number {
    return transitionsOf(docId).filter(([, to]) => to === 'captioning').length;
  }

  it('T-PR3-DUP-1 같은 버전의 처리가 겹쳐 시작돼도 한 번만 돈다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    const gate = deferred<HintResult>();
    release = () => gate.resolve({ generated: 0, temporary: 0, stopped: false });
    h.assets.generateHints.mockImplementation(() => gate.promise);
    // ★ 호출 즉시 키를 잡으므로 둘째 호출은 작업이 시작되기 전이라도 건너뛴다
    h.lifecycle.startProcessing(DOC_A, '1');
    h.lifecycle.startProcessing(DOC_A, '1');
    await waitUntil(() => h.assets.generateHints.mock.calls.length >= 1);
    await tick();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(captioningRecords(DOC_A)).toBe(1);

    gate.resolve({ generated: 0, temporary: 0, stopped: false });
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    // ★ 처리가 끝나면 대기열에 들어가고 색인은 요청하지 않는다
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');

    // 키가 풀린 뒤에는 처리가 시작되지만 처리 상태가 이미 captioning이 아니라 전이에서 멈춘다
    h.lifecycle.startProcessing(DOC_A, '1');
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(captioningRecords(DOC_A)).toBe(1);
    expect(logLines('documents.processing_stopped')).toHaveLength(1);
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
    expect(result).toEqual({ requested: 0, unreachable: 0 });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});
