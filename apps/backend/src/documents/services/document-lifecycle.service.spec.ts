import type { ProcessingState } from '../../common';
import {
  DOC_A,
  DOC_B,
  FAILMSG_SENT,
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
import type { DocumentRecord } from '../interfaces/documents.types';

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

/** 문서·버전·기록 호출 수의 스냅샷이다. */
function snapshot() {
  return {
    docs: h.db.dump('documents'),
    versions: h.db.dump('document_versions'),
    records: h.logs.record.mock.calls.length,
  };
}

const START_HINTS = { startAt: 'hints', force: false } as const;

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
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    expect(during).toBe('captioning');
    expect(transitionsOf(DOC_A)[0]).toEqual(['uploaded', 'captioning']);
  });
});

describe('REQ-BE-1.9.3', () => {
  it('T-PROC-2 색인을 요청하기 전에 이미 queued다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    let during: ProcessingState | undefined;
    h.indexing.requestIndex.mockImplementation(async () => {
      during = docOf(h.db, DOC_A).processingState;
      return { kind: 'accepted', jobId: 'job-new' };
    });
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    expect(during).toBe('queued');
    expect(transitionsOf(DOC_A)).toContainEqual(['captioning', 'queued']);
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
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    expect(answers).toEqual([true, false]);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    const stopped = logLines('documents.processing_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].reason).toBe('deleted');
  });

  it('T-PROC-5 표·이미지 처리 직후 삭제되면 색인을 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    h.assets.generateHints.mockImplementation(async () => {
      await patchDoc(DOC_A, { deleted: true });
      return { generated: 1, temporary: 0, stopped: false };
    });
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
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
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('replaced');
  });
});

describe('REQ-BE-1.2.8', () => {
  it('T-PROC-8 표·이미지 처리 직후 교체되었으면 색인을 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'uploaded' });
    h.assets.generateHints.mockImplementation(async () => {
      await patchDoc(DOC_A, { searchState: 'replaced' });
      return { generated: 1, temporary: 0, stopped: false };
    });
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
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
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    await shutdown;
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(logLines('documents.processing_stopped')[0].reason).toBe('shutdown');
    expect(docOf(h.db, DOC_A).processingState).toBe('captioning');
  });
});

describe('REQ-BE-1.1.9', () => {
  it('T-PROC-7 요약·캡션 만들기에 문서의 이름과 판 표기를 넘긴다', async () => {
    await seedDoc({ docId: DOC_A, name: '설계서', edition: ed('v3'), processingState: 'uploaded' });
    await h.lifecycle.processVersion(DOC_A, '1', START_HINTS);
    const ctx = h.assets.generateHints.mock.calls[0][2];
    expect(ctx.name).toBe('설계서');
    expect(ctx.editionLabel).toBe('v3');
  });
});

describe('REQ-BE-1.9.4', () => {
  it('T-IDX-1 accepted면 작업 ID를 버전에 쓰고 처리 상태는 queued 그대로다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'captioning' })],
      [versionRecord({ docId: DOC_A, jobId: null })],
    );
    h.indexing.requestIndex.mockResolvedValue({ kind: 'accepted', jobId: 'job-9' });
    await h.lifecycle.requestIndexFor(DOC_A, '1', false);
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBe('job-9');
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
  });

  it('T-IDX-2 unreachable이면 failed, RAG_UNREACHABLE 사유와 실패 기록이 남는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'captioning' });
    h.indexing.requestIndex.mockResolvedValue({ kind: 'unreachable' });
    await h.lifecycle.requestIndexFor(DOC_A, '1', false);
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
    const failure = versionOf(h.db, DOC_A, '1')?.failure;
    expect(failure).toMatchObject({
      code: 'RAG_UNREACHABLE',
      headingPath: null,
      placeholderId: null,
    });
    expectSafeKoreanMessage(failure?.message ?? '');
    const record = h.logs.recordsOf('processing_state').at(-1);
    expect(record?.outcome).toBe('failure');
    expect(record?.detail?.reasonCode).toBe('RAG_UNREACHABLE');
  });

  it('T-IDX-3 reused면 검색되는 버전의 결과를 이어받아 완료하고 searchableVersion은 그대로다', async () => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          latestVersion: '2',
          searchableVersion: '1',
          processingState: 'captioning',
        }),
      ],
      [
        versionRecord({
          docId: DOC_A,
          version: '1',
          result: { chunkCount: 7, fallbackUsed: false },
        }),
        versionRecord({ docId: DOC_A, version: '2', jobId: null, result: null }),
      ],
    );
    h.indexing.requestIndex.mockResolvedValue({ kind: 'reused', jobId: 'job-r' });
    await h.lifecycle.requestIndexFor(DOC_A, '2', true);
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(v2?.jobId).toBe('job-r');
    expect(v2?.result).toEqual({ chunkCount: 7, fallbackUsed: false });
    expect(docOf(h.db, DOC_A).searchableVersion).toBe('1');
  });

  it('T-IDX-7 요청 중에 running 이벤트로 색인 중이 되면 실패로 덮지 않는다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'captioning' });
    h.indexing.requestIndex.mockImplementation(async () => {
      await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_A, jobState: 'running' }));
      return { kind: 'unreachable' };
    });
    await h.lifecycle.requestIndexFor(DOC_A, '1', false);
    expect(docOf(h.db, DOC_A).processingState).toBe('indexing');
  });
});

