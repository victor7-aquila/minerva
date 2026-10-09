import {
  DocumentLockedError,
  DocumentNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
  RagUnavailableError,
  UnsupportedFileError,
} from '../../common';
import type { PreparedVersion } from '../../assets';
import type { ProcessingState, SearchState } from '../../common';
import type { IndexRequestOutcome } from '../../indexing';
import { RagRequestError } from '../../rag';
import type { RagDocumentChunk, RagJobStage } from '../../rag';
import {
  DATE_SENT,
  DOC_A,
  DOC_B,
  DOC_C,
  DOC_D,
  FAILMSG_SENT,
  FILE_SENT,
  HINT_SENT,
  IDX_SENT,
  LABEL_SENT,
  MD_SENT,
  NAME_SENT,
  buildDocumentsTestModule,
  createFakeClock,
  deferred,
  expectSafeKoreanMessage,
  docOf,
  docRecord,
  jobEvent,
  seed,
  seedDoc as seedDocIn,
  tableView,
  uid,
  ed,
  uploadFile,
  versionOf,
  versionRecord,
  waitUntil,
} from '../../../test/support/documents-fixtures';
import type {
  DocumentsHarness,
  DocumentsTestOptions,
} from '../../../test/support/documents-fixtures';
import type { FakeCollection } from '../../../test/support/fake-mongo';
import { createLogCapture } from '../../../test/support/log-capture';
import {
  DOC_ID_PATTERN,
  DocumentNamesQueryDto,
  EditDocumentDto,
  ListDocumentsQueryDto,
  ReplacementCheckQueryDto,
} from '../interfaces/documents.dto';
import type { DocumentRecord, DocumentVersionRecord } from '../interfaces/documents.types';

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

/** 목록 쿼리 객체를 만든다. */
function listQuery(over: Partial<ListDocumentsQueryDto> = {}): ListDocumentsQueryDto {
  return Object.assign(new ListDocumentsQueryDto(), over);
}

/** 편집 본문을 만든다. */
function editBody(over: Partial<EditDocumentDto>): EditDocumentDto {
  return Object.assign(new EditDocumentDto(), over);
}

/** 문서 한 개를 시드한다. */
function seedDoc(over: Partial<DocumentRecord> = {}): Promise<DocumentRecord> {
  return seedDocIn(h.db, over);
}

/** 한 문서에 대해 불린 기록 입력을 순서대로 요약한다. */
function recordsFor(docId: string) {
  return h.logs.record.mock.calls
    .map((call) => call[0])
    .filter((input) => input.docId === docId)
    .map((input) => ({
      kind: input.kind,
      name: input.name,
      editionLabel: input.editionLabel,
      outcome: input.outcome,
      detail: input.detail ?? null,
    }));
}

/** 처리 상태 기록의 (전, 후) 쌍을 모은다. */
function transitionsOf(docId: string): Array<[string | undefined, string | undefined]> {
  return h.logs
    .recordsOf('processing_state')
    .filter((input) => input.docId === docId)
    .map((input) => [input.detail?.fromState, input.detail?.toState]);
}

/** Db 호출 중 find 횟수다. */
function findCalls(): number {
  return h.db.calls.filter((call) => call.op === 'find').length;
}

/** 끝나지 않는 Promise와 그것을 풀거나 거부시키는 손잡이다. */
interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** prepareVersion이 돌려줄 값이다. */
const PREPARED: PreparedVersion = {
  indexingMarkdown: IDX_SENT,
  unmatchedImages: [],
  assetCount: 0,
};

/**
 * 내용 다시 올리기를 prepareVersion에서 멈춘 채 시작한다.
 * ★ 이 순간 선점(latestVersion 2, 처리 상태 uploaded)은 끝났고 버전 2 레코드는 아직 없다.
 * 결과 Promise는 거부돼도 처리되지 않은 거부가 되지 않게 곧바로 값으로 바꾼다
 */
async function holdUpload(): Promise<{ gate: Gate<PreparedVersion>; outcome: Promise<unknown> }> {
  const gate = deferred<PreparedVersion>();
  h.assets.prepareVersion.mockImplementationOnce(() => gate.promise);
  const outcome = h.service.uploadContents(DOC_A, [uploadFile('new.md', '# 새 내용')]).then(
    () => 'resolved' as unknown,
    (error: unknown) => error,
  );
  await waitUntil(() => h.assets.prepareVersion.mock.calls.length > 0);
  return { gate, outcome };
}

/**
 * 완료 문서에 내용 다시 올리기를 시작하고 prepareVersion에서 멈춘다. 그동안 교체돼 처리 실패로 바뀐다.
 * ★ replaceOne이 남기는 상태(replaced·failed)다. 호출자가 gate를 거부시킨다
 */
async function holdReplacedUpload(): Promise<{
  gate: Gate<PreparedVersion>;
  outcome: Promise<unknown>;
}> {
  await seedDoc({ docId: DOC_A });
  const held = await holdUpload();
  expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
  await h.db
    .collection('documents')
    .updateOne({ docId: DOC_A }, { $set: { searchState: 'replaced', processingState: 'failed' } });
  return held;
}

/** 재색인을 inheritVersion에서 멈춘 채 시작한다. holdUpload와 같은 순간이다. */
async function holdReindex(): Promise<{ gate: Gate<void>; outcome: Promise<unknown> }> {
  const gate = deferred<void>();
  h.assets.inheritVersion.mockImplementationOnce(() => gate.promise);
  const outcome = h.service.reindex(DOC_A).then(
    () => 'resolved' as unknown,
    (error: unknown) => error,
  );
  await waitUntil(() => h.assets.inheritVersion.mock.calls.length > 0);
  return { gate, outcome };
}

/**
 * 요약·캡션 편집(edit)을 inheritVersion에서 멈춘 채 시작한다. holdUpload와 같은 순간이다.
 * ★ 호출 전에 seedDoc과 listViews 모의(t1이 있는 상태)가 준비돼 있어야 한다
 */
async function holdEdit(): Promise<{ gate: Gate<void>; outcome: Promise<unknown> }> {
  const gate = deferred<void>();
  h.assets.inheritVersion.mockImplementationOnce(() => gate.promise);
  const outcome = h.service
    .edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }))
    .then(
      () => 'resolved' as unknown,
      (error: unknown) => error,
    );
  await waitUntil(() => h.assets.inheritVersion.mock.calls.length > 0);
  return { gate, outcome };
}

/** 선점 뒤 멈추는 새 버전 요청 경로의 이름이다. */
type ClaimPath = 'upload' | 'edit' | 'reindex';

/**
 * 완료 문서에 새 버전 요청(경로별)을 시작해 선점 뒤 새 버전을 쓰기 전에 멈춘다.
 * ★ 호출 전에 문서를 시드해 둔다. release로 풀면 요청이 이어진다
 */
async function holdClaimPath(
  path: ClaimPath,
): Promise<{ release: () => void; outcome: Promise<unknown> }> {
  if (path === 'upload') {
    const held = await holdUpload();
    return { release: () => held.gate.resolve(PREPARED), outcome: held.outcome };
  }
  if (path === 'edit') {
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    const held = await holdEdit();
    return { release: () => held.gate.resolve(), outcome: held.outcome };
  }
  const held = await holdReindex();
  return { release: () => held.gate.resolve(), outcome: held.outcome };
}

/** 기록 입력 중 이 종류의 개수다. */
function recordCount(docId: string, kind: string): number {
  return recordsFor(docId).filter((record) => record.kind === kind).length;
}

/** 예약 색인을 한 번 돌리고 백그라운드 작업을 기다린다. */
async function runScheduled(): Promise<{ requested: number; unreachable: number }> {
  const result = await h.lifecycle.runScheduledIndex();
  await h.drain();
  return result;
}

/** 그 문서에 대해 불린 색인 요청 입력을 순서대로 모은다. */
function requestsOf(docId: string) {
  return h.indexing.requestIndex.mock.calls
    .map((call) => call[0])
    .filter((input) => input.docId === docId);
}

/** 가짜 컬렉션의 updateOne 인자다. */
type UpdateArgs = Parameters<FakeCollection['updateOne']>;

/** 감시한 updateOne 호출 하나다. */
interface UpdateCall {
  collection: 'documents' | 'document_versions';
  filter: UpdateArgs[0];
  update: UpdateArgs[1];
}

/** 감시 훅이다. raw는 감시하지 않는 원래 updateOne이다(훅 안에서 Db를 직접 바꿀 때 쓴다). */
interface UpdateHooks {
  before?: (call: UpdateCall, n: number, raw: RawUpdate) => Promise<void>;
  after?: (call: UpdateCall, n: number, raw: RawUpdate) => Promise<void>;
}

/** 이름으로 고르는 원래 updateOne이다. */
type RawUpdate = (
  collection: 'documents' | 'document_versions',
  filter: UpdateArgs[0],
  update: UpdateArgs[1],
) => ReturnType<FakeCollection['updateOne']>;

/**
 * documents·document_versions의 updateOne을 감싸 호출 순서와 인자를 모은다. 원래 동작은 그대로 한다.
 * ★ 호출 번호 n은 두 컬렉션을 합쳐 1부터다. before에서 던지면 그 갱신은 일어나지 않는다
 */
function watchUpdates(hooks: UpdateHooks = {}): UpdateCall[] {
  const calls: UpdateCall[] = [];
  const names = ['documents', 'document_versions'] as const;
  const originals = new Map<string, FakeCollection['updateOne']>();
  for (const name of names) {
    const collection = h.db.collection(name);
    originals.set(name, collection.updateOne.bind(collection));
  }
  const raw: RawUpdate = (name, filter, update) => {
    const original = originals.get(name);
    if (original === undefined) throw new Error('원래 updateOne 없음');
    return original(filter, update);
  };
  for (const name of names) {
    jest.spyOn(h.db.collection(name), 'updateOne').mockImplementation(async (filter, update) => {
      const call: UpdateCall = { collection: name, filter, update };
      calls.push(call);
      const n = calls.length;
      await hooks.before?.(call, n, raw);
      const result = await raw(name, filter, update);
      await hooks.after?.(call, n, raw);
      return result;
    });
  }
  return calls;
}

/** 실패 문서 시드에 쓰는 실패 사유다. */
const FAILURE = {
  code: 'PARSE_FAILED',
  message: FAILMSG_SENT,
  headingPath: null,
  placeholderId: null,
};

/**
 * 실패 문서 하나를 시드한다. 버전 1에 작업 ID(job-old)와 실패 사유가 있다.
 * ★ 마지막 버전의 결과는 없다(result null)
 */
async function seedFailed(
  docOver: Partial<DocumentRecord> = {},
  versionOver: Partial<DocumentVersionRecord> = {},
): Promise<void> {
  await seed(
    h.db,
    [docRecord({ docId: DOC_A, processingState: 'failed', queuedVersion: null, ...docOver })],
    [
      versionRecord({
        docId: docOver.docId ?? DOC_A,
        jobId: 'job-old',
        result: null,
        failure: FAILURE,
        ...versionOver,
      }),
    ],
  );
}

/** 멈춘 동안 문서를 삭제하고 데이터 삭제(purge)까지 끝낸다. */
async function removeAndPurge(): Promise<void> {
  await h.service.remove(DOC_A);
  await h.drain();
  expect(docOf(h.db, DOC_A).purged).toBe(true);
  expect(h.assets.deleteDocument).toHaveBeenCalledTimes(1);
}

/**
 * 임시 설명이 있는 재색인에서 새 버전을 쓴 뒤 다시 읽은 결과만 삭제됨·교체됨으로 두고, 기록·처리 시작이 없는지 본다.
 * ★ 문서는 그대로 두어 captioning 조건부 갱신이 성공할 상태다 — 다시 읽은 결과만으로 멈추는지 본다
 */
async function expectReindexStopsOn(lost: 'deleted' | 'replaced'): Promise<void> {
  await seedDoc({ docId: DOC_A });
  h.assets.markTemporaryForRegeneration.mockResolvedValue(1);
  const started = jest.spyOn(h.lifecycle, 'startProcessing');
  jest.spyOn(h.lifecycle, 'recheckAfterVersionWrite').mockResolvedValue(lost);
  await h.service.reindex(DOC_A);
  await h.drain();
  expect(transitionsOf(DOC_A)).toEqual([]);
  expect(started).not.toHaveBeenCalled();
  expect(docOf(h.db, DOC_A).processingState).toBe('queued');
  // ★ captioning 갱신(대기열 비우기 포함)을 하지 않았으므로 선점 때 넣은 대기열이 그대로다
  expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
  expect(h.assets.generateHints).not.toHaveBeenCalled();
  expect(h.indexing.requestIndex).not.toHaveBeenCalled();
}

/** 그 문서의 버전 레코드 개수다. */
function versionRows(docId: string): number {
  return h.db.dump('document_versions').filter((v) => v.docId === docId).length;
}

/** 코드 포인트 순 비교다. ★ 소스의 구현을 쓰지 않고 이 파일에서 따로 만든 독립 비교다 */
function cmpPoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** 동점 규칙이다. 수정 시각 늦은 순, 같으면 문서 ID 오름차순이며 정렬 방향과 무관하다. */
function tieBreak(a: DocumentRecord, b: DocumentRecord): number {
  return b.updatedAt.getTime() - a.updatedAt.getTime() || cmpPoints(a.docId, b.docId);
}

/** 값 열(상태) 정렬의 기대 문서 ID 순서다. 값 순서대로 묶고 묶음 안은 동점 규칙이다. */
function expectedByBucket(
  docs: readonly DocumentRecord[],
  valueOf: (doc: DocumentRecord) => string,
  valueOrder: readonly string[],
): string[] {
  return valueOrder.flatMap((value) =>
    docs
      .filter((doc) => valueOf(doc) === value)
      .sort(tieBreak)
      .map((doc) => doc.docId),
  );
}

/** 이 값 구성으로 문서들을 만든다. 수정 시각은 문서마다 달라 묶음 안 순서가 정해진다. */
function bucketDocs(
  counts: ReadonlyArray<readonly [string, number]>,
  over: (value: string) => Partial<DocumentRecord>,
): DocumentRecord[] {
  const base = Date.UTC(2026, 9, 1);
  const docs: DocumentRecord[] = [];
  let seq = 0;
  for (const [value, count] of counts) {
    for (let k = 0; k < count; k += 1) {
      seq += 1;
      docs.push(
        docRecord({
          docId: uid(seq),
          name: `d${seq}`,
          updatedAt: new Date(base + ((seq * 13) % 97) * 60000),
          ...over(value),
        }),
      );
    }
  }
  return docs;
}

describe('REQ-BE-1.1.1', () => {
  it('T-UP-1 MD 둘과 이미지 하나로 문서 둘을 만들고 응답 항목은 네 키뿐이다', async () => {
    const png = Buffer.from([1, 2, 3]);
    const result = await h.service.upload(
      [uploadFile('a.md', '# A'), uploadFile('b.md', '# B'), uploadFile('p.png', png, 'image/png')],
      [
        { file_name: 'a.md', name: 'A문서' },
        { file_name: 'b.md', name: 'B문서' },
      ],
    );
    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((doc) => doc.file_name)).toEqual(['a.md', 'b.md']);
    for (const item of result.documents) {
      expect(Object.keys(item).sort()).toEqual(['doc_id', 'file_name', 'name', 'unmatched_images']);
      expect(item.doc_id).toMatch(DOC_ID_PATTERN);
    }
    expect(h.db.dump('documents')).toHaveLength(2);
    const versions = h.db.dump('document_versions');
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.version === '1' && v.origin === 'upload')).toBe(true);
    expect(h.assets.prepareVersion).toHaveBeenCalledTimes(2);
    const first = h.assets.prepareVersion.mock.calls.find((call) => call[2] === '# A');
    expect(first?.[0]).toBe(result.documents[0].doc_id);
    expect(first?.[1]).toBe('1');
    expect(first?.[3]).toEqual([{ fileName: 'p.png', contentType: 'image/png', data: png }]);
    await h.drain();
  });

  /** MD 셋을 올린다. */
  const uploadThree = () =>
    h.service.upload(
      [uploadFile('a.md', '# A'), uploadFile('b.md', '# B'), uploadFile('c.md', '# C')],
      [
        { file_name: 'a.md', name: 'A' },
        { file_name: 'b.md', name: 'B' },
        { file_name: 'c.md', name: 'C' },
      ],
    );

  it('T-PR3-F2-1 문서를 모두 만든 뒤에 업로드 기록을 남기고 그다음 처리를 시작한다', async () => {
    const insertDocument = jest.spyOn(h.repo, 'insertDocument');
    const insertVersion = jest.spyOn(h.repo, 'insertVersion');
    const result = await uploadThree();
    await h.drain();

    expect(result.documents).toHaveLength(3);
    expect(insertDocument).toHaveBeenCalledTimes(3);
    expect(h.logs.recordsOf('upload')).toHaveLength(3);
    // ★ 모든 문서 쓰기(준비·버전·문서)가 첫 업로드 기록보다 먼저다
    const firstRecord = Math.min(
      ...h.logs.record.mock.calls
        .map((call, index) => ({
          kind: call[0].kind,
          order: h.logs.record.mock.invocationCallOrder[index],
        }))
        .filter((entry) => entry.kind === 'upload')
        .map((entry) => entry.order),
    );
    expect(Math.max(...insertDocument.mock.invocationCallOrder)).toBeLessThan(firstRecord);
    expect(Math.max(...insertVersion.mock.invocationCallOrder)).toBeLessThan(firstRecord);
    expect(Math.max(...h.assets.prepareVersion.mock.invocationCallOrder)).toBeLessThan(firstRecord);
    // 처리 시작은 문서마다 하나다
    expect(h.assets.generateHints).toHaveBeenCalledTimes(3);
    // ★ 처리 단계의 기록(요약 등)은 제외하고 업로드 기록만 본다
    const uploadOrders = h.logs.record.mock.calls
      .map((call, index) => ({
        kind: call[0].kind,
        order: h.logs.record.mock.invocationCallOrder[index],
      }))
      .filter((entry) => entry.kind === 'upload')
      .map((entry) => entry.order);
    expect(Math.max(...uploadOrders)).toBeLessThan(
      Math.min(...h.assets.generateHints.mock.invocationCallOrder),
    );
  });

  it('T-PR3-F2-2 셋째 문서 쓰기가 실패하면 만든 문서·버전이 하나도 남지 않고 원래 오류로 거부된다', async () => {
    const failure = new Error('third insert boom');
    // ★ 셋째 준비 안에서 다음 insertOne(셋째 버전 쓰기)을 실패시킨다
    h.assets.prepareVersion
      .mockResolvedValueOnce(PREPARED)
      .mockResolvedValueOnce(PREPARED)
      .mockImplementationOnce(async () => {
        h.db.failNext('insertOne', failure);
        return PREPARED;
      });
    await expect(uploadThree()).rejects.toBe(failure);
    await h.drain();

    expect(h.db.dump('documents')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(0);
    const ids = h.assets.prepareVersion.mock.calls.map((call) => call[0]);
    expect(ids).toHaveLength(3);
    for (const docId of ids) expect(h.assets.deleteDocument).toHaveBeenCalledWith(docId);
    expect(h.logs.recordsOf('upload')).toHaveLength(0);
    expect(h.assets.generateHints).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.1.5', () => {
  it('T-UP-2 판 정보가 있으면 저장하고 없으면 null이다', async () => {
    const result = await h.service.upload(
      [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')],
      [
        { file_name: 'a.md', name: 'A', edition: { label: ' v1 ', edition_date: '2026-02-03' } },
        { file_name: 'b.md', name: 'B' },
      ],
    );
    expect(docOf(h.db, result.documents[0].doc_id).edition).toEqual({
      label: 'v1',
      editionDate: '2026-02-03',
    });
    expect(docOf(h.db, result.documents[1].doc_id).edition).toBeNull();
    await h.drain();
  });
});

describe('REQ-BE-1.1.7', () => {
  it('T-UP-3 BOM·CRLF MD는 저장한 원본을 UTF-8로 바꾸면 입력 바이트와 같다', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('제목\r\n본문\r\n', 'utf8'),
    ]);
    const result = await h.service.upload(
      [uploadFile('a.md', bytes)],
      [{ file_name: 'a.md', name: 'A' }],
    );
    const stored = versionOf(h.db, result.documents[0].doc_id, '1');
    expect(Buffer.from(stored?.originalMarkdown ?? '', 'utf8').equals(bytes)).toBe(true);
    await h.drain();
  });
});

describe('REQ-BE-1.1.8', () => {
  it('T-UP-4 업로드 직후 문서는 업로드됨·검색 안 됨이고 요약·캡션은 아직 시작하지 않았다', async () => {
    const result = await h.service.upload(
      [uploadFile('a.md', 'a')],
      [{ file_name: 'a.md', name: 'A' }],
    );
    const doc = docOf(h.db, result.documents[0].doc_id);
    expect(doc.processingState).toBe('uploaded');
    // ★ 처리를 마치기 전에는 색인 대기열 밖이고 버전 레코드의 요청 횟수는 0이다
    expect(doc.queuedVersion).toBeNull();
    expect(versionOf(h.db, result.documents[0].doc_id, '1')?.requestSeq).toBe(0);
    expect(doc.searchState).toBe('not_searchable');
    expect(doc.searchableVersion).toBeNull();
    expect(doc.deleted).toBe(false);
    expect(doc.purged).toBe(false);
    expect(doc.pendingRag).toEqual({ deleteChunks: false, metadata: false });
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    await h.drain();
  });
});

describe('REQ-BE-1.1.9', () => {
  it('T-UP-5 응답 뒤 요약·캡션을 만들고 색인 대기열에 들어가며 색인 요청은 없고 업로드 기록이 문서마다 하나다', async () => {
    const result = await h.service.upload(
      [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')],
      [
        { file_name: 'a.md', name: 'A', edition: { label: 'v1', edition_date: '2026-01-01' } },
        { file_name: 'b.md', name: 'B' },
      ],
    );
    await h.drain();
    const [a, b] = result.documents;
    const uploads = h.logs.recordsOf('upload');
    expect(uploads).toHaveLength(2);
    expect(uploads.find((u) => u.docId === a.doc_id)).toMatchObject({
      outcome: 'success',
      name: 'A',
      editionLabel: 'v1',
    });
    expect(uploads.find((u) => u.docId === b.doc_id)).toMatchObject({
      outcome: 'success',
      name: 'B',
      editionLabel: null,
    });
    for (const item of [a, b]) {
      const hintIndex = h.assets.generateHints.mock.calls.findIndex((c) => c[0] === item.doc_id);
      expect(hintIndex).toBeGreaterThanOrEqual(0);
      const call = h.assets.generateHints.mock.calls[hintIndex];
      expect(call[1]).toBe('1');
      expect(call[2].name).toBe(item.name);
      expect(typeof call[2].shouldContinue).toBe('function');
      // ★ 요약·캡션을 만든 뒤 색인 대기열에 들어간다. 색인 요청은 예약 색인만 한다 (REQ-BE-1.10.1)
      const doc = docOf(h.db, item.doc_id);
      expect(doc.processingState).toBe('queued');
      expect(doc.queuedVersion).toBe('1');
    }
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(h.assets.generateHints.mock.calls.find((c) => c[0] === a.doc_id)?.[2].editionLabel).toBe(
      'v1',
    );
  });

  /** 문서 둘을 올린다. */
  const uploadTwo = () =>
    h.service.upload(
      [uploadFile('a.md', '# A'), uploadFile('b.md', '# B')],
      [
        { file_name: 'a.md', name: 'A' },
        { file_name: 'b.md', name: 'B' },
      ],
    );

  /** 문서 ID가 prepareVersion에 넘어간 차례대로 모은다. */
  const preparedIds = (): string[] => h.assets.prepareVersion.mock.calls.map((call) => call[0]);

  /** 문서·버전 레코드가 모두 없는지 본다. */
  const expectNoRecords = (...docIds: string[]): void => {
    for (const docId of docIds) {
      expect(h.db.dump('documents').some((doc) => doc.docId === docId)).toBe(false);
      expect(versionRows(docId)).toBe(0);
    }
  };

  it('T-PR3-UP-1 둘째 준비가 실패하면 요청 전체가 되돌려지고 원래 오류로 거부되며 처리는 시작되지 않는다', async () => {
    h.assets.prepareVersion
      .mockResolvedValueOnce(PREPARED)
      .mockRejectedValueOnce(new Error('second boom'));
    await expect(uploadTwo()).rejects.toThrow('second boom');
    await h.drain();

    const [firstId, secondId] = preparedIds();
    // ★ 요청 하나를 한 단위로 본다 — 첫 문서도 지워진다 (P38)
    expectNoRecords(firstId, secondId);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(firstId);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(secondId);
    expect(h.logs.recordsOf('upload')).toHaveLength(0);
    expect(h.assets.generateHints).not.toHaveBeenCalled();
  });

  it('T-PR3-UP-1b 첫째 준비가 실패해도 첫째 문서의 파일이 정리되고 아무것도 남지 않으며 처리는 시작되지 않는다', async () => {
    h.assets.prepareVersion.mockRejectedValueOnce(new Error('first boom'));
    await expect(uploadTwo()).rejects.toThrow('first boom');
    await h.drain();

    // ★ docId는 첫 쓰기 전에 되돌릴 목록에 들어간다 — 준비가 일부만 쓰고 실패해도 지운다 (P38①)
    expect(h.assets.prepareVersion).toHaveBeenCalledTimes(1);
    const [firstId] = preparedIds();
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(firstId);
    expectNoRecords(firstId);
    expect(h.db.dump('documents')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(0);
    expect(h.logs.record).not.toHaveBeenCalled();
    expect(h.assets.generateHints).not.toHaveBeenCalled();
  });

  it('T-PR3-UP-2 모든 문서를 만든 뒤 둘째 업로드 기록이 실패하면 두 문서 모두 지워지고 처리는 시작되지 않는다', async () => {
    h.logs.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('log boom'));
    await expect(uploadTwo()).rejects.toThrow('log boom');
    await h.drain();

    const [firstId, secondId] = preparedIds();
    expectNoRecords(firstId, secondId);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(firstId);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(secondId);
    // ★ 첫째 업로드 기록 호출은 이미 일어났다 — 남은 기록은 지우지 않는다 (P38⑤)
    expect(h.logs.record).toHaveBeenCalledTimes(2);
    expect(h.assets.generateHints).not.toHaveBeenCalled();
  });

  it.each(['assets.deleteDocument', 'repo.deleteVersions', 'repo.deleteDocumentRecord'] as const)(
    'T-PR3-UP-3 정리 단계 %s가 첫째 문서에서 실패해도 나머지 단계와 다른 문서는 정리되고 원래 오류로 거부된다',
    async (failingStep) => {
      h.assets.prepareVersion
        .mockResolvedValueOnce(PREPARED)
        .mockRejectedValueOnce(new Error('primary failure'));
      // ★ 첫째 문서의 이 단계만 실패시킨다. spy라 구현 여부와 무관하게 거부를 건다
      const isFirst = (docId: string): boolean => docId === preparedIds()[0];
      const cleanupFailure = async (docId: string): Promise<void> => {
        if (isFirst(docId)) throw new Error('cleanup failure');
      };
      const realDeleteVersions = h.repo.deleteVersions.bind(h.repo);
      const realDeleteRecord = h.repo.deleteDocumentRecord.bind(h.repo);
      const deleteVersions = jest
        .spyOn(h.repo, 'deleteVersions')
        .mockImplementation(
          failingStep === 'repo.deleteVersions' ? cleanupFailure : realDeleteVersions,
        );
      const deleteRecord = jest
        .spyOn(h.repo, 'deleteDocumentRecord')
        .mockImplementation(
          failingStep === 'repo.deleteDocumentRecord' ? cleanupFailure : realDeleteRecord,
        );
      if (failingStep === 'assets.deleteDocument') {
        h.assets.deleteDocument.mockImplementation(cleanupFailure);
      }
      await expect(uploadTwo()).rejects.toThrow('primary failure');
      await h.drain();

      const [firstId, secondId] = preparedIds();
      // ★ 어느 단계가 실패해도 세 단계 모두 두 문서에 대해 시도됐다 (단계별 독립 정리, AP-17)
      expect(h.assets.deleteDocument).toHaveBeenCalledWith(firstId);
      expect(h.assets.deleteDocument).toHaveBeenCalledWith(secondId);
      expect(deleteVersions).toHaveBeenCalledWith(firstId);
      expect(deleteVersions).toHaveBeenCalledWith(secondId);
      expect(deleteRecord).toHaveBeenCalledWith(firstId);
      expect(deleteRecord).toHaveBeenCalledWith(secondId);
      // ★ 실패한 단계가 지우는 것만 첫째 문서에 남을 수 있고, 둘째 문서는 모두 지워진다
      expectNoRecords(secondId);
      if (failingStep === 'assets.deleteDocument') expectNoRecords(firstId);
      if (failingStep === 'repo.deleteVersions') {
        expect(h.db.dump('documents').some((doc) => doc.docId === firstId)).toBe(false);
      }
      if (failingStep === 'repo.deleteDocumentRecord') expect(versionRows(firstId)).toBe(0);
      expect(h.assets.generateHints).not.toHaveBeenCalled();
    },
  );
});

describe('REQ-BE-1.2.4', () => {
  it('T-UP-6 문서마다 세 시각이 같고 뒤 문서가 더 늦다', async () => {
    await boot({ clock: createFakeClock() });
    const result = await h.service.upload(
      [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')],
      [
        { file_name: 'a.md', name: 'A' },
        { file_name: 'b.md', name: 'B' },
      ],
    );
    const [a, b] = result.documents.map((item) => docOf(h.db, item.doc_id));
    for (const doc of [a, b]) {
      expect(doc.uploadedAt.getTime()).toBe(doc.editionEnteredAt.getTime());
      expect(doc.uploadedAt.getTime()).toBe(doc.updatedAt.getTime());
    }
    expect(b.uploadedAt.getTime()).toBeGreaterThan(a.uploadedAt.getTime());
    await h.drain();
  });
});

describe('REQ-BE-1.1.2', () => {
  it('T-UP-7 검증에 실패하면 아무것도 저장하지 않고 기록도 남기지 않는다', async () => {
    const meta = (names: string[]) => names.map((file_name) => ({ file_name, name: '이름' }));
    const cases: Array<() => Promise<unknown>> = [
      () => h.service.upload([uploadFile('a.md', 'a'), uploadFile('x.pdf', 'x')], meta(['a.md'])),
      () => h.service.upload([uploadFile('a.md', 'a')], meta(['other.md'])),
      () => h.service.upload([uploadFile('big.md', Buffer.alloc(1001, 97))], meta(['big.md'])),
    ];
    for (const run of cases) await expect(run()).rejects.toThrow();
    expect(h.db.dump('documents')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(0);
    expect(h.assets.prepareVersion).not.toHaveBeenCalled();
    expect(h.logs.record).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.1.4', () => {
  it('T-UP-8 짝 없는 이미지 참조는 응답에 그대로 담긴다', async () => {
    h.assets.prepareVersion.mockResolvedValueOnce({
      indexingMarkdown: IDX_SENT,
      unmatchedImages: ['./x.png'],
      assetCount: 0,
    });
    const result = await h.service.upload(
      [uploadFile('a.md', '![x](./x.png)')],
      [{ file_name: 'a.md', name: 'A' }],
    );
    expect(result.documents[0].unmatched_images).toEqual(['./x.png']);
    await h.drain();
  });
});

describe('REQ-BE-1.1.3', () => {
  it('T-UP-9 같은 이름 이미지 오류가 나면 그 오류를 던지고 문서·버전을 남기지 않는다', async () => {
    h.assets.prepareVersion.mockRejectedValueOnce(new InvalidRequestError('같은 이름 이미지'));
    await expect(
      h.service.upload([uploadFile('a.md', 'a')], [{ file_name: 'a.md', name: 'A' }]),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(h.db.dump('documents')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(0);
  });
});

describe('REQ-BE-1.3.6', () => {
  const stage = (id: string): Map<string, RagJobStage> => new Map([[id, 'embedding']]);

  it('T-LIST-1 색인 중인 문서만 모아 한 번 단계를 묻고 단계가 있는 문서만 값을 채운다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'indexing' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'indexing' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'completed' }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C }),
      ],
    );
    h.indexing.getStages.mockResolvedValueOnce(stage(DOC_A));
    const page = await h.service.list(listQuery());
    expect(h.indexing.getStages).toHaveBeenCalledTimes(1);
    expect(new Set(h.indexing.getStages.mock.calls[0][0])).toEqual(new Set([DOC_A, DOC_B]));
    const byId = new Map(page.items.map((item) => [item.doc_id, item]));
    expect(byId.get(DOC_A)?.stage).toBe('embedding');
    expect(byId.get(DOC_B)?.stage).toBeNull();
    expect(byId.get(DOC_C)?.stage).toBeNull();

    // 단계를 하나도 못 받아도 결과는 정상이다
    h.indexing.getStages.mockResolvedValueOnce(new Map());
    const none = await h.service.list(listQuery());
    expect(none.items.every((item) => item.stage === null)).toBe(true);
    expect(none.total).toBe(3);
  });

  it('T-LIST-1 색인 중인 문서가 없으면 단계를 묻지 않는다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord({ docId: DOC_A })]);
    await h.service.list(listQuery());
    expect(h.indexing.getStages).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.3.8', () => {
  it('T-LIST-2 실패 문서의 failure_message는 마지막 버전의 사유다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'failed', latestVersion: '2' })],
      [
        versionRecord({
          docId: DOC_A,
          version: '1',
          failure: { code: 'OLD', message: '옛 사유', headingPath: null, placeholderId: null },
        }),
        versionRecord({
          docId: DOC_A,
          version: '2',
          failure: {
            code: 'PARSE_FAILED',
            message: FAILMSG_SENT,
            headingPath: null,
            placeholderId: null,
          },
        }),
      ],
    );
    const page = await h.service.list(listQuery());
    expect(page.items[0].failure_message).toBe(FAILMSG_SENT);
  });

  it('T-PR3-FAIL-1 버전이 셋인 실패 문서도 마지막 버전의 사유만 필요한 필드만 읽어 준다', async () => {
    const failure = (code: string, message: string) => ({
      code,
      message,
      headingPath: null,
      placeholderId: null,
    });
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'failed', latestVersion: '3' })],
      [
        versionRecord({ docId: DOC_A, version: '1', failure: failure('V1', '버전1 사유') }),
        versionRecord({ docId: DOC_A, version: '2', failure: failure('V2', '버전2 사유') }),
        versionRecord({ docId: DOC_A, version: '3', failure: failure('V3', FAILMSG_SENT) }),
      ],
    );
    const start = h.db.calls.length;
    const page = await h.service.list(listQuery());
    expect(page.items[0].failure_message).toBe(FAILMSG_SENT);

    // ★ 본문(originalMarkdown·indexingMarkdown)을 읽지 않는다 — projection과 필터 모양으로 본다
    const lookups = h.db.calls.slice(start).filter((call) => {
      const filter = call.filter as { $or?: unknown } | undefined;
      return call.op === 'find' && Array.isArray(filter?.$or);
    });
    expect(lookups).toHaveLength(1);
    expect(lookups[0].filter).toEqual({ $or: [{ docId: DOC_A, version: '3' }] });
    expect(lookups[0].options).toMatchObject({
      projection: { _id: 0, docId: 1, version: 1, failure: 1 },
    });
    expect(lookups[0].returned).toBe(1);
  });
});