describe('REQ-BE-1.9.8', () => {
  it('T-IDX-4 검색 가능 문서의 새 버전이 unreachable이어도 검색 가능은 유지된다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '2', processingState: 'captioning' })],
      [
        versionRecord({ docId: DOC_A, version: '1' }),
        versionRecord({ docId: DOC_A, version: '2', jobId: null, result: null }),
      ],
    );
    h.indexing.requestIndex.mockResolvedValue({ kind: 'unreachable' });
    await h.lifecycle.requestIndexFor(DOC_A, '2', false);
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('failed');
    expect(doc.searchState).toBe('searchable');
  });
});

describe('REQ-BE-3.1.1', () => {
  it('T-IDX-5 색인 요청에 그 버전의 색인용 MD·요약·캡션과 지금의 이름·판·force를 담는다', async () => {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          name: '문서',
          edition: ed('v1', '2025-03-04'),
          processingState: 'captioning',
        }),
      ],
      [versionRecord({ docId: DOC_A, indexingMarkdown: '색인용 본문' })],
    );
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: '요약' }]);
    await h.lifecycle.requestIndexFor(DOC_A, '1', true);
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

describe('REQ-BE-1.8.4', () => {
  it('T-IDX-6 요청 중에 삭제되면 청크 삭제 표시를 쓰고 백그라운드로 지운다', async () => {
    await seedDoc({ docId: DOC_A, processingState: 'captioning' });
    h.indexing.requestIndex.mockImplementation(async () => {
      await patchDoc(DOC_A, { deleted: true });
      return { kind: 'accepted', jobId: 'job-x' };
    });
    await h.lifecycle.requestIndexFor(DOC_A, '1', false);
    expect(docOf(h.db, DOC_A).pendingRag.deleteChunks).toBe(true);
    await h.drain();
    expect(h.indexing.deleteChunks).toHaveBeenCalledWith(DOC_A);
  });
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

  it('T-EVT-4 재시도할 수 있는 실패는 성공 이벤트로 되살아나고 그 밖의 실패는 그대로다', async () => {
    const failure = (code: string) => ({
      code,
      message: 'x',
      headingPath: null,
      placeholderId: null,
    });
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'failed' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'failed' }),
      ],
      [
        versionRecord({ docId: DOC_A, result: null, failure: failure('RAG_UNREACHABLE') }),
        versionRecord({ docId: DOC_B, result: null, failure: failure('PARSE_FAILED') }),
      ],
    );
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId: DOC_A, result: { chunkCount: 4, fallbackUsed: false } }),
    );
    await h.lifecycle.onJobStateChanged(jobEvent({ docId: DOC_B }));
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(versionOf(h.db, DOC_A, '1')?.result).toEqual({ chunkCount: 4, fallbackUsed: false });
    expect(versionOf(h.db, DOC_A, '1')?.failure).toBeNull();
    expect(docOf(h.db, DOC_B).processingState).toBe('failed');
    expect(versionOf(h.db, DOC_B, '1')?.failure?.code).toBe('PARSE_FAILED');
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
    expect(h.indexing.deleteChunks).toHaveBeenCalledWith(DOC_A);
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

/** 버전 레코드의 결과·실패 사유·작업 ID만 뽑는다. */
function recordedOf(docId: string, version = '1') {
  const ver = versionOf(h.db, docId, version);
  return { jobId: ver?.jobId, result: ver?.result, failure: ver?.failure };
}