describe('REQ-BE-1.3.1', () => {
  it('T-PR3-LIST-1 130개 중 3쪽은 독립 비교 함수의 41~60번째와 같고 DB에서 그 쪽만 읽는다', async () => {
    const base = Date.UTC(2026, 9, 1);
    const docs = Array.from({ length: 130 }, (_unused, i) =>
      docRecord({
        docId: uid(i + 1),
        // ★ 이름이 겹치게 만들어 동점 규칙(수정 시각 늦은 순 → 문서 ID)도 함께 본다
        name: `${i % 7 === 0 ? '가' : 'n'}${String(i % 31).padStart(2, '0')}`,
        updatedAt: new Date(base + ((i * 7) % 11) * 60000),
      }),
    );
    await seed(h.db, docs);

    const page = await h.service.list(
      listQuery({ page: 3, page_size: 20, sort: 'name', order: 'asc' }),
    );

    const expected = [...docs]
      .sort((a, b) => cmpPoints(a.name, b.name) || tieBreak(a, b))
      .slice(40, 60)
      .map((doc) => doc.docId);
    expect(page.items.map((item) => item.doc_id)).toEqual(expected);
    expect(page.total).toBe(130);
    // ★ 전체를 읽어 메모리에서 자르지 않는다 — documents 조회가 돌려준 문서 수의 합이 한 쪽 이하다
    const returned = h.db.calls
      .filter((call) => call.op === 'find')
      .reduce((sum, call) => sum + (call.returned ?? 0), 0);
    expect(returned).toBeLessThanOrEqual(20);
  });
});

describe('REQ-BE-1.3.2', () => {
  /** 쪽마다 기대 순서의 같은 구간과 같은지 본다. */
  async function expectPages(
    sort: 'search_state' | 'processing_state',
    order: 'asc' | 'desc',
    pageSize: 20 | 50 | 100,
    expected: readonly string[],
  ): Promise<void> {
    const pages = Math.ceil(expected.length / pageSize);
    for (let page = 1; page <= pages; page += 1) {
      const result = await h.service.list(listQuery({ page, page_size: pageSize, sort, order }));
      expect({ page, ids: result.items.map((item) => item.doc_id), total: result.total }).toEqual({
        page,
        ids: expected.slice((page - 1) * pageSize, page * pageSize),
        total: expected.length,
      });
    }
  }

  it('T-PR3-LIST-2 검색 상태 열은 값 순서로 정렬되고 쪽 경계가 값 경계에 걸려도 맞다', async () => {
    const order: SearchState[] = ['searchable', 'not_searchable', 'replaced'];
    const docs = bucketDocs(
      [
        ['searchable', 15],
        ['not_searchable', 12],
        ['replaced', 8],
      ],
      (value) => ({ searchState: value as SearchState }),
    );
    await seed(h.db, docs);
    // ★ asc 1쪽은 15 | 5로, 2쪽은 7 | 8로 값 경계에 걸친다. 묶음 안 순서는 방향과 무관하다
    await expectPages(
      'search_state',
      'asc',
      20,
      expectedByBucket(docs, (doc) => doc.searchState, order),
    );
    await expectPages(
      'search_state',
      'desc',
      20,
      expectedByBucket(docs, (doc) => doc.searchState, [...order].reverse()),
    );
  });

  it('T-PR3-LIST-3 처리 상태 여섯 값을 섞어도 값 순서대로이고 개수가 0인 값이 있어도 맞다', async () => {
    const order: ProcessingState[] = [
      'uploaded',
      'captioning',
      'queued',
      'indexing',
      'completed',
      'failed',
    ];
    const docs = bucketDocs(
      [
        ['uploaded', 9],
        ['captioning', 0],
        ['queued', 12],
        ['indexing', 8],
        ['completed', 17],
        ['failed', 14],
      ],
      (value) => ({ processingState: value as ProcessingState }),
    );
    await seed(h.db, docs);
    // ★ 60건을 20건씩 3쪽으로 읽으면 쪽 경계가 값 경계에 여러 번 걸친다
    await expectPages(
      'processing_state',
      'asc',
      20,
      expectedByBucket(docs, (doc) => doc.processingState, order),
    );
    await expectPages(
      'processing_state',
      'desc',
      20,
      expectedByBucket(docs, (doc) => doc.processingState, [...order].reverse()),
    );
  });
});

describe('REQ-BE-1.3.5', () => {
  it('T-LIST-3 판 칸은 같은 이름의 검색 가능 판과 자기 판을 날짜 내림차순으로 모은다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'N', edition: ed('v2025', '2025-01-01') }),
        docRecord({ docId: DOC_B, name: 'N', edition: ed('v2024', '2024-01-01') }),
        docRecord({
          docId: DOC_C,
          name: 'N',
          edition: ed('v2022', '2022-01-01'),
          searchState: 'not_searchable',
          searchableVersion: null,
        }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C }),
      ],
    );
    const page = await h.service.list(listQuery());
    const old = page.items.find((item) => item.doc_id === DOC_C);
    expect(old?.sibling_editions).toEqual([
      { label: 'v2025', edition_date: '2025-01-01' },
      { label: 'v2024', edition_date: '2024-01-01' },
      { label: 'v2022', edition_date: '2022-01-01' },
    ]);
  });
});

describe('REQ-BE-1.2.1', () => {
  it('T-LIST-4 이름 필터는 그 이름의 문서만 남긴다', async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: '같은' }),
      docRecord({ docId: uid(2), name: '같은' }),
      docRecord({ docId: uid(3), name: '같은' }),
      docRecord({ docId: uid(4), name: '다른' }),
    ]);
    const page = await h.service.list(listQuery({ name: '같은' }));
    expect(page.items.map((item) => item.doc_id).sort()).toEqual([uid(1), uid(2), uid(3)]);
    expect(page.total).toBe(3);
  });
});

describe('REQ-BE-1.3.3', () => {
  it('T-LIST-5 최신판만 보기는 최신 검색 가능 판과 판 없는 문서를 남기고 다른 필터와 AND다', async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: 'N', edition: ed('v2022', '2022-01-01') }),
      docRecord({ docId: uid(2), name: 'N', edition: ed('v2025', '2025-01-01') }),
      docRecord({
        docId: uid(3),
        name: 'N',
        edition: ed('v2026', '2026-01-01'),
        searchState: 'not_searchable',
        searchableVersion: null,
      }),
      docRecord({ docId: uid(4), name: 'N', edition: null }),
    ]);
    const latest = await h.service.list(listQuery({ latest_only: true }));
    expect(latest.items.map((item) => item.doc_id).sort()).toEqual([uid(2), uid(4)]);
    const combined = await h.service.list(
      listQuery({ latest_only: true, search_state: ['searchable'], has_edition: true }),
    );
    expect(combined.items.map((item) => item.doc_id)).toEqual([uid(2)]);
  });

  it('T-PR3-LIST-4 판 조회는 필요한 필드만 읽고 최신판 거르기를 DB 조건으로 한다', async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: 'N', edition: ed('v2022', '2022-01-01') }),
      docRecord({ docId: uid(2), name: 'N', edition: ed('v2025', '2025-01-01') }),
      docRecord({ docId: uid(3), name: 'N', edition: null }),
    ]);
    const start = h.db.calls.length;
    const latest = await h.service.list(listQuery({ latest_only: true }));
    expect(latest.items.map((item) => item.doc_id).sort()).toEqual([uid(2), uid(3)]);
    expect(latest.total).toBe(2);

    // ★ 판 칸·최신판 계산용 조회는 검색 가능·판 있음 조건에 projection으로 다섯 필드만 읽는다
    const editionFinds = h.db.calls.slice(start).filter((call) => {
      const filter = call.filter as Record<string, unknown> | undefined;
      return (
        call.op === 'find' &&
        filter?.searchState === 'searchable' &&
        JSON.stringify(filter.edition) === JSON.stringify({ $ne: null })
      );
    });
    expect(editionFinds.length).toBeGreaterThanOrEqual(1);
    for (const call of editionFinds) {
      expect(call.options).toMatchObject({
        projection: { _id: 0, docId: 1, name: 1, edition: 1, searchState: 1, deleted: 1 },
      });
    }
    // ★ 최신판이 아닌 문서는 DB가 거른다 — 목록 조회가 돌려준 수의 합이 남는 문서 수와 판 조회 수의 합이다
    const returnedTotal = h.db.calls
      .slice(start)
      .filter((call) => call.op === 'find')
      .reduce((sum, call) => sum + (call.returned ?? 0), 0);
    const editionReturned = editionFinds.reduce((sum, call) => sum + (call.returned ?? 0), 0);
    expect(returnedTotal - editionReturned).toBe(2);
  });
});

describe('REQ-BE-1.8.2', () => {
  it('T-LIST-6 삭제된 문서는 목록·이름·같은 판 확인·보이는 문서·상세 어디에도 없다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, name: '지울문서', edition: ed('v1') })],
      [versionRecord({ docId: DOC_A })],
    );
    await h.service.remove(DOC_A);
    await h.drain();
    expect((await h.service.list(listQuery())).items).toHaveLength(0);
    expect((await h.service.names(Object.assign(new DocumentNamesQueryDto(), {}))).items).toEqual(
      [],
    );
    const check = await h.service.replacementCheck(
      Object.assign(new ReplacementCheckQueryDto(), { name: '지울문서', edition_label: 'v1' }),
    );
    expect(check.replaces).toEqual([]);
    expect((await h.service.visibleDocIds([DOC_A])).size).toBe(0);
    await expect(h.service.getDetail(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});

describe('REQ-BE-1.3.7', () => {
  const names = (over: Partial<DocumentNamesQueryDto> = {}): DocumentNamesQueryDto =>
    Object.assign(new DocumentNamesQueryDto(), over);

  beforeEach(async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: '나' }),
      docRecord({ docId: uid(2), name: '가' }),
      docRecord({ docId: uid(3), name: '가나' }),
      docRecord({ docId: uid(4), name: '가' }),
      docRecord({ docId: uid(5), name: '다', deleted: true }),
      docRecord({ docId: uid(6), name: '라', searchState: 'replaced' }),
    ]);
  });

  it('T-LIST-7 이름은 중복 없이 코드 포인트 순이며 삭제된 문서만의 이름은 뺀다', async () => {
    expect((await h.service.names(names())).items).toEqual(['가', '가나', '나', '라']);
  });

  it('T-LIST-7 접두사와 limit을 적용한다', async () => {
    expect((await h.service.names(names({ prefix: '가' }))).items).toEqual(['가', '가나']);
    expect((await h.service.names(names({ limit: 2 }))).items).toHaveLength(2);
  });

  // ★ 위 beforeEach의 시드(uid 1~6)와 섞이지 않게 아래 NAMES 테스트는 고유 접두사(P3-·a.b·P3U-)와
  // uid 100번대 이후 ID를 쓰고, 이름 조회도 그 접두사로 한정한다
  it('T-PR3-NAMES-1 같은 이름이 250개여도 이름순 묶음으로 읽어 적게 읽고 모든 이름을 준다', async () => {
    const docs = Array.from({ length: 250 }, (_unused, i) =>
      docRecord({ docId: uid(i + 100), name: 'P3-A' }),
    );
    docs.push(
      docRecord({ docId: uid(351), name: 'P3-B' }),
      docRecord({ docId: uid(352), name: 'P3-C' }),
      docRecord({ docId: uid(353), name: 'P3-D' }),
      docRecord({ docId: uid(354), name: 'P3-E', deleted: true }),
    );
    await seed(h.db, docs);

    const start = h.db.calls.length;
    const result = await h.service.names(names({ prefix: 'P3-' }));
    expect(result.items).toEqual(['P3-A', 'P3-B', 'P3-C', 'P3-D']);

    // ★ 전체 문서를 읽지 않는다 — 조회 2번 이하, 돌려준 문서 수의 합이 200 이하다
    const finds = h.db.calls.slice(start).filter((call) => call.op === 'find');
    expect(finds.length).toBeLessThanOrEqual(2);
    expect(finds.reduce((sum, call) => sum + (call.returned ?? 0), 0)).toBeLessThanOrEqual(200);
  });

  it('T-PR3-NAMES-2 접두사의 점은 글자 그대로이고 limit을 지킨다', async () => {
    await seed(h.db, [
      docRecord({ docId: uid(101), name: 'a.b-1' }),
      docRecord({ docId: uid(102), name: 'axb' }),
      docRecord({ docId: uid(103), name: 'a.b-2' }),
    ]);
    // ★ 접두사를 정규식에 그대로 넣으면 '.'이 아무 글자에 맞아 axb가 섞인다
    expect((await h.service.names(names({ prefix: 'a.b' }))).items).toEqual(['a.b-1', 'a.b-2']);
    expect((await h.service.names(names({ prefix: 'a.b', limit: 1 }))).items).toEqual(['a.b-1']);
  });

  it('T-PR3-NAMES-3 U+FFFF 위(보조 평면) 문자 이름도 코드 포인트 순으로 준다', async () => {
    // ★ UTF-16 코드 유닛 순이면 이모지(D83D…)가 U+FFFD보다 앞서 어긋난다
    const emoji = String.fromCodePoint(0x1f600);
    const bmp = String.fromCodePoint(0xfffd);
    await seed(h.db, [
      docRecord({ docId: uid(101), name: `P3U-${emoji}` }),
      docRecord({ docId: uid(102), name: `P3U-${bmp}` }),
      docRecord({ docId: uid(103), name: 'P3U-a' }),
    ]);
    const expected = [`P3U-${emoji}`, `P3U-${bmp}`, 'P3U-a'].sort(cmpPoints);
    expect(expected).toEqual(['P3U-a', `P3U-${bmp}`, `P3U-${emoji}`]);
    expect((await h.service.names(names({ prefix: 'P3U-' }))).items).toEqual(expected);
  });
});

describe('REQ-BE-1.2.3', () => {
  it('T-RC-1 같은 판 확인은 이름·판 표기가 같은 보이는 문서만 오래된 순으로 준다', async () => {
    const t = (n: number): Date => new Date(Date.UTC(2026, 9, n));
    await seed(h.db, [
      docRecord({ docId: uid(2), name: 'N', edition: ed('v1'), uploadedAt: t(2) }),
      docRecord({ docId: uid(1), name: 'N', edition: ed('v1'), uploadedAt: t(1) }),
      docRecord({ docId: uid(3), name: 'N', edition: ed('v1'), searchState: 'replaced' }),
      docRecord({ docId: uid(4), name: 'N', edition: ed('v1'), deleted: true }),
      docRecord({ docId: uid(5), name: 'N', edition: ed('v2') }),
      docRecord({ docId: uid(6), name: 'N', edition: null }),
      docRecord({ docId: uid(7), name: 'N', edition: null }),
    ]);
    const query = (over: Record<string, unknown>) =>
      Object.assign(new ReplacementCheckQueryDto(), over);
    const result = await h.service.replacementCheck(query({ name: 'N', edition_label: 'v1' }));
    expect(result.replaces.map((item) => item.doc_id)).toEqual([uid(1), uid(2)]);
    expect(Object.keys(result.replaces[0]).sort()).toEqual(['doc_id', 'edition', 'name']);

    const excluded = await h.service.replacementCheck(
      query({ name: 'N', edition_label: 'v1', exclude_doc_id: uid(1) }),
    );
    expect(excluded.replaces.map((item) => item.doc_id)).toEqual([uid(2)]);

    const noEdition = await h.service.replacementCheck(query({ name: 'N' }));
    expect(noEdition.replaces.map((item) => item.doc_id).sort()).toEqual([uid(6), uid(7)]);
  });
});

describe('REQ-BE-1.4.1', () => {
  it('T-GET-1 상세는 이름·판·마지막 버전 파일 이름·시각·상태를 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, name: '문서', edition: ed('v1'), latestVersion: '2' })],
      [
        versionRecord({ docId: DOC_A, version: '1', fileName: 'old.md' }),
        versionRecord({ docId: DOC_A, version: '2', fileName: 'new.md' }),
      ],
    );
    const detail = await h.service.getDetail(DOC_A);
    expect(detail.doc_id).toBe(DOC_A);
    expect(detail.name).toBe('문서');
    expect(detail.edition).toEqual({ label: 'v1', edition_date: '2025-01-01' });
    expect(detail.file_name).toBe('new.md');
    expect(detail.search_state).toBe('searchable');
    expect(detail.processing_state).toBe('completed');
    expect(detail.uploaded_at).toBe('2026-10-01T00:00:00Z');
    expect(detail.updated_at).toBe('2026-10-01T00:00:00Z');
  });

  it('T-GET-1 삭제된 문서와 없는 ID는 DocumentNotFoundError다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A, deleted: true })], [versionRecord()]);
    await expect(h.service.getDetail(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(h.service.getDetail(DOC_B)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it('T-PR3-WIN-1 새 버전을 만드는 중에도 상세·원본은 이전 버전으로 응답한다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A })],
      [
        versionRecord({
          docId: DOC_A,
          version: '1',
          fileName: 'old.md',
          originalMarkdown: '옛 원본',
        }),
      ],
    );
    const { gate, outcome } = await holdUpload();
    // ★ 선점은 끝났고 버전 2 레코드는 아직 없는 순간이다
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();

    const detail = await h.service.getDetail(DOC_A);
    expect(detail.file_name).toBe('old.md');
    expect(h.assets.listViews).toHaveBeenCalledWith(DOC_A, '1');
    const original = await h.service.getOriginal(DOC_A);
    expect(original.markdown).toBe('옛 원본');
    expect(h.assets.imageUrls).toHaveBeenCalledWith(DOC_A, '1');

    gate.resolve(PREPARED);
    expect(await outcome).toBe('resolved');
    await h.drain();
  });

  it('T-PR3-WIN-2 마지막 버전 레코드가 없으면 처리 상태와 관계없이 직전 버전으로 응답하고 직전 버전도 없으면 없는 문서다', async () => {
    await seed(
      h.db,
      [
        // 잠금 상태가 아니어도 마지막 버전(2)의 레코드만 없으면 직전 버전(1)으로 응답한다
        docRecord({ docId: DOC_A, processingState: 'completed', latestVersion: '2' }),
        docRecord({ docId: DOC_B, processingState: 'failed', latestVersion: '2' }),
        // 직전 버전(1)의 레코드도 없다
        docRecord({ docId: DOC_C, processingState: 'uploaded', latestVersion: '2' }),
        // 직전 버전 자체가 없다(마지막 버전이 1이다)
        docRecord({ docId: DOC_D, processingState: 'completed', latestVersion: '1' }),
      ],
      [DOC_A, DOC_B].map((docId) =>
        versionRecord({ docId, version: '1', fileName: 'old.md', originalMarkdown: '옛 원본' }),
      ),
    );
    for (const docId of [DOC_A, DOC_B]) {
      // ★ 직전 버전 레코드가 있으면 404가 아니다 (P39③)
      expect((await h.service.getDetail(docId)).file_name).toBe('old.md');
      expect((await h.service.getOriginal(docId)).markdown).toBe('옛 원본');
      expect(h.assets.listViews).toHaveBeenLastCalledWith(docId, '1');
    }
    for (const docId of [DOC_C, DOC_D]) {
      await expect(h.service.getDetail(docId)).rejects.toBeInstanceOf(DocumentNotFoundError);
      await expect(h.service.getOriginal(docId)).rejects.toBeInstanceOf(DocumentNotFoundError);
    }
  });

  it('T-PR3-F3-1 선점 뒤 교체되고 준비가 실패하면 마지막 버전이 되돌려져 상세·원본이 404가 아니다', async () => {
    const { gate, outcome } = await holdReplacedUpload();
    gate.reject(new Error('prepare boom'));
    expect(await outcome).toMatchObject({ message: 'prepare boom' });
    await h.drain();

    // ★ 롤백 조건(처리 상태)이 맞지 않아도 latestVersion은 레코드가 있는 1로 돌아와야 한다
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('1');
    expect(doc.processingState).toBe('failed');
    expect(doc.searchState).toBe('replaced');
    expect(doc.queuedVersion).toBeNull();
    const detail = await h.service.getDetail(DOC_A);
    expect(detail.failure?.code).toBe('REPLACED');
    expect((await h.service.getOriginal(DOC_A)).markdown).toBe(MD_SENT);
  });

  it('T-PR3-F3-2 롤백 저장까지 실패해 마지막 버전이 2로 남아도 상세·원본은 버전 1로 응답한다', async () => {
    const { gate, outcome } = await holdReplacedUpload();
    // ★ 다음 updateOne은 rollbackClaim의 갱신이다. 예외는 rollbackClaim이 삼킨다
    h.db.failNext('updateOne', new Error('rollback boom'));
    gate.reject(new Error('prepare boom'));
    expect(await outcome).toMatchObject({ message: 'prepare boom' });
    await h.drain();

    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
    // 버전 1의 REPLACED 사유 채우기는 단언하지 않는다. 계획(개정 3 P39②)은 다시 읽은 latestVersion('2')을
    // 대상으로 정하고, 그 레코드가 없으면 recheckAfterVersionWrite는 아무것도 쓰지 않는 것만 정상으로 둔다.
    // 버전 1에 사유를 남기는 것은 계획이 정하지 않았다.
    const detail = await h.service.getDetail(DOC_A);
    expect(detail.file_name).toBe(FILE_SENT);
    expect(h.assets.listViews).toHaveBeenLastCalledWith(DOC_A, '1');
    expect((await h.service.getOriginal(DOC_A)).markdown).toBe(MD_SENT);
    expect(h.assets.imageUrls).toHaveBeenLastCalledWith(DOC_A, '1');
  });
});