describe('REQ-BE-1.9.5', () => {
  it('T-EVT-13 같은 버전의 failed 이벤트가 RAG_UNREACHABLE 실패 문서에 오면 상태는 그대로이고 사유만 이벤트 값으로 바뀐다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'failed' })],
      [versionRecord({ docId: DOC_A, result: null, failure: failureOf('RAG_UNREACHABLE') })],
    );
    await h.lifecycle.onJobStateChanged(
      jobEvent({
        docId: DOC_A,
        jobState: 'failed',
        searchableVersion: null,
        result: null,
        failure: failureOf('PARSE_FAILED', FAILMSG_SENT, ['H'], 't1'),
      }),
    );
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(
      failureOf('PARSE_FAILED', FAILMSG_SENT, ['H'], 't1'),
    );
    // ★ 처리 상태가 그대로이므로 상태 변경 기록은 새로 생기지 않는다
    expect(h.logs.recordsOf('processing_state')).toHaveLength(0);
  });

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

  it('T-EVT-19 failed* 문서의 성공 이벤트 반영이 어긋나 포기하면 result·failure가 처음과 같다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'failed', searchState: 'not_searchable' })],
      [versionRecord({ docId: DOC_A, result: null, failure: failureOf('RAG_UNREACHABLE') })],
    );
    const before = recordedOf(DOC_A);
    jest.spyOn(h.repo, 'updateDocument').mockResolvedValue(false);
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId: DOC_A, result: { chunkCount: 4, fallbackUsed: false } }),
    );
    expect(recordedOf(DOC_A)).toEqual(before);
    expect(before.failure).toEqual(failureOf('RAG_UNREACHABLE'));
    expect(before.result).toBeNull();
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
  });
});

describe('REQ-BE-1.9.4', () => {
  it('T-TRN-1 transition의 갱신이 어긋나면 쓰기 전 사유로 되돌린다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued' })],
      [versionRecord({ docId: DOC_A, result: null, failure: failureOf('OLD') })],
    );
    jest.spyOn(h.repo, 'updateDocument').mockResolvedValueOnce(false);
    const ok = await h.lifecycle.transition(
      DOC_A,
      '1',
      ['queued'],
      'failed',
      failureOf('RAG_UNREACHABLE'),
    );
    expect(ok).toBe(false);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(failureOf('OLD'));
  });

  it('T-TRN-2 transition이 어긋났을 때 먼저 성공한 쪽이 쓴 사유는 보존한다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued' })],
      [versionRecord({ docId: DOC_A, result: null, failure: null })],
    );
    const winner = failureOf('PARSE_FAILED', '먼저 성공한 쪽');
    jest.spyOn(h.repo, 'updateDocument').mockImplementationOnce(async () => {
      await patchVersion(DOC_A, '1', { failure: winner });
      await patchDoc(DOC_A, { processingState: 'failed' });
      return false;
    });
    const ok = await h.lifecycle.transition(
      DOC_A,
      '1',
      ['queued'],
      'failed',
      failureOf('RAG_UNREACHABLE'),
    );
    expect(ok).toBe(false);
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(winner);
    expect(docOf(h.db, DOC_A).processingState).toBe('failed');
  });

  /** 첫 updateDocument(captioning→queued)는 그대로 두고 그다음부터 어긋나게 한다. */
  function failAfterFirstUpdate(onSecond?: () => Promise<void>) {
    const real = h.repo.updateDocument.bind(h.repo);
    let n = 0;
    jest.spyOn(h.repo, 'updateDocument').mockImplementation(async (filter, set) => {
      n += 1;
      if (n === 1) return real(filter, set);
      if (n === 2) await onSecond?.();
      return false;
    });
  }

  async function seedReused() {
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          latestVersion: '2',
          searchableVersion: '1',
          processingState: 'captioning',
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
          jobId: 'job-old',
          result: null,
          failure: failureOf('OLD'),
        }),
      ],
    );
    h.indexing.requestIndex.mockResolvedValue({ kind: 'reused', jobId: 'job-r' });
  }

  it('T-TRN-3 reused 반영 뒤 completed 전이가 어긋나면 jobId·result·failure가 처음과 같다', async () => {
    await seedReused();
    const before = recordedOf(DOC_A, '2');
    failAfterFirstUpdate();
    await h.lifecycle.requestIndexFor(DOC_A, '2', true);
    expect(recordedOf(DOC_A, '2')).toEqual(before);
    expect(before).toEqual({ jobId: 'job-old', result: null, failure: failureOf('OLD') });
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
  });

  it('T-TRN-4 reused 반영 뒤 먼저 성공한 쪽이 쓴 결과가 있으면 되돌리기가 보존한다', async () => {
    await seedReused();
    const winner = { chunkCount: 99, fallbackUsed: true };
    failAfterFirstUpdate(async () => {
      await patchVersion(DOC_A, '2', { jobId: 'job-win', result: winner, failure: null });
    });
    await h.lifecycle.requestIndexFor(DOC_A, '2', true);
    expect(recordedOf(DOC_A, '2')).toEqual({ jobId: 'job-win', result: winner, failure: null });
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
    await expect(h.lifecycle.recheckAfterVersionWrite(DOC_A)).resolves.toBeUndefined();
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
    h.lifecycle.startProcessing(DOC_A, '1', START_HINTS);
    h.lifecycle.startProcessing(DOC_A, '1', START_HINTS);
    await waitUntil(() => h.assets.generateHints.mock.calls.length >= 1);
    await tick();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(captioningRecords(DOC_A)).toBe(1);

    gate.resolve({ generated: 0, temporary: 0, stopped: false });
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);

    // 키가 풀린 뒤에는 처리가 시작되지만 처리 상태가 이미 captioning이 아니라 전이에서 멈춘다
    h.lifecycle.startProcessing(DOC_A, '1', START_HINTS);
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    expect(captioningRecords(DOC_A)).toBe(1);
    expect(logLines('documents.processing_stopped')).toHaveLength(1);
  });
});