describe('REQ-BE-1.4.2', () => {
  it('T-GET-2 색인 중이면 단계, 완료면 결과, 실패면 마지막 버전의 사유를 준다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'indexing' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'completed' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'failed', latestVersion: '2' }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B, result: { chunkCount: 9, fallbackUsed: true } }),
        versionRecord({ docId: DOC_C, version: '1' }),
        versionRecord({
          docId: DOC_C,
          version: '2',
          result: null,
          failure: { code: 'X', message: '실패', headingPath: ['H'], placeholderId: 't1' },
        }),
      ],
    );
    h.indexing.getStages.mockResolvedValueOnce(
      new Map<string, RagJobStage>([[DOC_A, 'embedding']]),
    );
    expect((await h.service.getDetail(DOC_A)).stage).toBe('embedding');
    expect((await h.service.getDetail(DOC_B)).result).toEqual({
      chunk_count: 9,
      fallback_used: true,
    });
    expect((await h.service.getDetail(DOC_C)).failure).toEqual({
      code: 'X',
      message: '실패',
      heading_path: ['H'],
      placeholder_id: 't1',
    });
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-GET-3 표·이미지 목록은 마지막 버전의 assets 조회 값을 순서대로 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '3' })],
      [1, 2, 3].map((v) => versionRecord({ docId: DOC_A, version: String(v) })),
    );
    h.assets.listViews.mockResolvedValue([tableView('t1', '가'), tableView('t2', '나')]);
    const detail = await h.service.getDetail(DOC_A);
    expect(h.assets.listViews).toHaveBeenCalledWith(DOC_A, '3');
    expect(detail.assets.map((asset) => asset.placeholder_id)).toEqual(['t1', 't2']);
  });
});

describe('REQ-BE-1.4.3', () => {
  it('T-GET-4 원본은 마지막 버전의 원본 MD와 이미지 주소를 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '2' })],
      [
        versionRecord({ docId: DOC_A, version: '1', originalMarkdown: '옛' }),
        versionRecord({ docId: DOC_A, version: '2', originalMarkdown: '새' }),
      ],
    );
    h.assets.imageUrls.mockResolvedValue({ './a.png': '/v1/x', 'miss.png': null });
    const original = await h.service.getOriginal(DOC_A);
    expect(original.markdown).toBe('새');
    expect(original.images).toEqual({ './a.png': '/v1/x', 'miss.png': null });
    expect(h.assets.imageUrls).toHaveBeenCalledWith(DOC_A, '2');
  });
});

describe('REQ-BE-1.4.5', () => {
  /** RAG 청크 하나를 만든다. */
  function chunk(order: number): RagDocumentChunk {
    return {
      chunkId: `c${order}`,
      order,
      kind: 'text',
      headingPath: ['H'],
      title: null,
      summary: null,
      text: `본문${order}`,
      placeholderIds: [],
      splitIndex: null,
      splitTotal: null,
    };
  }

  it('T-GET-5 검색 가능이 아닌 문서는 빈 목록이고 RAG Server를 부르지 않는다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, searchState: 'not_searchable', searchableVersion: null })],
      [versionRecord()],
    );
    expect(await h.service.getChunks(DOC_A)).toEqual({ items: [] });
    expect(h.rag.getDocumentChunks).not.toHaveBeenCalled();
  });

  it('T-GET-6 RAG가 알려 준 버전으로 복원하고 order 오름차순으로 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '3', processingState: 'indexing' })],
      [1, 2, 3].map((v) => versionRecord({ docId: DOC_A, version: String(v) })),
    );
    h.rag.getDocumentChunks.mockResolvedValue({ version: '2', items: [chunk(2), chunk(1)] });
    const result = await h.service.getChunks(DOC_A);
    expect(result.items.map((item) => item.order)).toEqual([1, 2]);
    expect(result.items[0].markdown).toBe('R[2]본문1');
    expect(h.assets.restore).toHaveBeenCalledWith(DOC_A, '2', '본문1');
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'heading_path',
      'kind',
      'markdown',
      'order',
      'split_index',
      'split_total',
      'summary',
      'title',
    ]);
  });

  it('T-GET-7 RAG Server 호출이 실패하면 RagUnavailableError다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord()]);
    h.rag.getDocumentChunks.mockRejectedValueOnce(new RagUnavailableError());
    await expect(h.service.getChunks(DOC_A)).rejects.toBeInstanceOf(RagUnavailableError);
    h.rag.getDocumentChunks.mockRejectedValueOnce(new RagRequestError(500, 'X'));
    await expect(h.service.getChunks(DOC_A)).rejects.toBeInstanceOf(RagUnavailableError);
  });

  it('T-GET-8 RAG가 검색되는 버전이 없다고 하면 빈 목록이다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord()]);
    h.rag.getDocumentChunks.mockResolvedValue({ version: null, items: [] });
    expect(await h.service.getChunks(DOC_A)).toEqual({ items: [] });
  });
});

describe('REQ-BE-1.5.1', () => {
  it('T-EDIT-1 이름만 고치면 새 버전·재색인 없이 이름과 updatedAt만 바뀌고 기록이 남는다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름', edition: ed('v1') });
    const result = await h.service.edit(DOC_A, editBody({ name: '새이름' }));
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.name).toBe('새이름');
    expect(doc.edition).toEqual(ed('v1'));
    expect(doc.latestVersion).toBe('1');
    expect(doc.updatedAt.getTime()).toBeGreaterThan(new Date('2026-10-01T00:00:00Z').getTime());
    expect(h.db.dump('document_versions')).toHaveLength(1);
    expect(h.assets.inheritVersion).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(h.logs.recordsOf('edit')).toHaveLength(1);
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['name']);
    expect(h.logs.recordsOf('edit')[0].name).toBe('새이름');
    expect(result.name).toBe('새이름');
  });

  it('T-EDIT-7 같은 이름·빈 본문·같은 문장은 아무것도 바꾸지 않는다', async () => {
    await seedDoc({ docId: DOC_A, name: '이름' });
    h.assets.listViews.mockResolvedValue([tableView('t1', '지금 문장')]);
    const before = docOf(h.db, DOC_A);
    for (const body of [
      editBody({ name: '이름' }),
      editBody({}),
      editBody({ assets: [{ placeholder_id: 't1', text: '지금 문장' }] }),
    ]) {
      const result = await h.service.edit(DOC_A, body);
      expect(result.name).toBe('이름');
    }
    await h.drain();
    expect(docOf(h.db, DOC_A).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(h.logs.recordsOf('edit')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(1);
  });

  it('T-EDIT-8 모르는 placeholder_id는 InvalidRequestError이고 아무것도 바뀌지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.listViews.mockResolvedValue([tableView('t1', '문장')]);
    const error = await h.service
      .edit(DOC_A, editBody({ assets: [{ placeholder_id: 't9', text: HINT_SENT }] }))
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as Error).message).toContain('t9');
    expect(docOf(h.db, DOC_A).latestVersion).toBe('1');
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
  });

  it('T-EDIT-14 판을 null로 보내면 판 정보가 지워지고 기록은 edition이다', async () => {
    await seedDoc({ docId: DOC_A, edition: ed('v1') });
    await h.service.edit(DOC_A, editBody({ edition: null }));
    expect(docOf(h.db, DOC_A).edition).toBeNull();
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['edition']);
  });

  it('T-FU-ORDER-7 요약·캡션 편집의 새 버전을 쓰는 사이 삭제되면 edit 기록은 남고 응답은 DocumentNotFoundError다', async () => {
    await seedDoc({ docId: DOC_A });
    const held = await holdClaimPath('edit');
    await h.service.remove(DOC_A);
    held.release();
    expect(await held.outcome).toBeInstanceOf(DocumentNotFoundError);
    expect(recordCount(DOC_A, 'edit')).toBe(1);
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['hints']);
  });
});

describe('REQ-BE-1.5.2', () => {
  it('T-EDIT-2 검색 가능 문서의 이름 변경은 표시를 쓰고 백그라운드로 RAG에 보내 지운다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름' });
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(true);
    await h.drain();
    expect(h.indexing.updateMetadata).toHaveBeenCalledTimes(1);
    expect(h.indexing.updateMetadata).toHaveBeenCalledWith(
      DOC_A,
      '새 이름',
      null,
      expect.any(AbortSignal),
    );
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);
  });

  it('T-EDIT-2 RAG 요청이 실패하면 표시가 남는다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름' });
    h.indexing.updateMetadata.mockResolvedValue(false);
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    await h.drain();
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(true);
  });

  it('T-EDIT-3 검색되는 버전이 없는 문서는 RAG에 보내지 않고 표시도 켜지 않는다', async () => {
    await seedDoc({
      docId: DOC_A,
      searchState: 'not_searchable',
      processingState: 'failed',
      searchableVersion: null,
    });
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    await h.drain();
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);
    expect(h.indexing.updateMetadata).not.toHaveBeenCalled();
  });

  it('T-EDIT-2 대기열 문서의 이름만 바꾸면 대기열(queuedVersion)이 그대로이고 색인 요청이 없으며 다음 예약 색인은 새 이름으로 요청한다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름', processingState: 'queued', queuedVersion: '1' });
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.name).toBe('새 이름');
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
    expect(doc.latestVersion).toBe('1');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0]).toMatchObject({ version: '1', name: '새 이름' });
  });
});

describe('REQ-BE-1.2.4', () => {
  it('T-EDIT-4 이름·판 표기·판 지우기는 판에 들어온 시각을 바꾸고 판 날짜만 바꾸면 그대로다', async () => {
    await boot({ clock: createFakeClock('2026-10-04T00:00:00Z') });
    const entered = new Date('2026-10-01T00:00:00Z');
    await seedDoc({ docId: DOC_A, name: 'A', edition: ed('v1'), editionEnteredAt: entered });
    await seedDoc({ docId: DOC_B, name: 'B', edition: ed('v1'), editionEnteredAt: entered });
    await seedDoc({ docId: DOC_C, name: 'C', edition: ed('v1'), editionEnteredAt: entered });
    await seedDoc({ docId: DOC_D, name: 'D', edition: ed('v1'), editionEnteredAt: entered });

    await h.service.edit(DOC_A, editBody({ name: 'A2' }));
    await h.service.edit(DOC_B, editBody({ edition: { label: 'v2', edition_date: '2025-01-01' } }));
    await h.service.edit(DOC_C, editBody({ edition: { label: 'v1', edition_date: '2030-01-01' } }));
    await h.service.edit(DOC_D, editBody({ edition: null }));
    await h.drain();

    for (const id of [DOC_A, DOC_B, DOC_D]) {
      const doc = docOf(h.db, id);
      expect(doc.editionEnteredAt.getTime()).toBe(doc.updatedAt.getTime());
      expect(doc.editionEnteredAt.getTime()).toBeGreaterThan(entered.getTime());
    }
    const dateOnly = docOf(h.db, DOC_C);
    expect(dateOnly.editionEnteredAt.getTime()).toBe(entered.getTime());
    expect(dateOnly.updatedAt.getTime()).toBeGreaterThan(entered.getTime());
    expect(dateOnly.edition).toEqual(ed('v1', '2030-01-01'));
  });
});

describe('REQ-BE-1.5.4', () => {
  /** 요약·캡션 편집용 시드다. t1의 지금 문장은 '기존'이다. */
  async function seedWithHints(over: Partial<DocumentRecord> = {}): Promise<void> {
    await seedDoc({ docId: DOC_A, name: '문서', ...over });
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: HINT_SENT }]);
  }

  it('T-EDIT-5 요약·캡션 편집은 같은 내용의 새 버전을 만들어 색인 대기열에 넣고 색인 요청은 예약 색인에서 한다', async () => {
    await seedWithHints();
    const result = await h.service.edit(
      DOC_A,
      editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }),
    );
    // ★ 응답 때 처리 상태는 색인 대기이고 새 버전이 대기열에 있다. 색인 요청과 요약·캡션 생성은 없다
    expect(result.processing_state).toBe('queued');
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    const v1 = versionOf(h.db, DOC_A, '1');
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.origin).toBe('hints');
    expect(v2?.originalMarkdown).toBe(v1?.originalMarkdown);
    expect(v2?.indexingMarkdown).toBe(v1?.indexingMarkdown);
    expect(v2?.fileName).toBe(v1?.fileName);
    const call = h.assets.inheritVersion.mock.calls[0];
    expect(call.slice(0, 3)).toEqual([DOC_A, '1', '2']);
    expect(call[3]).toEqual(new Map([['t1', HINT_SENT]]));

    await h.drain();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    // 다음 예약 색인에서 그 버전의 자리표시 문장(새 값)과 함께 요청한다
    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    const request = requestsOf(DOC_A)[0];
    expect(request.version).toBe('2');
    expect(request.hints).toEqual([{ placeholderId: 't1', text: HINT_SENT }]);
    expect(request.force).toBe(false);
    expect(h.assets.hintsFor).toHaveBeenCalledWith(DOC_A, '2');
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['hints']);
    expect(transitionsOf(DOC_A)).toContainEqual(['completed', 'queued']);
  });

  it('T-EDIT-6 이름과 요약·캡션을 함께 고치면 RAG 이름을 바꾸고 예약 색인이 새 이름으로 요청한다', async () => {
    await seedWithHints();
    await h.service.edit(
      DOC_A,
      editBody({ name: '새 이름', assets: [{ placeholder_id: 't1', text: HINT_SENT }] }),
    );
    await h.drain();
    // 검색되는 버전이 있으므로 이름은 바로 RAG Server에 보낸다. 색인 요청은 아직 없다
    expect(h.indexing.updateMetadata).toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    await runScheduled();
    expect(requestsOf(DOC_A)[0].name).toBe('새 이름');
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['name', 'hints']);
  });

  it('T-EDIT-13 새 버전 만들기가 실패하면 읽은 값으로 되돌리고(대기열 밖으로) 기록을 남기지 않는다', async () => {
    await seedWithHints({ name: '옛이름' });
    const before = docOf(h.db, DOC_A);
    h.assets.inheritVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(
      h.service.edit(
        DOC_A,
        editBody({ name: '새 이름', assets: [{ placeholder_id: 't1', text: HINT_SENT }] }),
      ),
    ).rejects.toThrow('boom');
    const after = docOf(h.db, DOC_A);
    expect(after.latestVersion).toBe('1');
    expect(after.processingState).toBe('completed');
    // ★ 선점이 넣은 queuedVersion('2')이 남지 않는다 — 요청 전(대기열 밖)과 같게 되돌린다 (REQ-BE-1.10.4)
    expect(after.queuedVersion).toBeNull();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.name).toBe('옛이름');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
    expect(h.logs.record).not.toHaveBeenCalled();
    await runScheduled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.5.5', () => {
  /**
   * 요청들이 모두 문서를 읽은 뒤에야 다음으로 가게 해, 같은 값을 읽은 요청끼리의 경합을 결정적으로 만든다.
   * ★ 읽기가 몰리지 않는 구현이어도 멈추지 않도록 0.5초 뒤에는 풀어 준다.
   */
  function readTogether(parties = 2): void {
    const original = h.repo.findDocument.bind(h.repo);
    const gate = deferred();
    let arrived = 0;
    const timer = setTimeout(() => gate.resolve(), 500);
    timer.unref();
    jest.spyOn(h.repo, 'findDocument').mockImplementation(async (docId) => {
      const row = await original(docId);
      arrived += 1;
      if (arrived >= parties) {
        clearTimeout(timer);
        gate.resolve();
      }
      await gate.promise;
      return row;
    });
  }

  /** 첫 번째 문서 읽기 직후, 선점 전에 다른 요청이 문서를 바꾼 것처럼 Db에 직접 쓴다. */
  function changeAfterFirstRead(set: Record<string, unknown>): void {
    const original = h.repo.findDocument.bind(h.repo);
    let done = false;
    jest.spyOn(h.repo, 'findDocument').mockImplementation(async (docId) => {
      const row = await original(docId);
      if (!done) {
        done = true;
        await h.db.collection('documents').updateOne({ docId }, { $set: set });
      }
      return row;
    });
  }

  /** 정확히 하나만 성공하고 나머지는 잠김 오류인지 본다. */
  function expectOneWinner(results: PromiseSettledResult<unknown>[]): void {
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DocumentLockedError);
  }

  const versionCount = (docId: string): number =>
    h.db.dump('document_versions').filter((v) => v.docId === docId).length;

  it('T-EDIT-15 같은 문서를 동시에 재색인하면 하나만 새 버전을 만든다', async () => {
    await seedDoc({ docId: DOC_A });
    readTogether();
    const results = await Promise.allSettled([h.service.reindex(DOC_A), h.service.reindex(DOC_A)]);
    expectOneWinner(results);
    expect(h.assets.inheritVersion).toHaveBeenCalledTimes(1);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionCount(DOC_A)).toBe(2);
    await h.drain();
    // ★ 색인 요청은 예약 색인만 한다. 이긴 요청의 새 버전 하나만 대기열에 있다
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    await runScheduled();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-EDIT-16 재색인과 요약·캡션 편집이 동시에 오면 하나만 새 버전을 만든다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서' });
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: 'x' }]);
    readTogether();
    const results = await Promise.allSettled([
      h.service.reindex(DOC_A),
      h.service.edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] })),
    ]);
    expectOneWinner(results);
    expect(h.assets.inheritVersion).toHaveBeenCalledTimes(1);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionCount(DOC_A)).toBe(2);
    await h.drain();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    await runScheduled();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-EDIT-17 내용 다시 올리기와 이름 편집이 동시에 오면 하나만 반영된다', async () => {
    await seedDoc({ docId: DOC_A, name: '원래' });
    readTogether();
    const results = await Promise.allSettled([
      h.service.uploadContents(DOC_A, [md]),
      h.service.edit(DOC_A, editBody({ name: '새이름' })),
    ]);
    expectOneWinner(results);
    const doc = docOf(h.db, DOC_A);
    const uploadWon = results[0].status === 'fulfilled';
    // ★ 이긴 쪽의 결과만 남고 진 쪽의 흔적은 없어야 한다
    expect(doc.latestVersion).toBe(uploadWon ? '2' : '1');
    expect(doc.name).toBe(uploadWon ? '원래' : '새이름');
    expect(h.assets.prepareVersion).toHaveBeenCalledTimes(uploadWon ? 1 : 0);
    expect(versionCount(DOC_A)).toBe(uploadWon ? 2 : 1);
    await h.drain();
  });

  const ops: Array<[string, () => Promise<unknown>]> = [
    ['재색인', () => h.service.reindex(DOC_A)],
    ['내용 다시 올리기', () => h.service.uploadContents(DOC_A, [md])],
    [
      '요약·캡션 편집',
      () =>
        h.service.edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] })),
    ],
  ];

  it.each(ops)(
    'T-EDIT-18 %s: 읽은 뒤 선점 전에 삭제되면 없는 문서 오류이고 새 버전을 남기지 않는다',
    async (_label, run) => {
      await seedDoc({ docId: DOC_A });
      h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
      changeAfterFirstRead({ deleted: true });
      await expect(run()).rejects.toBeInstanceOf(DocumentNotFoundError);
      expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
      expect(h.assets.inheritVersion).not.toHaveBeenCalled();
      expect(h.assets.prepareVersion).not.toHaveBeenCalled();
    },
  );

  it.each(ops)(
    'T-EDIT-19 %s: 읽은 뒤 선점 전에 처리 중이 되면 잠김 오류이고 새 버전을 남기지 않는다',
    async (_label, run) => {
      await seedDoc({ docId: DOC_A });
      h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
      changeAfterFirstRead({ processingState: 'indexing' });
      await expect(run()).rejects.toBeInstanceOf(DocumentLockedError);
      expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
      expect(h.assets.inheritVersion).not.toHaveBeenCalled();
      expect(h.assets.prepareVersion).not.toHaveBeenCalled();
      expect(docOf(h.db, DOC_A).processingState).toBe('indexing');
    },
  );

  it('T-EDIT-9 같은 문서에 동시에 편집하면 하나만 반영되고 나머지는 잠김 오류다', async () => {
    await seedDoc({ docId: DOC_A, name: '원래' });
    readTogether();
    const results = await Promise.allSettled([
      h.service.edit(DOC_A, editBody({ name: '이름1' })),
      h.service.edit(DOC_A, editBody({ name: '이름2' })),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DocumentLockedError);
    expectSafeKoreanMessage((rejected[0].reason as Error).message);
    expect(h.logs.recordsOf('edit')).toHaveLength(1);
    await h.drain();
  });

  it('T-EDIT-10 업로드됨·요약·캡션 생성 중·색인 중과 대기열 밖 색인 대기 문서는 편집·재색인·내용 다시 올리기가 모두 잠김 오류다', async () => {
    // ★ 색인 대기라도 대기열 밖(queuedVersion null, RAG Server가 접수한 문서)이면 처리 중이다 (REQ-BE-1.5.5)
    const states: ProcessingState[] = ['uploaded', 'captioning', 'queued', 'indexing'];
    for (const state of states) {
      await boot();
      await seedDoc({ docId: DOC_A, processingState: state, queuedVersion: null });
      const docBefore = h.db.dump('documents');
      const versionsBefore = h.db.dump('document_versions');
      await expect(h.service.edit(DOC_A, editBody({ name: '새이름' }))).rejects.toBeInstanceOf(
        DocumentLockedError,
      );
      await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
      await expect(
        h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')]),
      ).rejects.toBeInstanceOf(DocumentLockedError);
      expect(h.db.dump('documents')).toEqual(docBefore);
      expect(h.db.dump('document_versions')).toEqual(versionsBefore);
    }
  });

  it('T-EDIT-10 대기열에 있는 색인 대기 문서는 편집·내용 다시 올리기를 받고 재색인만 잠김 오류다', async () => {
    await seedDoc({ docId: DOC_A, name: '원래', processingState: 'queued', queuedVersion: '1' });
    // 재색인만 거부한다. 거부는 아무것도 바꾸지 않는다
    const docBefore = h.db.dump('documents');
    const versionsBefore = h.db.dump('document_versions');
    await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
    expect(h.db.dump('documents')).toEqual(docBefore);
    expect(h.db.dump('document_versions')).toEqual(versionsBefore);

    // 이름 편집은 받는다 (새 버전 없이 이름만 바뀐다)
    const edited = await h.service.edit(DOC_A, editBody({ name: '새이름' }));
    expect(edited.name).toBe('새이름');
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');

    // 내용 다시 올리기도 받는다
    await h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')]);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    await h.drain();
  });

  it('T-EDIT-20 대기열 문서인데 마지막 버전 레코드가 없으면(선점 중) 편집·내용 다시 올리기가 잠김 오류다', async () => {
    // ★ 새 버전을 선점해 대기열에 넣은 채 버전 레코드를 쓰기 전인 순간이다. 레코드가 없는 문서는 받지 않는다
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_A,
          processingState: 'queued',
          queuedVersion: '2',
          latestVersion: '2',
        }),
      ],
      [versionRecord({ docId: DOC_A, version: '1' })],
    );
    const docBefore = h.db.dump('documents');
    const versionsBefore = h.db.dump('document_versions');
    await expect(h.service.edit(DOC_A, editBody({ name: '새이름' }))).rejects.toBeInstanceOf(
      DocumentLockedError,
    );
    await expect(h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')])).rejects.toBeInstanceOf(
      DocumentLockedError,
    );
    expect(h.db.dump('documents')).toEqual(docBefore);
    expect(h.db.dump('document_versions')).toEqual(versionsBefore);
    expect(h.assets.prepareVersion).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.5.6', () => {
  it('T-EDIT-11 교체된 문서는 처리가 끝났어도 편집·재색인·내용 다시 올리기·색인 대기로 바꾸기 모두 잠김 오류다', async () => {
    for (const state of ['completed', 'failed'] as const) {
      await boot();
      await seedDoc({ docId: DOC_A, searchState: 'replaced', processingState: state });
      await expect(h.service.edit(DOC_A, editBody({ name: '새이름' }))).rejects.toBeInstanceOf(
        DocumentLockedError,
      );
      await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
      await expect(
        h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')]),
      ).rejects.toBeInstanceOf(DocumentLockedError);
      // ★ 실패 상태여도 교체됨이면 색인 대기로 바꾸지 못한다 (REQ-BE-1.5.6)
      await expect(h.service.requeue(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
      expect(docOf(h.db, DOC_A).processingState).toBe(state);
      expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
      expect(versionOf(h.db, DOC_A, '1')?.requestSeq).toBe(0);
    }
  });
});

describe('REQ-BE-1.5.3', () => {
  it('T-EDIT-12a 검색 가능 문서를 같은 판으로 고치면 먼저 들어온 문서가 바로 교체된다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seedDoc({
      docId: DOC_B,
      name: 'B',
      edition: ed('v9'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
    });
    await h.service.edit(
      DOC_B,
      editBody({ name: 'N', edition: { label: 'v1', edition_date: '2026-01-01' } }),
    );
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    expect(h.logs.recordsOf('replace')).toHaveLength(1);
    expect(h.logs.recordsOf('replace')[0].docId).toBe(DOC_A);
    await h.drain();
  });

  it('T-EDIT-12b 검색 안 되는 문서를 같은 판으로 고치면 검색 가능이 된 뒤에 교체된다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_C,
          name: 'C',
          edition: ed('v9'),
          searchState: 'not_searchable',
          // ★ 대기열에 있는 색인 대기 문서다 — 편집을 받고, 성공 알림으로 완료가 된다
          processingState: 'queued',
          queuedVersion: '1',
          searchableVersion: null,
        }),
      ],
      [versionRecord({ docId: DOC_C, result: null })],
    );
    await h.service.edit(
      DOC_C,
      editBody({ name: 'N', edition: { label: 'v1', edition_date: '2026-01-01' } }),
    );
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId: DOC_C, jobState: 'succeeded', searchableVersion: '1' }),
    );
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    await h.drain();
  });
});

/** 내용 다시 올리기에 쓰는 새 MD 파일이다. */
const md = uploadFile('new.md', '# 새 내용');

describe('REQ-BE-1.9.1', () => {
  it('T-CONT-1 내용 다시 올리기는 새 원본으로 버전 2를 만들고 업로드됨으로 둔다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서' });
    const result = await h.service.uploadContents(DOC_A, [md]);
    expect(Object.keys(result).sort()).toEqual(['doc_id', 'file_name', 'name', 'unmatched_images']);
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.origin).toBe('content');
    expect(v2?.originalMarkdown).toBe('# 새 내용');
    expect(v2?.fileName).toBe('new.md');
    expect(h.assets.prepareVersion.mock.calls[0].slice(0, 3)).toEqual([DOC_A, '2', '# 새 내용']);
    expect(docOf(h.db, DOC_A).processingState).toBe('uploaded');
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
    expect(h.logs.recordsOf('content_upload')).toHaveLength(1);
    expect(transitionsOf(DOC_A)).toEqual([['completed', 'uploaded']]);
    await h.drain();
  });
});

describe('REQ-BE-1.6.2', () => {
  it('T-CONT-2 처리하는 동안에도 이전 버전이 계속 검색된다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.uploadContents(DOC_A, [md]);
    await h.drain();
    const hintIndex = h.assets.generateHints.mock.calls.findIndex((c) => c[1] === '2');
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    // ★ 요약·캡션을 만든 뒤 대기열에 들어가고 색인 요청은 예약 색인이 한다
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0].version).toBe('2');
    expect(h.assets.generateHints.mock.invocationCallOrder[hintIndex]).toBeLessThan(
      h.indexing.requestIndex.mock.invocationCallOrder[0],
    );
    const doc = docOf(h.db, DOC_A);
    expect(doc.searchState).toBe('searchable');
    expect(doc.searchableVersion).toBe('1');
  });
});

describe('REQ-BE-1.6.1', () => {
  it('T-CONT-3 형식·크기·MD 개수가 맞지 않으면 오류이고 마지막 버전은 그대로다', async () => {
    await seedDoc({ docId: DOC_A });
    await expect(
      h.service.uploadContents(DOC_A, [uploadFile('x.pdf', 'x')]),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
    await expect(
      h.service.uploadContents(DOC_A, [uploadFile('big.md', Buffer.alloc(1001, 97))]),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')]),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('1');
  });

  it('T-CONT-4 준비가 실패하면 상태·마지막 버전·updatedAt을 되돌리고 버전 2를 남기지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    const before = docOf(h.db, DOC_A);
    h.assets.prepareVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')])).rejects.toThrow(
      'boom',
    );
    const after = docOf(h.db, DOC_A);
    expect(after.processingState).toBe('completed');
    expect(after.latestVersion).toBe('1');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
  });

  it('T-CONT-5 앞선 실패가 남긴 버전 2 레코드가 있어도 다시 올리면 새 내용 하나만 남는다', async () => {
    await seedDoc({ docId: DOC_A });
    await seed(
      h.db,
      [],
      [versionRecord({ docId: DOC_A, version: '2', originalMarkdown: '찌꺼기' })],
    );
    await h.service.uploadContents(DOC_A, [uploadFile('a.md', '새 내용')]);
    const twos = h.db.dump('document_versions').filter((v) => v.version === '2');
    expect(twos).toHaveLength(1);
    expect(twos[0].originalMarkdown).toBe('새 내용');
    await h.drain();
  });
});

describe('REQ-BE-1.4.1', () => {
  it('T-CONT-6 삭제된 문서와 없는 ID는 DocumentNotFoundError다', async () => {
    await seedDoc({ docId: DOC_A, deleted: true });
    await expect(h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')])).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    await expect(h.service.uploadContents(DOC_B, [uploadFile('a.md', 'a')])).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });
});

describe('REQ-BE-1.7.1', () => {
  it('T-RIX-1 임시 설명이 있으면 captioning으로 두고(대기열 비움) 요약·캡션 뒤 색인 대기열에 넣으며 예약 색인이 강제 색인을 요청한다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.markTemporaryForRegeneration.mockResolvedValue(2);
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: HINT_SENT }]);
    await h.service.reindex(DOC_A);
    // ★ 재색인 응답 때: captioning, 대기열은 비어 있다 (REQ-BE-1.10.7)
    const during = docOf(h.db, DOC_A);
    expect(during.processingState).toBe('captioning');
    expect(during.queuedVersion).toBeNull();
    expect(during.latestVersion).toBe('2');
    expect(transitionsOf(DOC_A)).toEqual([['completed', 'captioning']]);

    await h.drain();
    expect(h.assets.generateHints.mock.calls.some((c) => c[1] === '2')).toBe(true);
    // ★ 표·이미지 처리가 끝나면 색인 대기열에 들어가고, 그때까지 색인 요청은 없다
    const after = docOf(h.db, DOC_A);
    expect(after.processingState).toBe('queued');
    expect(after.queuedVersion).toBe('2');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(transitionsOf(DOC_A)).toEqual([
      ['completed', 'captioning'],
      ['captioning', 'queued'],
    ]);

    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0]).toMatchObject({ version: '2', force: true });
    expect(requestsOf(DOC_A)[0].hints).toEqual([{ placeholderId: 't1', text: HINT_SENT }]);
    expect(h.assets.hintsFor).toHaveBeenCalledWith(DOC_A, '2');
  });

  it('T-RIX-2 임시 설명이 없으면 바로 색인 대기열에 넣고 요약·캡션 없이 색인 요청도 없으며 예약 색인이 강제 색인을 요청한다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.markTemporaryForRegeneration.mockResolvedValue(0);
    await h.service.reindex(DOC_A);
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('2');
    expect(transitionsOf(DOC_A)).toEqual([['completed', 'queued']]);
    await h.drain();
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();

    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0]).toMatchObject({ version: '2', force: true });
  });

  it('T-RIX-4 새 버전 만들기가 실패하면 상태와 마지막 버전을 되돌리고 선점 때 넣은 대기열도 비운다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.inheritVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(h.service.reindex(DOC_A)).rejects.toThrow('boom');
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('1');
    expect(doc.processingState).toBe('completed');
    // ★ 선점이 넣은 queuedVersion('2')이 남으면 안 된다 — 요청 전(대기열 밖)과 같게 되돌린다 (REQ-BE-1.10.4)
    expect(doc.queuedVersion).toBeNull();
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
    await runScheduled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-RIX-5 재색인이 선점 표시를 푸는 시점은 captioning 전환 뒤라 그 전에는 예약 색인이 문서를 요청하지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    // 임시 설명 확인(markTemporaryForRegeneration)에서 멈춘다 — 이 순간 문서는 대기열에 들어 있다
    const markGate = deferred<number>();
    h.assets.markTemporaryForRegeneration.mockImplementationOnce(() => markGate.promise);
    const hintsGate = deferred<{ generated: number; temporary: number; stopped: boolean }>();
    h.assets.generateHints.mockImplementationOnce(() => hintsGate.promise);
    const outcome = h.service.reindex(DOC_A);
    await waitUntil(() => h.assets.markTemporaryForRegeneration.mock.calls.length > 0);
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');

    // ★ 선점 표시가 남아 있어 건너뛴다 (대기열에는 그대로 남는다). 처리 작업이 멈춰 있으므로 drain하지 않는다
    expect(await h.lifecycle.runScheduledIndex()).toEqual({ requested: 0, unreachable: 0 });
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');

    markGate.resolve(1);
    await outcome;
    // captioning으로 바뀌었고 대기열이 비었다. 표·이미지 처리가 도는 동안 예약 색인은 요청하지 않는다
    await waitUntil(() => h.assets.generateHints.mock.calls.length > 0);
    const captioning = docOf(h.db, DOC_A);
    expect(captioning.processingState).toBe('captioning');
    expect(captioning.queuedVersion).toBeNull();
    await h.lifecycle.runScheduledIndex();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();

    hintsGate.resolve({ generated: 1, temporary: 0, stopped: false });
    await h.drain();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0]).toMatchObject({ version: '2', force: true });
  });
});