describe('REQ-BE-1.9.10', () => {
  /** 테스트가 중간에 실패해도 멈춘 요청을 풀어 afterEach의 drain이 끝나게 한다. */
  let release: (() => void) | null = null;
  afterEach(() => {
    release?.();
    release = null;
  });

  /** 색인 대기 문서를 시드한다. 작업 ID는 기본이 없음(null)이다. */
  async function seedQueued(jobId: string | null): Promise<void> {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued' })],
      [versionRecord({ docId: DOC_A, jobId })],
    );
  }

  it('T-PR3-DUP-2a 같은 버전의 색인 요청이 진행 중이면 요청하지 않고 거짓을 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'captioning' })],
      [versionRecord({ docId: DOC_A, jobId: null })],
    );
    const gate = deferred<{ kind: 'accepted'; jobId: string }>();
    release = () => gate.resolve({ kind: 'accepted', jobId: 'job-late' });
    h.indexing.requestIndex.mockImplementation(() => gate.promise);
    h.lifecycle.startProcessing(DOC_A, '1', { startAt: 'index', force: false });
    await waitUntil(() => h.indexing.requestIndex.mock.calls.length === 1);
    expect(await h.lifecycle.requestIndexIfIdle(DOC_A, '1', false)).toBe(false);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    gate.resolve({ kind: 'accepted', jobId: 'job-late' });
    await h.drain();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-PR3-DUP-2b 버전에 작업 ID가 이미 있으면 요청하지 않고 거짓을 준다', async () => {
    await seedQueued('job-1');
    expect(await h.lifecycle.requestIndexIfIdle(DOC_A, '1', false)).toBe(false);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-PR3-DUP-2c 작업 ID 없는 색인 대기면 요청하고 참을 준다', async () => {
    await seedQueued(null);
    expect(await h.lifecycle.requestIndexIfIdle(DOC_A, '1', true)).toBe(true);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex.mock.calls[0][0]).toMatchObject({
      docId: DOC_A,
      version: '1',
      force: true,
    });
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBe('job-new');
  });

  it('T-PR3-DUP-2d 문서가 그 버전의 queued가 아니면 요청하지 않는다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'completed' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'queued', latestVersion: '2' }),
      ],
      [
        versionRecord({ docId: DOC_A, jobId: null }),
        versionRecord({ docId: DOC_B, version: '1', jobId: null }),
        versionRecord({ docId: DOC_B, version: '2', jobId: null }),
      ],
    );
    expect(await h.lifecycle.requestIndexIfIdle(DOC_A, '1', false)).toBe(false);
    // ★ 확인하는 버전(1)이 마지막 버전(2)이 아니다
    expect(await h.lifecycle.requestIndexIfIdle(DOC_B, '1', false)).toBe(false);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  /** 재색인이 v2를 선점해 queued로 쓴 상태를 시드한다(v2는 작업 ID가 없다). */
  async function seedReindexClaim(): Promise<void> {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', latestVersion: '2' })],
      [
        versionRecord({ docId: DOC_A, version: '1', jobId: 'job-1' }),
        versionRecord({ docId: DOC_A, version: '2', jobId: null }),
      ],
    );
  }

  /** 다음 한 번의 조회를 gate가 풀릴 때까지 멈춘다. 조회에 닿으면 reached가 풀린다. */
  function holdNext(method: 'findDocument' | 'findVersion') {
    const reached = deferred<void>();
    const gate = deferred<void>();
    release = () => gate.resolve();
    const original = h.repo[method].bind(h.repo) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(h.repo, method).mockImplementationOnce((async (...args: unknown[]) => {
      reached.resolve();
      await gate.promise;
      return original(...args);
    }) as never);
    return { reached: reached.promise, open: () => gate.resolve() };
  }

  it('T-PR3-IDLE-1 확인이 문서를 읽기 전에 재색인이 captioning으로 바꾸면 미뤄 둔 표·이미지 처리를 잇는다', async () => {
    await seedReindexClaim();
    const hold = holdNext('findDocument');
    const checking = h.lifecycle.requestIndexIfIdle(DOC_A, '2', true);
    await hold.reached;
    // ★ 재색인이 임시 설명을 찾아 captioning으로 바꾸고 처리를 시작한다
    await patchDoc(DOC_A, { processingState: 'captioning' });
    h.lifecycle.startProcessing(DOC_A, '2', { startAt: 'hints', force: true });
    hold.open();
    expect(await checking).toBe(false);
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex.mock.calls[0][0]).toMatchObject({ version: '2', force: true });
    expect(docOf(h.db, DOC_A)?.processingState).toBe('queued');
    expect(versionOf(h.db, DOC_A, '2')?.jobId).toBe('job-new');
  });

  it('T-PR3-IDLE-2 확인이 문서를 읽은 뒤 재색인이 captioning으로 바꾸면 확인은 색인하지 않고 표·이미지 처리부터 잇는다', async () => {
    await seedReindexClaim();
    const hold = holdNext('findVersion');
    const checking = h.lifecycle.requestIndexIfIdle(DOC_A, '2', true);
    await hold.reached;
    await patchDoc(DOC_A, { processingState: 'captioning' });
    h.lifecycle.startProcessing(DOC_A, '2', { startAt: 'hints', force: true });
    hold.open();
    expect(await checking).toBe(false);
    await h.drain();
    // ★ 색인 요청은 표·이미지 처리를 마친 뒤 한 번만 나간다
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
    expect(h.assets.generateHints.mock.invocationCallOrder[0]).toBeLessThan(
      h.indexing.requestIndex.mock.invocationCallOrder[0],
    );
    expect(docOf(h.db, DOC_A)?.processingState).toBe('queued');
  });

  it('T-PR3-IDLE-3 확인이 색인을 요청했으면 그사이 들어온 색인부터의 시작은 버린다', async () => {
    await seedReindexClaim();
    const hold = holdNext('findVersion');
    const checking = h.lifecycle.requestIndexIfIdle(DOC_A, '2', true);
    await hold.reached;
    h.lifecycle.startProcessing(DOC_A, '2', { startAt: 'index', force: true });
    hold.open();
    expect(await checking).toBe(true);
    await h.drain();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-PR3-IDLE-4 확인이 상태를 바꾼 뒤 재색인이 captioning으로 바꾸면 표·이미지 처리 뒤 색인을 다시 요청한다', async () => {
    await seedReindexClaim();
    // ★ 확인의 상태 전이(queued→queued) 뒤, 색인 요청 전(hintsFor)에서 멈춘다
    const reached = deferred<void>();
    const gate = deferred<void>();
    release = () => gate.resolve();
    h.assets.hintsFor.mockImplementationOnce(async () => {
      reached.resolve();
      await gate.promise;
      return [];
    });
    h.indexing.requestIndex
      .mockResolvedValueOnce({ kind: 'accepted', jobId: 'job-first' })
      .mockResolvedValueOnce({ kind: 'accepted', jobId: 'job-second' });
    const checking = h.lifecycle.requestIndexIfIdle(DOC_A, '2', true);
    await reached.promise;
    await patchDoc(DOC_A, { processingState: 'captioning' });
    h.lifecycle.startProcessing(DOC_A, '2', { startAt: 'hints', force: true });
    gate.resolve();
    expect(await checking).toBe(true);
    await h.drain();
    expect(h.assets.generateHints).toHaveBeenCalledTimes(1);
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(2);
    expect(h.assets.generateHints.mock.invocationCallOrder[0]).toBeLessThan(
      h.indexing.requestIndex.mock.invocationCallOrder[1],
    );
    expect(docOf(h.db, DOC_A)?.processingState).toBe('queued');
    expect(versionOf(h.db, DOC_A, '2')?.jobId).toBe('job-second');
  });
});