describe('REQ-BE-1.6.3', () => {
  it('T-RIX-3 재색인 버전은 이전 버전과 같은 내용에 origin reindex이고 updatedAt은 그대로다', async () => {
    await seedDoc({ docId: DOC_A });
    const before = docOf(h.db, DOC_A);
    await h.service.reindex(DOC_A);
    const v1 = versionOf(h.db, DOC_A, '1');
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.origin).toBe('reindex');
    expect(v2?.originalMarkdown).toBe(v1?.originalMarkdown);
    expect(v2?.indexingMarkdown).toBe(v1?.indexingMarkdown);
    expect(v2?.fileName).toBe(v1?.fileName);
    const call = h.assets.inheritVersion.mock.calls[0];
    expect(call.slice(0, 3)).toEqual([DOC_A, '1', '2']);
    expect(call[3]).toEqual(new Map());
    expect(docOf(h.db, DOC_A).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    await h.drain();
  });
});

describe('REQ-BE-1.8.1', () => {
  it('T-DEL-1 청크 삭제가 끝나지 않아도 remove는 돌아오고 삭제 표시와 기록이 남는다', async () => {
    await seedDoc({ docId: DOC_A, name: '지울것', edition: ed('v1') });
    const gate = deferred<boolean>();
    h.indexing.deleteChunks.mockReturnValue(gate.promise);
    await h.service.remove(DOC_A);
    const doc = docOf(h.db, DOC_A);
    expect(doc.deleted).toBe(true);
    expect(doc.pendingRag.deleteChunks).toBe(true);
    const deletes = h.logs.recordsOf('delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ outcome: 'success', name: '지울것', editionLabel: 'v1' });
    gate.resolve(true);
    await h.drain();
  });

  it('T-DEL-4 같은 문서를 두 번 지우면 둘째는 DocumentNotFoundError이고 기록은 하나다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.remove(DOC_A);
    await expect(h.service.remove(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(h.logs.recordsOf('delete')).toHaveLength(1);
    await h.drain();
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-DEL-2 청크 삭제가 성공하면 표시를 지우고 데이터를 지우며 문서 레코드는 남긴다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.remove(DOC_A);
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(false);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(DOC_A);
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(0);
    expect(doc.purged).toBe(true);
  });

  it('T-DEL-3 청크 삭제가 실패하면 표시와 데이터가 남는다', async () => {
    await seedDoc({ docId: DOC_A });
    h.indexing.deleteChunks.mockResolvedValue(false);
    await h.service.remove(DOC_A);
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(true);
    expect(h.assets.deleteDocument).not.toHaveBeenCalled();
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(1);
    expect(doc.purged).toBe(false);
  });

  it('T-PR3-DEL-1 내용 다시 올리기 중 삭제·데이터 삭제가 끝난 뒤 풀리면 새 버전 데이터까지 다시 지운다', async () => {
    await seedDoc({ docId: DOC_A });
    const { gate, outcome } = await holdUpload();
    await removeAndPurge();
    expect(versionRows(DOC_A)).toBe(0);

    gate.resolve(PREPARED);
    expect(await outcome).toBe('resolved');
    await h.drain();

    // ★ 풀린 뒤 쓴 버전 2 레코드·표·이미지가 남으면 안 된다 (청크 삭제 뒤 데이터 삭제)
    const doc = docOf(h.db, DOC_A);
    expect(doc.purged).toBe(true);
    expect(h.assets.deleteDocument).toHaveBeenCalledTimes(2);
    expect(versionRows(DOC_A)).toBe(0);
  });

  it('T-PR3-DEL-2 재색인 중 삭제·데이터 삭제가 끝난 뒤 풀려도 같다', async () => {
    await seedDoc({ docId: DOC_A });
    const { gate, outcome } = await holdReindex();
    await removeAndPurge();
    expect(versionRows(DOC_A)).toBe(0);

    gate.resolve();
    expect(await outcome).toBe('resolved');
    await h.drain();

    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(h.assets.deleteDocument).toHaveBeenCalledTimes(2);
    expect(versionRows(DOC_A)).toBe(0);
    // ★ 재색인 선점이 넣은 대기열은 삭제 때 빠졌고 풀린 뒤에도 되살아나지 않는다 (REQ-BE-1.10.7)
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
  });

  it('T-PR3-DEL-5요약·캡션 편집 중 삭제·데이터 삭제가 끝난 뒤 풀려도 새 버전 데이터까지 다시 지운다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    const { gate, outcome } = await holdEdit();
    await removeAndPurge();
    expect(versionRows(DOC_A)).toBe(0);

    gate.resolve();
    await outcome;
    await h.drain();

    // ★ edit 경로도 풀린 뒤 쓴 버전 2 레코드·표·이미지가 남으면 안 된다
    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(h.assets.deleteDocument).toHaveBeenCalledTimes(2);
    expect(versionRows(DOC_A)).toBe(0);
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
  });

  it('T-PR3-DEL-6요약·캡션 편집의 새 버전 만들기가 실패하는 경로에서도 다시 지우고 원래 오류로 거부된다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    const { gate, outcome } = await holdEdit();
    await removeAndPurge();

    gate.reject(new Error('inherit boom'));
    expect(await outcome).toMatchObject({ message: 'inherit boom' });
    await h.drain();

    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(h.assets.deleteDocument).toHaveBeenCalledTimes(2);
    expect(versionRows(DOC_A)).toBe(0);
    // ★ 되돌리기가 어긋나도(삭제됨) 비워진 대기열을 되살리지 않는다 (REQ-BE-1.10.4)
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
  });

  it('T-PR3-DEL-3새 버전 만들기가 실패하는 경로에서도 다시 지우고 원래 오류로 거부된다', async () => {
    await seedDoc({ docId: DOC_A });
    const { gate, outcome } = await holdUpload();
    await removeAndPurge();

    gate.reject(new Error('prepare boom'));
    expect(await outcome).toMatchObject({ message: 'prepare boom' });
    await h.drain();

    expect(docOf(h.db, DOC_A).purged).toBe(true);
    expect(h.assets.deleteDocument).toHaveBeenCalledTimes(2);
    expect(versionRows(DOC_A)).toBe(0);
  });
});

describe('REQ-BE-1.2.8', () => {
  /** 사유 없이 쓰인 새 버전을 두고 멈춘 동안 문서를 교체·실패 상태로 바꾼다. */
  async function replaceWhileHeld(): Promise<void> {
    await seedDoc({ docId: DOC_A });
    const { gate, outcome } = await holdUpload();
    // ★ 선점 직후 같은 판 문서가 검색 가능해져 교체된 순간이다
    await h.db
      .collection('documents')
      .updateOne(
        { docId: DOC_A },
        { $set: { searchState: 'replaced', processingState: 'failed' } },
      );
    gate.resolve(PREPARED);
    expect(await outcome).toBe('resolved');
  }

  it('T-PR3-REPL-1 멈춘 동안 교체·실패가 되면 새 버전 사유는 REPLACED다', async () => {
    await replaceWhileHeld();
    expect(versionOf(h.db, DOC_A, '2')?.failure?.code).toBe('REPLACED');
  });

  it('T-PR3-REPL-1 이미 사유가 있으면 덮지 않는다', async () => {
    const original = h.repo.replaceVersion.bind(h.repo);
    jest.spyOn(h.repo, 'replaceVersion').mockImplementation((record) =>
      original({
        ...record,
        failure: { code: 'OTHER', message: '다른 사유', headingPath: null, placeholderId: null },
      }),
    );
    await replaceWhileHeld();
    expect(versionOf(h.db, DOC_A, '2')?.failure?.code).toBe('OTHER');
  });

  it('T-PR3-F3-3 선점 뒤 교체되고 준비가 실패하면 되돌려진 버전 1에 REPLACED 사유가 남는다', async () => {
    const { gate, outcome } = await holdReplacedUpload();
    gate.reject(new Error('prepare boom'));
    await outcome;
    await h.drain();
    expect(versionOf(h.db, DOC_A, '1')?.failure?.code).toBe('REPLACED');
  });

  it('T-PR3-F3-3 버전 1에 이미 다른 사유가 있으면 그대로 둔다', async () => {
    const { gate, outcome } = await holdReplacedUpload();
    const other = { code: 'OTHER', message: '다른 사유', headingPath: null, placeholderId: null };
    await h.db
      .collection('document_versions')
      .updateOne({ docId: DOC_A, version: '1' }, { $set: { failure: other } });
    gate.reject(new Error('prepare boom'));
    await outcome;
    await h.drain();
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(other);
  });

  it.each([
    ['내용 다시 올리기', 'upload', 'content_upload'],
    ['요약·캡션 편집', 'edit', 'edit'],
    ['임시 설명 없는 재색인', 'reindex', null],
  ] as const)(
    'T-FU-ORDER-1 %s 선점 직후 교체되면 처리 상태 기록과 처리 시작 없이 요청은 성공하고 요청 기록은 남는다',
    async (_label, path, requestKind) => {
      await seedDoc({ docId: DOC_A });
      const started = jest.spyOn(h.lifecycle, 'startProcessing');
      const held = await holdClaimPath(path);
      // ★ 선점 직후 같은 판 문서가 검색 가능해져 교체된 순간이다. 교체는 같은 갱신에서 대기열도 비운다
      await h.db.collection('documents').updateOne(
        { docId: DOC_A },
        {
          $set: { searchState: 'replaced', processingState: 'failed', queuedVersion: null },
        },
      );
      held.release();
      expect(await held.outcome).toBe('resolved');
      await h.drain();
      expect(transitionsOf(DOC_A)).toEqual([]);
      expect(started).not.toHaveBeenCalled();
      expect(h.assets.generateHints).not.toHaveBeenCalled();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
      if (requestKind !== null) expect(recordCount(DOC_A, requestKind)).toBe(1);
      // ★ 서비스가 비워진 대기열을 되살리지 않는다 — 예약 색인도 요청하지 않는다
      expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
      await runScheduled();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );

  it('T-FU-ORDER-2 임시 설명이 있는 재색인도 선점 직후 교체되면 captioning 기록과 처리 시작이 없다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.markTemporaryForRegeneration.mockResolvedValue(1);
    const started = jest.spyOn(h.lifecycle, 'startProcessing');
    const held = await holdClaimPath('reindex');
    await h.db.collection('documents').updateOne(
      { docId: DOC_A },
      {
        $set: { searchState: 'replaced', processingState: 'failed', queuedVersion: null },
      },
    );
    held.release();
    expect(await held.outcome).toBe('resolved');
    await h.drain();
    expect(transitionsOf(DOC_A)).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    // ★ 교체된 문서의 대기열을 captioning 갱신이나 되살리기가 건드리지 않는다
    expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
    await runScheduled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });

  it('T-FU-ORDER-5 재색인은 다시 읽어 교체됨이면 captioning 조건부 갱신이 성공할 상태여도 기록·처리 시작이 없다', async () => {
    await expectReindexStopsOn('replaced');
  });
});

describe('REQ-BE-1.8.3', () => {
  it.each([
    ['내용 다시 올리기', 'upload'],
    ['요약·캡션 편집', 'edit'],
    ['재색인', 'reindex'],
  ] as const)(
    'T-FU-ORDER-3 %s 선점 직후 삭제되면 처리 상태 기록과 처리 시작이 없다',
    async (_label, path) => {
      await seedDoc({ docId: DOC_A });
      const started = jest.spyOn(h.lifecycle, 'startProcessing');
      const held = await holdClaimPath(path);
      await h.service.remove(DOC_A);
      held.release();
      const outcome = await held.outcome;
      await h.drain();
      // ★ 편집은 DocumentNotFoundError다 (REQ-BE-1.5.1 — 기록까지 T-FU-ORDER-7에서 본다)
      if (path === 'edit') expect(outcome).toBeInstanceOf(DocumentNotFoundError);
      else expect(outcome).toBe('resolved');
      expect(transitionsOf(DOC_A)).toEqual([]);
      expect(started).not.toHaveBeenCalled();
      // 새 버전 데이터는 다시 지워진다
      expect(docOf(h.db, DOC_A).purged).toBe(true);
      expect(versionRows(DOC_A)).toBe(0);
      // ★ 선점 때 넣은 대기열은 삭제와 같은 갱신에서 빠졌고 되살아나지 않는다 (REQ-BE-1.10.7)
      expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();
      await runScheduled();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );

  it('T-FU-ORDER-6 재색인은 다시 읽어 삭제됨이면 captioning 조건부 갱신이 성공할 상태여도 기록·처리 시작이 없다', async () => {
    await expectReindexStopsOn('deleted');
  });
});

describe('REQ-BE-1.3.9', () => {
  /** 처리 상태가 다른 문서 여섯을 시드한다. 대기열 문서(A)·RAG 접수 색인 대기(B)·그 밖 */
  async function seedStates(): Promise<void> {
    const specs: Array<[string, Partial<DocumentRecord>]> = [
      [DOC_A, { processingState: 'queued', queuedVersion: '1' }],
      [DOC_B, { processingState: 'queued', queuedVersion: null }],
      [DOC_C, { processingState: 'completed' }],
      [DOC_D, { processingState: 'uploaded' }],
      [uid(5), { processingState: 'indexing' }],
      [uid(6), { processingState: 'failed' }],
    ];
    await seed(
      h.db,
      specs.map(([docId, over], index) => docRecord({ docId, name: `n${index}`, ...over })),
      specs.map(([docId]) => versionRecord({ docId, failure: null })),
    );
  }

  it('T-LIST-Q1 대기열 색인 대기 문서는 in_index_queue 참, RAG 접수 색인 대기는 거짓이고 둘 다 다음 KST 00:00을 주며 그 밖은 둘 다 null이다', async () => {
    // 가짜 벽시계: 2026-10-09T03:00:00Z (KST 12:00)
    await boot({ clock: createFakeClock() });
    await seedStates();
    const page = await h.service.list(listQuery());
    const byId = new Map(page.items.map((item) => [item.doc_id, item]));
    const nextKst0 = '2026-10-09T15:00:00Z';
    expect(byId.get(DOC_A)).toMatchObject({ in_index_queue: true, next_index_at: nextKst0 });
    expect(byId.get(DOC_B)).toMatchObject({ in_index_queue: false, next_index_at: nextKst0 });
    for (const docId of [DOC_C, DOC_D, uid(5), uid(6)]) {
      expect(byId.get(docId)).toMatchObject({ in_index_queue: null, next_index_at: null });
    }
    // ★ 키 순서: failure_message 다음 in_index_queue, next_index_at, uploaded_at
    const keys = Object.keys(page.items[0]);
    expect(
      keys.slice(keys.indexOf('failure_message'), keys.indexOf('failure_message') + 4),
    ).toEqual(['failure_message', 'in_index_queue', 'next_index_at', 'uploaded_at']);
  });

  it('T-LIST-Q1b INDEX_SCHEDULE_CRON을 바꾸면 그 일정의 다음 시각을 주고 시계가 지나면 다음 날이 된다', async () => {
    const clock = createFakeClock();
    await boot({ clock, config: { INDEX_SCHEDULE_CRON: '30 6 * * *' } });
    await seedStates();
    const first = await h.service.list(listQuery());
    // KST 12:00 이후 첫 06:30은 다음 날(KST 10-10 06:30 = 10-09T21:30Z)이다
    expect(first.items.find((item) => item.doc_id === DOC_A)?.next_index_at).toBe(
      '2026-10-09T21:30:00Z',
    );
    // 벽시계가 KST 10-10 07:00(10-09T22:00Z)이 되면 그다음 날이다
    clock.setWall('2026-10-09T22:00:00Z');
    const second = await h.service.list(listQuery());
    expect(second.items.find((item) => item.doc_id === DOC_A)?.next_index_at).toBe(
      '2026-10-10T21:30:00Z',
    );
  });
});

describe('REQ-BE-1.4.6', () => {
  it('T-GET-Q1 대기열 문서는 in_index_queue 참과 다음 예약 시각을 주고 완료 문서는 둘 다 null이다', async () => {
    await boot({ clock: createFakeClock() });
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'queued', queuedVersion: '1' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'queued', queuedVersion: null }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'completed' }),
      ],
      [
        versionRecord({ docId: DOC_A, jobId: null, result: null }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C }),
      ],
    );
    expect(await h.service.getDetail(DOC_A)).toMatchObject({
      in_index_queue: true,
      next_index_at: '2026-10-09T15:00:00Z',
    });
    expect(await h.service.getDetail(DOC_B)).toMatchObject({
      in_index_queue: false,
      next_index_at: '2026-10-09T15:00:00Z',
    });
    expect(await h.service.getDetail(DOC_C)).toMatchObject({
      in_index_queue: null,
      next_index_at: null,
    });
  });
});

describe('REQ-BE-1.10.2', () => {
  it('T-RQ-ATOM-1 requeue 2단계는 처리 상태와 queuedVersion을 갱신 하나로 쓴다', async () => {
    await seedFailed();
    const calls = watchUpdates();
    await h.service.requeue(DOC_A);
    // ★ 문서 갱신은 정확히 한 번이고, 그 갱신 하나가 두 필드를 함께 쓴다
    const docUpdates = calls.filter((call) => call.collection === 'documents');
    expect(docUpdates).toHaveLength(1);
    expect(docUpdates[0].update.$set).toMatchObject({
      processingState: 'queued',
      queuedVersion: '1',
    });
    expect(docOf(h.db, DOC_A)).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
  });

  it('T-RQ-ATOM-1 조건이 어긋나면(사이에 처리 상태가 바뀜) 둘 다 그대로이고 잠김 오류다', async () => {
    await seedFailed();
    // ★ 1단계 뒤·2단계 전에 문서가 색인 중으로 바뀐다
    watchUpdates({
      before: async (call, _n, raw) => {
        if (call.collection !== 'documents') return;
        await raw('documents', { docId: DOC_A }, { $set: { processingState: 'indexing' } });
      },
    });
    await expect(h.service.requeue(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('indexing');
    expect(doc.queuedVersion).toBeNull();
    // 3단계(실패 사유 비우기)도 하지 않았다. 처리 상태 기록도 없다
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(FAILURE);
    expect(transitionsOf(DOC_A)).toEqual([]);
  });
});

describe('REQ-BE-1.10.4', () => {
  /** 대기열 문서(버전 1, 대기열 안)를 시드한다. t1의 지금 문장은 '기존'이다. */
  async function seedQueued(): Promise<void> {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, name: '문서', processingState: 'queued', queuedVersion: '1' })],
      [versionRecord({ docId: DOC_A, jobId: null, result: null })],
    );
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: HINT_SENT }]);
  }

  it('T-Q-EDIT-1 대기열 문서의 요약·캡션 편집은 새 버전을 만들고 대기열의 이전 버전을 새 버전으로 바꾸며 색인 요청은 없다', async () => {
    await seedQueued();
    await h.service.edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }));
    await h.drain();
    expect(versionOf(h.db, DOC_A, '2')?.origin).toBe('hints');
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.latestVersion).toBe('2');
    // ★ 이전 버전(1)은 대기열에서 빠지고 새 버전(2)이 들어간다
    expect(doc.queuedVersion).toBe('2');
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    // 색인 대기 → 색인 대기이므로 처리 상태 기록이 없다
    expect(transitionsOf(DOC_A)).toEqual([]);

    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0].version).toBe('2');
  });

  it('T-Q-CONT-1 대기열 문서의 내용 다시 올리기는 대기열을 비우고 업로드됨으로 둔다', async () => {
    await seedQueued();
    await h.service.uploadContents(DOC_A, [md]);
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('uploaded');
    expect(doc.queuedVersion).toBeNull();
    expect(doc.latestVersion).toBe('2');
    expect(transitionsOf(DOC_A)).toEqual([['queued', 'uploaded']]);
    // ★ 처리가 끝나면 새 버전이 대기열에 들어가고, 예약 색인은 새 버전만 요청한다
    await h.drain();
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('2');
    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0].version).toBe('2');
  });

  it.each([
    ['요약·캡션 편집', 'edit'],
    ['내용 다시 올리기', 'upload'],
  ] as const)(
    'T-Q-ROLL-1 대기열 문서의 %s에서 새 버전 만들기가 실패하면 처리 상태·대기열·마지막 버전이 이전 버전으로 되돌아간다',
    async (_label, path) => {
      await seedQueued();
      const before = docOf(h.db, DOC_A);
      let run: () => Promise<unknown>;
      if (path === 'edit') {
        h.assets.inheritVersion.mockRejectedValueOnce(new Error('boom'));
        run = () =>
          h.service.edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }));
      } else {
        h.assets.prepareVersion.mockRejectedValueOnce(new Error('boom'));
        run = () => h.service.uploadContents(DOC_A, [md]);
      }
      await expect(run()).rejects.toThrow('boom');
      await h.drain();

      const after = docOf(h.db, DOC_A);
      expect(after.processingState).toBe('queued');
      // ★ 대기열을 요청 전과 같게 되돌린다
      expect(after.queuedVersion).toBe('1');
      expect(after.latestVersion).toBe('1');
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
      expect(transitionsOf(DOC_A)).toEqual([]);

      await runScheduled();
      expect(requestsOf(DOC_A)).toHaveLength(1);
      expect(requestsOf(DOC_A)[0].version).toBe('1');
    },
  );

  it.each([
    ['요약·캡션 편집', 'edit'],
    ['내용 다시 올리기', 'upload'],
  ] as const)(
    'T-Q-ROLL-2 대기열 문서의 %s 도중 삭제되면 되돌리기가 비워진 대기열을 되살리지 않는다',
    async (_label, path) => {
      await seedQueued();
      const held = path === 'edit' ? await holdEdit() : await holdUpload();
      // ★ 선점으로 대기열이 새 버전으로 바뀐 상태에서 삭제가 대기열을 비운다
      await h.service.remove(DOC_A);
      expect(docOf(h.db, DOC_A).queuedVersion).toBeNull();

      held.gate.reject(new Error('boom'));
      expect(await held.outcome).toMatchObject({ message: 'boom' });
      await h.drain();

      const doc = docOf(h.db, DOC_A);
      expect(doc.deleted).toBe(true);
      expect(doc.queuedVersion).toBeNull();
      await runScheduled();
      expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    },
  );
});

describe('REQ-BE-1.10.5', () => {
  it('T-RQ-1 실패 문서를 색인 대기로 바꾸면 새 버전 없이 마지막 버전을 대기열에 넣고 작업 ID·실패 사유를 비우며 다음 예약 색인이 요청한다', async () => {
    await seedFailed({ docId: DOC_A, name: 'A' });
    // 재색인 버전(origin reindex)은 강제 재색인으로 요청한다 (REQ-BE-1.10.1)
    await seedFailed({ docId: DOC_B, name: 'B' }, { origin: 'reindex' });
    const before = docOf(h.db, DOC_A);

    await h.service.requeue(DOC_A);
    await h.service.requeue(DOC_B);

    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
    expect(doc.latestVersion).toBe('1');
    // ★ 편집·내용 변경이 아니므로 수정 시각을 바꾸지 않는다
    expect(doc.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(versionRows(DOC_A)).toBe(1);
    const version = versionOf(h.db, DOC_A, '1');
    expect(version?.jobId).toBeNull();
    expect(version?.failure).toBeNull();
    expect(version?.requestSeq).toBe(1);
    expect(transitionsOf(DOC_A)).toEqual([['failed', 'queued']]);
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();

    await runScheduled();
    expect(requestsOf(DOC_A)).toHaveLength(1);
    expect(requestsOf(DOC_A)[0]).toMatchObject({ version: '1', force: false });
    expect(requestsOf(DOC_B)).toHaveLength(1);
    expect(requestsOf(DOC_B)[0]).toMatchObject({ version: '1', force: true });
  });

  it('T-RQ-ORDER-1 갱신 순서는 버전(작업 ID 비우기 + requestSeq 증가) → 문서(상태+대기열) → 버전(기억한 실패 사유 조건으로 비우기)다', async () => {
    await seedFailed();
    const calls = watchUpdates();
    await h.service.requeue(DOC_A);

    expect(calls.map((call) => call.collection)).toEqual([
      'document_versions',
      'documents',
      'document_versions',
    ]);
    // 1단계: 같은 갱신 하나로 작업 ID 비우기와 requestSeq 늘리기
    expect(calls[0].filter).toMatchObject({ docId: DOC_A, version: '1' });
    expect(calls[0].update).toEqual({ $set: { jobId: null }, $inc: { requestSeq: 1 } });
    // 2단계: failed이고 마지막 버전이 읽은 값일 때만, 상태와 대기열을 한 갱신으로
    expect(calls[1].filter).toMatchObject({
      docId: DOC_A,
      processingState: 'failed',
      latestVersion: '1',
    });
    expect(calls[1].update.$set).toMatchObject({ processingState: 'queued', queuedVersion: '1' });
    // 3단계: 기억한 실패 사유와 같을 때만 비운다 — 조건의 표기 방식은 정하지 않고 행동은 T-RQ-RACE-1이 본다
    expect(calls[2].filter).toMatchObject({ docId: DOC_A, version: '1' });
    expect(calls[2].update).toEqual({ $set: { failure: null } });
  });

  it('T-RQ-STOP-1 1단계 뒤 멈추면(2단계 갱신이 던짐) 처리 상태는 실패 그대로이고 작업 ID는 null, requestSeq는 1 늘어 있다', async () => {
    await seedFailed();
    watchUpdates({
      before: async (call) => {
        if (call.collection === 'documents') throw new Error('stage2 boom');
      },
    });
    await expect(h.service.requeue(DOC_A)).rejects.toThrow('stage2 boom');

    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('failed');
    expect(doc.queuedVersion).toBeNull();
    const version = versionOf(h.db, DOC_A, '1');
    expect(version?.jobId).toBeNull();
    expect(version?.requestSeq).toBe(1);
    // 실패 사유는 그대로다
    expect(version?.failure).toEqual(FAILURE);
    expect(transitionsOf(DOC_A)).toEqual([]);
  });

  it('T-RQ-STOP-2 2단계 뒤 멈추면(3단계가 던짐) 조회의 failure가 null이다 — 처리 상태가 색인 대기라 실패 사유를 주지 않는다', async () => {
    await seedFailed();
    watchUpdates({
      before: async (_call, n) => {
        if (n === 3) throw new Error('stage3 boom');
      },
    });
    await expect(h.service.requeue(DOC_A)).rejects.toThrow('stage3 boom');

    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
    // 실패 사유는 비우지 못해 남아 있다
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(FAILURE);
    const detail = await h.service.getDetail(DOC_A);
    expect(detail.processing_state).toBe('queued');
    expect(detail.failure).toBeNull();
  });

  it('T-RQ-LATE-1 다시 대기열에 넣은 뒤 늦게 온 지난 요청의 accepted 결과는 작업 ID를 쓰지 못한다', async () => {
    // 대기열 문서의 색인 요청이 나가 응답을 기다리는 중이다 (requestSeq 0을 읽었다)
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'queued', queuedVersion: '1' })],
      [versionRecord({ docId: DOC_A, jobId: null, result: null })],
    );
    const gate = deferred<IndexRequestOutcome>();
    h.indexing.requestIndex.mockImplementationOnce(() => gate.promise);
    const running = h.lifecycle.runScheduledIndex();
    await waitUntil(() => h.indexing.requestIndex.mock.calls.length > 0);

    // ★ 그사이 문서가 실패로 바뀌었다가 Console의 요청으로 다시 대기열에 들어간다 (requestSeq 1)
    await h.db
      .collection('documents')
      .updateOne({ docId: DOC_A }, { $set: { processingState: 'failed', queuedVersion: null } });
    await h.db
      .collection('document_versions')
      .updateOne({ docId: DOC_A, version: '1' }, { $set: { failure: FAILURE } });
    await h.service.requeue(DOC_A);
    expect(versionOf(h.db, DOC_A, '1')?.requestSeq).toBe(1);

    gate.resolve({ kind: 'accepted', jobId: 'job-late' });
    await running;
    await h.drain();

    // 지난 요청의 결과라 작업 ID를 쓰지 못하고 대기열도 건드리지 못한다
    expect(versionOf(h.db, DOC_A, '1')?.jobId).toBeNull();
    const doc = docOf(h.db, DOC_A);
    expect(doc.processingState).toBe('queued');
    expect(doc.queuedVersion).toBe('1');
  });

  it('T-RQ-RACE-1 2단계와 3단계 사이에 다른 실패 사유가 쓰이면 3단계가 지우지 않는다', async () => {
    await seedFailed();
    const other = { code: 'OTHER', message: '다른 사유', headingPath: null, placeholderId: null };
    watchUpdates({
      after: async (call, _n, raw) => {
        if (call.collection !== 'documents') return;
        await raw(
          'document_versions',
          { docId: DOC_A, version: '1' },
          { $set: { failure: other } },
        );
      },
    });
    await h.service.requeue(DOC_A);

    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
    expect(versionOf(h.db, DOC_A, '1')?.failure).toEqual(other);
  });

  it('T-RQ-EVT-1 1단계 뒤·2단계 전에 지난 작업의 성공·실패 이벤트가 와도 처리 상태가 실패 그대로다', async () => {
    await seedFailed();
    let during: { state: string; failure: unknown; result: unknown; records: number } | null = null;
    let fired = false;
    watchUpdates({
      before: async (call) => {
        if (call.collection !== 'documents' || fired) return;
        fired = true;
        // 지난 작업(job-old)의 이벤트가 2단계 직전에 도착한다
        await h.lifecycle.onJobStateChanged(
          jobEvent({ docId: DOC_A, version: '1', jobId: 'job-old', jobState: 'succeeded' }),
        );
        await h.lifecycle.onJobStateChanged(
          jobEvent({
            docId: DOC_A,
            version: '1',
            jobId: 'job-old',
            jobState: 'failed',
            searchableVersion: null,
            result: null,
            failure: { code: 'X', message: '다른 실패', headingPath: null, placeholderId: null },
          }),
        );
        const doc = docOf(h.db, DOC_A);
        const version = versionOf(h.db, DOC_A, '1');
        during = {
          state: doc.processingState,
          failure: version?.failure,
          result: version?.result,
          records: transitionsOf(DOC_A).length,
        };
      },
    });
    await h.service.requeue(DOC_A);

    expect(fired).toBe(true);
    // ★ 이벤트는 처리 상태·결과·실패 사유를 바꾸지 않았고 기록도 남기지 않았다
    expect(during).toEqual({ state: 'failed', failure: FAILURE, result: null, records: 0 });
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
    expect(transitionsOf(DOC_A)).toEqual([['failed', 'queued']]);
  });
});

describe('REQ-BE-1.10.6', () => {
  const cases: Array<[string, Partial<DocumentRecord>]> = [
    ['completed', { processingState: 'completed' }],
    ['queued(대기열 안)', { processingState: 'queued', queuedVersion: '1' }],
    ['queued(대기열 밖)', { processingState: 'queued', queuedVersion: null }],
    ['indexing', { processingState: 'indexing' }],
    ['uploaded', { processingState: 'uploaded' }],
    ['captioning', { processingState: 'captioning' }],
  ];

  it.each(cases)(
    'T-RQ-LOCK-1 처리 상태가 %s인 문서의 requeue는 잠김 오류이고 상태·대기열·버전이 그대로다',
    async (_label, over) => {
      await seedDoc({ docId: DOC_A, ...over });
      const docBefore = h.db.dump('documents');
      const versionsBefore = h.db.dump('document_versions');
      await expect(h.service.requeue(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
      expect(h.db.dump('documents')).toEqual(docBefore);
      // ★ requestSeq·jobId를 포함해 버전 레코드가 그대로다
      expect(h.db.dump('document_versions')).toEqual(versionsBefore);
      expect(h.logs.record).not.toHaveBeenCalled();
    },
  );

  it('T-RQ-LOCK-1 없는 문서와 삭제된 문서는 없는 문서 오류다', async () => {
    await seedFailed({ docId: DOC_A, deleted: true });
    await expect(h.service.requeue(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(h.service.requeue(DOC_B)).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(versionOf(h.db, DOC_A, '1')?.requestSeq).toBe(0);
  });
});

describe('REQ-BE-1.8.6', () => {
  it('T-DEL-5 삭제·데이터 삭제 뒤에도 getRef는 이름·판과 삭제 여부를 준다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서', edition: ed('v1') });
    await h.service.remove(DOC_A);
    await h.drain();
    expect(await h.service.getRef(DOC_A)).toEqual({
      docId: DOC_A,
      name: '문서',
      edition: ed('v1'),
      deleted: true,
    });
  });

  it('T-Q-3 없는 문서는 null이고 삭제된 문서는 deleted 참으로 준다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서', deleted: true });
    expect(await h.service.getRef(DOC_B)).toBeNull();
    expect(await h.service.getRef(DOC_A)).toMatchObject({ deleted: true, name: '문서' });
  });
});

describe('REQ-BE-4.1.2', () => {
  it('T-Q-1 이름들로 보이는 문서 ID만 중복 없이 준다', async () => {
    await seed(h.db, [
      docRecord({ docId: DOC_A, name: '가', uploadedAt: new Date('2026-10-01T00:00:00Z') }),
      docRecord({ docId: DOC_B, name: '가', searchState: 'replaced' }),
      docRecord({ docId: DOC_C, name: '가', deleted: true }),
      docRecord({ docId: DOC_D, name: '나', uploadedAt: new Date('2026-10-02T00:00:00Z') }),
    ]);
    const ids = await h.service.resolveNames(['가', '가', '나']);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([DOC_A, DOC_D]));
    const before = findCalls();
    expect(await h.service.resolveNames([])).toEqual([]);
    expect(findCalls()).toBe(before);
  });
});

describe('REQ-BE-4.2.2', () => {
  it('T-Q-2 받은 ID 중 삭제됨·교체됨·없는 ID를 뺀다', async () => {
    await seed(h.db, [
      docRecord({ docId: DOC_A }),
      docRecord({ docId: DOC_B, deleted: true }),
      docRecord({ docId: DOC_C, searchState: 'replaced' }),
    ]);
    expect(await h.service.visibleDocIds([DOC_A, DOC_B, DOC_C, DOC_D])).toEqual(new Set([DOC_A]));
    expect(await h.service.visibleDocIds([])).toEqual(new Set());
  });
});

describe('REQ-BE-5.1.5', () => {
  it('T-Q-4 평가 대상은 검색되는 버전의 색인용 MD를 준다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, latestVersion: '3', searchableVersion: '2' }),
        docRecord({
          docId: DOC_B,
          searchState: 'not_searchable',
          searchableVersion: null,
          processingState: 'uploaded',
        }),
      ],
      [
        versionRecord({ docId: DOC_A, version: '1', indexingMarkdown: 'IDX1' }),
        versionRecord({ docId: DOC_A, version: '2', indexingMarkdown: 'IDX2' }),
        versionRecord({ docId: DOC_A, version: '3', indexingMarkdown: 'IDX3' }),
        versionRecord({ docId: DOC_B }),
      ],
    );
    const target = await h.service.getEvaluationTarget(DOC_A);
    expect(target?.searchableIndexingMarkdown).toBe('IDX2');
    expect(target?.searchState).toBe('searchable');
    expect((await h.service.getEvaluationTarget(DOC_B))?.searchableIndexingMarkdown).toBeNull();
    expect(await h.service.getEvaluationTarget(DOC_C)).toBeNull();
  });
});

/** 기록·로그 흐름이 만든 문서 ID들이다. */
interface FlowIds {
  first: string;
  second: string;
  third: string;
  fourth: string;
}

/**
 * 업로드 → 완료 → 이름 편집 → 요약·캡션 편집 → 내용 다시 올리기 → 같은 판 교체 → 삭제 → 거부 → 실패를 돌린다.
 * 센티널(이름·판 표기·판 날짜·MD·파일 이름·요약·캡션·실패 사유)을 모두 쓴다.
 */
async function runLogFlow(): Promise<FlowIds> {
  const done = async (docId: string, version: string): Promise<void> => {
    await h.drain();
    // ★ 색인 요청은 예약 색인만 한다. 요청이 가야 버전에 작업 ID(job-new)가 기록된다 (REQ-BE-1.10.1)
    await h.scheduler.runScheduledIndex();
    await h.drain();
    await h.lifecycle.onJobStateChanged(
      // ★ 흐름의 가짜 요청은 버전에 'job-new'를 기록한다. 이벤트 jobId가 다르면 무시된다 (REQ-BE-1.9.6)
      jobEvent({
        docId,
        version,
        jobId: 'job-new',
        jobState: 'succeeded',
        searchableVersion: version,
      }),
    );
  };
  h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
  h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: HINT_SENT }]);
  const edition = { label: LABEL_SENT, edition_date: DATE_SENT };
  const renamed = `${NAME_SENT}-b`;

  // 1. 첫 문서 업로드와 완료
  const up1 = await h.service.upload(
    [uploadFile(FILE_SENT, MD_SENT)],
    [{ file_name: FILE_SENT, name: NAME_SENT, edition }],
  );
  const first = up1.documents[0].doc_id;
  await done(first, '1');
  // 2. 이름 편집, 요약·캡션 편집
  await h.service.edit(first, editBody({ name: renamed }));
  await h.drain();
  await h.service.edit(first, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }));
  await done(first, '2');
  // 3. 내용 다시 올리기
  await h.service.uploadContents(first, [uploadFile(FILE_SENT, `${MD_SENT} 둘째`)]);
  await done(first, '3');
  // 4. 같은 판 문서가 검색 가능해져 첫 문서가 교체된다
  const up2 = await h.service.upload(
    [uploadFile('second.md', MD_SENT)],
    [{ file_name: 'second.md', name: renamed, edition }],
  );
  const second = up2.documents[0].doc_id;
  await done(second, '1');
  // 5. 삭제
  await h.service.remove(second);
  await h.drain();
  // 6. 거부되는 요청(기록이 없어야 한다)
  // ★ 대기열에 든 queued 문서는 편집을 받으므로(REQ-BE-1.5.5) 셋째 문서는 표·이미지 처리(captioning)에서 멈춰 둔 채 잠긴 상태를 확정한다
  const hintsGate = deferred<{ generated: number; temporary: number; stopped: boolean }>();
  const hintCalls = h.assets.generateHints.mock.calls.length;
  h.assets.generateHints.mockImplementationOnce(() => hintsGate.promise);
  const third = (
    await h.service.upload(
      [uploadFile('third.md', MD_SENT)],
      [{ file_name: 'third.md', name: `${NAME_SENT}-c` }],
    )
  ).documents[0].doc_id;
  await waitUntil(() => h.assets.generateHints.mock.calls.length > hintCalls);
  await expect(
    h.service.upload([uploadFile('bad.pdf', 'x')], [{ file_name: 'bad.pdf', name: 'x' }]),
  ).rejects.toBeInstanceOf(UnsupportedFileError);
  await expect(h.service.edit(third, editBody({ name: '잠김' }))).rejects.toBeInstanceOf(
    DocumentLockedError,
  );
  hintsGate.resolve({ generated: 0, temporary: 0, stopped: false });
  await h.drain();
  // 7. 실패 이벤트
  const fourth = (
    await h.service.upload(
      [uploadFile('fourth.md', MD_SENT)],
      [{ file_name: 'fourth.md', name: `${NAME_SENT}-d` }],
    )
  ).documents[0].doc_id;
  await h.drain();
  await h.scheduler.runScheduledIndex();
  await h.drain();
  await h.lifecycle.onJobStateChanged(
    jobEvent({
      docId: fourth,
      // ★ 흐름의 가짜 요청은 버전에 'job-new'를 기록한다. 이벤트 jobId가 다르면 무시된다 (REQ-BE-1.9.6)
      jobId: 'job-new',
      jobState: 'failed',
      searchableVersion: null,
      result: null,
      failure: {
        code: 'PARSE_FAILED',
        message: FAILMSG_SENT,
        headingPath: null,
        placeholderId: null,
      },
    }),
  );
  await h.drain();
  return { first, second, third, fourth };
}

describe('REQ-BE-6.1.1', () => {
  it('T-LOGR-1 단계마다 기록 종류·결과·상세가 명세와 같고 거부된 요청은 기록이 없다', async () => {
    const ids = await runLogFlow();
    const success = 'success' as const;
    const state = (from: string, to: string) => ({ fromState: from, toState: to });
    const rec = (
      kind: string,
      name: string,
      detail: Record<string, unknown> | null,
      outcome: 'success' | 'failure' = success,
    ) => ({ kind, name, editionLabel: LABEL_SENT, outcome, detail });
    const renamed = `${NAME_SENT}-b`;

    // ★ 서로 다른 종류의 기록 사이 순서는 정하지 않는다. 문서·종류별로 걸러 비교한다
    const ofKind = (docId: string, kind: string) =>
      recordsFor(docId).filter((record) => record.kind === kind);
    // ★ 색인 요청은 예약 색인이 한다. 접수(accepted)는 처리 상태를 바꾸지 않으므로 기록이 없고,
    //   queued → completed 기록은 예약 색인 실행 뒤에 오는 성공 알림이 남긴다 (runLogFlow의 done)
    expect(ofKind(ids.first, 'upload')).toEqual([rec('upload', NAME_SENT, null)]);
    expect(ofKind(ids.first, 'processing_state')).toEqual([
      rec('processing_state', NAME_SENT, state('uploaded', 'captioning')),
      rec('processing_state', NAME_SENT, state('captioning', 'queued')),
      rec('processing_state', NAME_SENT, state('queued', 'completed')),
      rec('processing_state', renamed, state('completed', 'queued')),
      rec('processing_state', renamed, state('queued', 'completed')),
      rec('processing_state', renamed, state('completed', 'uploaded')),
      rec('processing_state', renamed, state('uploaded', 'captioning')),
      rec('processing_state', renamed, state('captioning', 'queued')),
      rec('processing_state', renamed, state('queued', 'completed')),
    ]);
    expect(ofKind(ids.first, 'edit')).toEqual([
      rec('edit', renamed, { changedFields: ['name'] }),
      rec('edit', renamed, { changedFields: ['hints'] }),
    ]);
    expect(ofKind(ids.first, 'content_upload')).toEqual([rec('content_upload', renamed, null)]);
    expect(ofKind(ids.first, 'replace')).toEqual([
      rec('replace', renamed, { replacedByDocId: ids.second }),
    ]);
    expect(recordsFor(ids.first)).toHaveLength(14);
    const secondKinds = recordsFor(ids.second).map((r) => r.kind);
    expect(secondKinds.filter((kind) => kind === 'upload')).toHaveLength(1);
    expect(secondKinds.filter((kind) => kind === 'processing_state')).toHaveLength(3);
    expect(secondKinds.filter((kind) => kind === 'delete')).toHaveLength(1);
    expect(secondKinds).toHaveLength(5);
    // 거부된 요청(형식 오류·잠금)은 기록이 없다. 셋째 문서는 업로드 기록뿐이다
    expect(recordsFor(ids.third).filter((r) => r.kind !== 'processing_state')).toEqual([
      {
        kind: 'upload',
        name: `${NAME_SENT}-c`,
        editionLabel: null,
        outcome: success,
        detail: null,
      },
    ]);
    expect(h.logs.recordsOf('edit').filter((r) => r.docId === ids.third)).toHaveLength(0);
    // 실패 이벤트는 실패 기록과 사유 코드를 남긴다
    const failed = recordsFor(ids.fourth).at(-1);
    expect(failed).toMatchObject({
      kind: 'processing_state',
      outcome: 'failure',
      detail: { fromState: 'queued', toState: 'failed', reasonCode: 'PARSE_FAILED' },
    });
  });
});

describe('REQ-BE-8.2.1', () => {
  /** pino가 넣는 기본 필드다. */
  const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
  /** MODULE.md 「로그」 표의 이벤트별 허용 필드다. 줄은 이 안의 부분집합이어야 한다. */
  const ALLOWED_KEYS: Record<string, string[]> = {
    'documents.state_changed': ['docId', 'version', 'from', 'to', 'searchState'],
    'documents.replaced': ['docId', 'replacedBy'],
    'documents.processing_stopped': ['docId', 'version', 'reason'],
    'documents.resume': ['captioning', 'reconciled', 'recovered'],
    'documents.task_failed': ['task', 'docId', 'errorName'],
    'documents.index_scheduled': ['requested', 'unreachable'],
    // ★ 오지 않는 일정의 경고는 키 이름만 담는다 — 표현식 값은 넣지 않는다 (P-3)
    'documents.index_schedule_unavailable': ['key'],
  };
  const STOP_REASONS = ['deleted', 'replaced', 'superseded', 'shutdown', 'state_changed'];
  const TASKS = [
    'process',
    'scheduled_index',
    'delete_chunks',
    'metadata',
    'resume',
    'reconcile',
    'rag_retry',
  ];

  const SENTINELS = [
    NAME_SENT,
    LABEL_SENT,
    MD_SENT,
    HINT_SENT,
    FILE_SENT,
    FAILMSG_SENT,
    IDX_SENT,
    DATE_SENT,
  ];

  /** documents 로그 줄만 모은다. */
  const documentLines = () =>
    capture
      .parsed()
      .filter((line) => typeof line.msg === 'string' && line.msg.startsWith('documents.'));

  /** 줄의 키가 그 이벤트의 허용 필드 안에 있는지 본다. */
  function expectAllowedKeys(line: Record<string, unknown>): void {
    const msg = line.msg as string;
    expect(Object.keys(ALLOWED_KEYS)).toContain(msg);
    const keys = Object.keys(line).filter((key) => !PINO_BASE.includes(key));
    expect([msg, keys.filter((key) => !ALLOWED_KEYS[msg].includes(key))]).toEqual([msg, []]);
  }

  it('T-LOGH-1 센티널이 로그에 없고 documents 로그는 허용 필드 안의 값만 담는다', async () => {
    await runLogFlow();
    for (const sentinel of SENTINELS) expect(capture.lines.join('\n')).not.toContain(sentinel);
    const docLines = documentLines();
    expect(docLines.length).toBeGreaterThan(0);
    for (const line of docLines) expectAllowedKeys(line);
    expect(docLines.some((line) => line.msg === 'documents.state_changed')).toBe(true);
    expect(docLines.some((line) => line.msg === 'documents.replaced')).toBe(true);
  });

  it('T-LOGH-2 기동 처리·처리 중단·작업 실패 줄도 허용 필드만 담고 센티널이 없다', async () => {
    // 기동 처리: 표·이미지 처리를 이을 문서가 있는 경우
    await seed(
      h.db,
      [docRecord({ docId: DOC_B, name: NAME_SENT, processingState: 'captioning' })],
      [versionRecord({ docId: DOC_B, jobId: null })],
    );
    await h.scheduler.resume();
    await h.drain();
    // 작업 실패: 요약·캡션 만들기가 센티널 문장의 오류로 실패한다
    h.assets.generateHints.mockRejectedValueOnce(new Error(FAILMSG_SENT));
    await h.service.upload(
      [uploadFile(FILE_SENT, MD_SENT)],
      [
        {
          file_name: FILE_SENT,
          name: NAME_SENT,
          edition: { label: LABEL_SENT, edition_date: DATE_SENT },
        },
      ],
    );
    await h.drain();
    // 처리 중단: 요약·캡션을 만드는 동안 삭제한다
    const gate = deferred<{ generated: number; temporary: number; stopped: boolean }>();
    const calls = h.assets.generateHints.mock.calls.length;
    h.assets.generateHints.mockImplementationOnce(() => gate.promise);
    const second = await h.service.upload(
      [uploadFile('stop.md', MD_SENT)],
      [{ file_name: 'stop.md', name: `${NAME_SENT}-s` }],
    );
    await waitUntil(() => h.assets.generateHints.mock.calls.length > calls);
    await h.service.remove(second.documents[0].doc_id);
    gate.resolve({ generated: 0, temporary: 0, stopped: false });
    await h.drain();

    for (const sentinel of SENTINELS) expect(capture.lines.join('\n')).not.toContain(sentinel);
    const lines = documentLines();
    for (const line of lines) expectAllowedKeys(line);
    const of = (msg: string) => lines.filter((line) => line.msg === msg);
    expect(of('documents.resume')).toHaveLength(1);
    expect(of('documents.task_failed').length).toBeGreaterThan(0);
    for (const line of of('documents.task_failed')) {
      expect(TASKS).toContain(line.task);
      expect(line.errorName).toBe('Error');
    }
    expect(of('documents.processing_stopped').length).toBeGreaterThan(0);
    for (const line of of('documents.processing_stopped')) {
      expect(STOP_REASONS).toContain(line.reason);
    }
  });

  it('T-LOGH-2 예약 색인 줄(index_scheduled)과 한 문서의 요청 실패 줄(task_failed, scheduled_index)도 허용 필드만 담고 센티널이 없다', async () => {
    // 대기열 문서 둘 — 하나의 요청은 센티널 문장의 오류로 실패한다
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_C, processingState: 'queued', queuedVersion: '1' }),
        docRecord({ docId: DOC_D, processingState: 'queued', queuedVersion: '1' }),
      ],
      [versionRecord({ docId: DOC_C, jobId: null }), versionRecord({ docId: DOC_D, jobId: null })],
    );
    h.indexing.requestIndex.mockRejectedValueOnce(new Error(FAILMSG_SENT));
    await h.scheduler.runScheduledIndex();
    await h.drain();

    for (const sentinel of SENTINELS) expect(capture.lines.join('\n')).not.toContain(sentinel);
    const lines = documentLines();
    for (const line of lines) expectAllowedKeys(line);
    const scheduled = lines.filter((line) => line.msg === 'documents.index_scheduled');
    expect(scheduled).toHaveLength(1);
    expect(typeof scheduled[0].requested).toBe('number');
    expect(typeof scheduled[0].unreachable).toBe('number');
    const failed = lines.filter((line) => line.msg === 'documents.task_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ task: 'scheduled_index', errorName: 'Error' });
    expect([DOC_C, DOC_D]).toContain(failed[0].docId);
  });

  it('T-LOGH-2 오지 않는 일정의 경고(index_schedule_unavailable)는 key만 담고 표현식 값이 없다', async () => {
    const cron = '0 0 31 2 *';
    await boot({ clock: createFakeClock(), config: { INDEX_SCHEDULE_CRON: cron } });
    await expect(Promise.resolve(h.scheduler.onApplicationBootstrap())).resolves.not.toThrow();
    await h.drain();

    const lines = documentLines();
    for (const line of lines) expectAllowedKeys(line);
    const warned = lines.filter((line) => line.msg === 'documents.index_schedule_unavailable');
    expect(warned).toHaveLength(1);
    expect(warned[0].level).toBe(40);
    expect(warned[0].key).toBe('INDEX_SCHEDULE_CRON');
    expect(capture.lines.join('\n')).not.toContain(cron);
  });

  it('T-LOGH-2 기동 처리 줄(resume)에 requeued 필드가 없고 센티널이 없다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: NAME_SENT, processingState: 'queued', queuedVersion: '1' }),
        docRecord({ docId: DOC_B, name: NAME_SENT, processingState: 'captioning' }),
      ],
      [versionRecord({ docId: DOC_A, jobId: null }), versionRecord({ docId: DOC_B, jobId: null })],
    );
    await h.scheduler.resume();
    await h.drain();

    for (const sentinel of SENTINELS) expect(capture.lines.join('\n')).not.toContain(sentinel);
    const resumed = documentLines().filter((line) => line.msg === 'documents.resume');
    expect(resumed).toHaveLength(1);
    expectAllowedKeys(resumed[0]);
    expect(Object.keys(resumed[0])).not.toContain('requeued');
    // ★ 기동 처리는 색인을 요청하지 않는다 (REQ-BE-1.10.8)
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.10.5', () => {
  it('T-LEGACY-3 requestSeq 필드가 없는 옛 failed 버전도 requeue가 성공하고 requestSeq가 1이 된다', async () => {
    const version: Partial<DocumentVersionRecord> = versionRecord({
      docId: DOC_A,
      jobId: 'job-old',
      result: null,
      failure: FAILURE,
    });
    delete version.requestSeq;
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'failed', queuedVersion: null })],
      [version as DocumentVersionRecord],
    );
    await h.service.requeue(DOC_A);
    // ★ requestSeq: 0 조건으로 쓰면 필드 없는 레코드와 맞지 않아 requeue가 막힌다
    const after = versionOf(h.db, DOC_A, '1');
    expect(after?.requestSeq).toBe(1);
    expect(after?.jobId).toBeNull();
    expect(after?.failure).toBeNull();
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
    expect(docOf(h.db, DOC_A).queuedVersion).toBe('1');
  });
});

describe('REQ-BE-1.5.5', () => {
  it('T-LEGACY-4 queuedVersion 필드가 없는 queued 문서는 RAG 접수 상태로 읽히고 편집·재색인·requeue가 잠김 오류다', async () => {
    const legacy: Partial<DocumentRecord> = docRecord({
      docId: DOC_A,
      processingState: 'queued',
    });
    delete legacy.queuedVersion;
    await seed(h.db, [legacy as DocumentRecord], [versionRecord({ docId: DOC_A })]);
    const page = await h.service.list(listQuery());
    expect(page.items.find((item) => item.doc_id === DOC_A)?.in_index_queue).toBe(false);
    await expect(h.service.edit(DOC_A, editBody({ name: '새이름' }))).rejects.toBeInstanceOf(
      DocumentLockedError,
    );
    await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
    await expect(h.service.requeue(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
    expect(docOf(h.db, DOC_A).name).toBe(NAME_SENT);
  });
});
