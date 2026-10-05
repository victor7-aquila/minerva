import type { Writable } from 'node:stream';
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type {
  AssetViewData,
  HintContext,
  HintRunResult,
  PreparedVersion,
  UploadedImage,
} from '../../src/assets';
import { AssetsService } from '../../src/assets';
import type { AppConfig } from '../../src/common';
import { DocumentClock } from '../../src/documents/services/document-clock';
import { DocumentLifecycle } from '../../src/documents/services/document-lifecycle.service';
import { DocumentTasks } from '../../src/documents/services/document-tasks';
import { DocumentsCrudService } from '../../src/documents/services/documents-crud.service';
import { DocumentsScheduler } from '../../src/documents/services/documents.scheduler';
import { DocumentsService } from '../../src/documents/services/documents.service';
import type {
  DocumentRecord,
  DocumentVersionRecord,
} from '../../src/documents/interfaces/documents.types';
import type { UploadFile } from '../../src/documents/helpers/upload-files';
import { IndexingService } from '../../src/indexing';
import type {
  IndexJobStateChangedEvent,
  IndexRequestInput,
  IndexRequestOutcome,
} from '../../src/indexing';
import { LogsService } from '../../src/logs';
import type { LogInput, LogKind } from '../../src/logs';
import { RagClient } from '../../src/rag';
import type { RagDocumentChunks, RagJobStage } from '../../src/rag';
import { MONGO_DB } from '../../src/storage';
import { createFakeDb } from './fake-mongo';
import type { FakeDb } from './fake-mongo';
import { createTestCommonModule } from './test-common.module';

/** 로그 비노출 검사용 센티널(이름)이다. */
export const NAME_SENT = 'NAME-SENT-91';
/** 로그 비노출 검사용 센티널(판 표기)이다. */
export const LABEL_SENT = 'LABEL-SENT-92';
/** 로그 비노출 검사용 센티널(MD 본문)이다. */
export const MD_SENT = 'MD-SENT-93';
/** 로그 비노출 검사용 센티널(요약·캡션)이다. */
export const HINT_SENT = 'HINT-SENT-94';
/** 로그 비노출 검사용 센티널(파일 이름)이다. */
export const FILE_SENT = 'FILE-SENT-95.md';
/** 로그 비노출 검사용 센티널(실패 사유 문장)이다. */
export const FAILMSG_SENT = 'FAILMSG-SENT-96';
/** 로그 비노출 검사용 센티널(색인용 MD)이다. */
export const IDX_SENT = 'IDX-SENT-97';
/** 로그 비노출 검사용 센티널(판 날짜)이다. */
export const DATE_SENT = '2099-07-06';

/** 문서 ID 상수 A다(소문자 UUID v4). */
export const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** 문서 ID 상수 B다(소문자 UUID v4). */
export const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** 문서 ID 상수 C다(소문자 UUID v4). */
export const DOC_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** 문서 ID 상수 D다(소문자 UUID v4). */
export const DOC_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** 기본 시각이다. */
const BASE_TIME = '2026-10-01T00:00:00Z';

/** 문서 레코드를 만든다. 기본은 검색 가능·처리 완료 문서다. */
export function docRecord(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    docId: DOC_A,
    name: NAME_SENT,
    edition: null,
    editionEnteredAt: new Date(BASE_TIME),
    searchState: 'searchable',
    processingState: 'completed',
    latestVersion: '1',
    searchableVersion: '1',
    deleted: false,
    pendingRag: { deleteChunks: false, metadata: false },
    purged: false,
    uploadedAt: new Date(BASE_TIME),
    updatedAt: new Date(BASE_TIME),
    ...over,
  };
}

/** 문서 버전 레코드를 만든다. */
export function versionRecord(over: Partial<DocumentVersionRecord> = {}): DocumentVersionRecord {
  return {
    docId: DOC_A,
    version: '1',
    origin: 'upload',
    fileName: FILE_SENT,
    originalMarkdown: MD_SENT,
    indexingMarkdown: IDX_SENT,
    jobId: 'job-1',
    result: { chunkCount: 3, fallbackUsed: false },
    failure: null,
    ...over,
  };
}

/** 가짜 Db의 documents·document_versions에 레코드를 넣는다. */
export async function seed(
  db: FakeDb,
  docs: DocumentRecord[],
  versions: DocumentVersionRecord[] = [],
): Promise<void> {
  for (const doc of docs) await db.collection('documents').insertOne({ ...doc });
  for (const version of versions)
    await db.collection('document_versions').insertOne({ ...version });
}

/** 번호로 문서 ID를 만든다(소문자 UUID v4 모양). */
export function uid(n: number): string {
  return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

/** 판 정보를 만든다. */
export function ed(label: string, editionDate = '2025-01-01'): DocumentRecord['edition'] {
  return { label, editionDate };
}

/** 표 하나짜리 assets 조회 값이다. */
export function tableView(placeholderId: string, text: string): AssetViewData {
  return {
    placeholderId,
    kind: 'table',
    tableMarkdown: '| a |\n| --- |',
    imageUrl: null,
    text,
    isTemporary: false,
  };
}

/** 문서 한 개를 시드한다. 버전 '1'부터 마지막 버전까지 기본 버전 레코드를 함께 만든다. */
export async function seedDoc(
  db: FakeDb,
  over: Partial<DocumentRecord> = {},
): Promise<DocumentRecord> {
  const doc = docRecord(over);
  const versions: DocumentVersionRecord[] = [];
  for (let v = 1; v <= Number(doc.latestVersion); v += 1) {
    versions.push(versionRecord({ docId: doc.docId, version: String(v) }));
  }
  await seed(db, [doc], versions);
  return doc;
}

/** Db에 저장된 문서 레코드 하나를 읽는다. 없으면 오류다. */
export function docOf(db: FakeDb, docId: string): DocumentRecord {
  const found = db.dump('documents').find((row) => row.docId === docId);
  if (found === undefined) throw new Error(`문서 없음: ${docId}`);
  return found as unknown as DocumentRecord;
}

/** Db에 저장된 버전 레코드 하나를 읽는다. 없으면 undefined다. */
export function versionOf(
  db: FakeDb,
  docId: string,
  version: string,
): DocumentVersionRecord | undefined {
  return db
    .dump('document_versions')
    .find((row) => row.docId === docId && row.version === version) as unknown as
    DocumentVersionRecord | undefined;
}

/** 색인 작업 상태 이벤트를 만든다. */
export function jobEvent(over: Partial<IndexJobStateChangedEvent> = {}): IndexJobStateChangedEvent {
  return {
    docId: DOC_A,
    version: '1',
    jobId: 'job-1',
    jobState: 'succeeded',
    searchableVersion: '1',
    result: { chunkCount: 5, fallbackUsed: false },
    failure: null,
    source: 'notification',
    ...over,
  };
}

/** 업로드 파일을 만든다. */
export function uploadFile(
  name: string,
  content: string | Buffer,
  mimetype = 'application/octet-stream',
): UploadFile {
  return {
    originalname: name,
    mimetype,
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
  };
}

/** 가짜 AssetsService를 만든다. */
export function createFakeAssets() {
  return {
    prepareVersion: jest.fn(
      async (
        _docId: string,
        _version: string,
        _markdown: string,
        _images: readonly UploadedImage[],
      ): Promise<PreparedVersion> => ({
        indexingMarkdown: IDX_SENT,
        unmatchedImages: [],
        assetCount: 0,
      }),
    ),
    generateHints: jest.fn(
      async (_docId: string, _version: string, _ctx: HintContext): Promise<HintRunResult> => ({
        generated: 0,
        temporary: 0,
        stopped: false,
      }),
    ),
    inheritVersion: jest.fn(
      async (
        _docId: string,
        _from: string,
        _to: string,
        _changed: ReadonlyMap<string, string>,
      ): Promise<void> => undefined,
    ),
    markTemporaryForRegeneration: jest.fn(
      async (_docId: string, _version: string): Promise<number> => 0,
    ),
    hintsFor: jest.fn(
      async (
        _docId: string,
        _version: string,
      ): Promise<Array<{ placeholderId: string; text: string }>> => [],
    ),
    listViews: jest.fn(
      async (
        _docId: string,
        _version: string,
      ): Promise<
        Array<{
          placeholderId: string;
          kind: 'table' | 'image';
          tableMarkdown: string | null;
          imageUrl: string | null;
          text: string;
          isTemporary: boolean;
        }>
      > => [],
    ),
    imageUrls: jest.fn(
      async (_docId: string, _version: string): Promise<Record<string, string | null>> => ({}),
    ),
    restore: jest.fn(
      async (_docId: string, version: string, text: string): Promise<string> =>
        `R[${version}]${text}`,
    ),
    deleteDocument: jest.fn(async (_docId: string): Promise<void> => undefined),
  };
}

/** 가짜 IndexingService를 만든다. */
export function createFakeIndexing() {
  return {
    requestIndex: jest.fn(async (_input: IndexRequestInput): Promise<IndexRequestOutcome> => ({
      kind: 'accepted',
      jobId: 'job-new',
    })),
    reconcile: jest.fn(async (_docIds: readonly string[]): Promise<void> => undefined),
    getStages: jest.fn(
      async (_docIds: readonly string[]): Promise<ReadonlyMap<string, RagJobStage>> => new Map(),
    ),
    updateMetadata: jest.fn(
      async (
        _docId: string,
        _name: string,
        _edition: { label: string; editionDate: string } | null,
      ): Promise<boolean> => true,
    ),
    deleteChunks: jest.fn(async (_docId: string): Promise<boolean> => true),
  };
}

/** 가짜 LogsService를 만든다. recordsOf로 종류별 입력을 꺼낸다. */
export function createFakeLogs() {
  const record = jest.fn(async (_input: LogInput): Promise<void> => undefined);
  return {
    record,
    /** 그 종류로 불린 기록 입력 목록이다. */
    recordsOf: (kind: LogKind): LogInput[] =>
      record.mock.calls.map((call) => call[0]).filter((input) => input.kind === kind),
  };
}

/** 가짜 RagClient를 만든다. */
export function createFakeRag() {
  return { getDocumentChunks: jest.fn<Promise<RagDocumentChunks>, [docId: string]>() };
}

/** 부를 때마다 1초씩 늦은 시각을 주는 가짜 시계를 만든다. peek()은 마지막으로 준 값이다. */
export function createFakeClock(startIso = '2026-10-04T00:00:00Z') {
  let next = new Date(startIso).getTime();
  let last = new Date(next);
  const now = jest.fn((): Date => {
    last = new Date(next);
    next += 1000;
    return last;
  });
  return { now, peek: (): Date => last };
}

/** buildDocumentsTestModule이 받는 옵션이다. */
export interface DocumentsTestOptions {
  /** 로그 캡처 출력이다. 파일마다 만든 createLogCapture().stream을 넘긴다 */
  stream: Writable;
  db?: FakeDb;
  /** 기본 설정을 덮어쓴다 */
  config?: Partial<AppConfig>;
  clock?: { now: () => Date };
  ready?: { waitUntilReady: () => Promise<void> };
}

/** buildDocumentsTestModule 결과다. */
export interface DocumentsHarness {
  moduleRef: TestingModule;
  db: FakeDb;
  assets: ReturnType<typeof createFakeAssets>;
  indexing: ReturnType<typeof createFakeIndexing>;
  logs: ReturnType<typeof createFakeLogs>;
  rag: ReturnType<typeof createFakeRag>;
  registry: SchedulerRegistry;
  service: DocumentsService;
  lifecycle: DocumentLifecycle;
  scheduler: DocumentsScheduler;
  repo: DocumentsCrudService;
  tasks: DocumentTasks;
  /** 백그라운드 작업을 모두 기다린다 */
  drain(): Promise<void>;
  /** drain → 인터벌 삭제 → 모듈 닫기. afterEach에서 부른다 */
  close(): Promise<void>;
}

/**
 * 가짜 Db·가짜 이웃 모듈 위에 진짜 documents provider를 올린다.
 * ★ init()을 부르지 않는다(onApplicationBootstrap이 돌지 않는다). 인덱스만 만든다.
 */
export async function buildDocumentsTestModule(
  opts: DocumentsTestOptions,
): Promise<DocumentsHarness> {
  const db = opts.db ?? createFakeDb();
  const assets = createFakeAssets();
  const indexing = createFakeIndexing();
  const logs = createFakeLogs();
  const rag = createFakeRag();
  const registry = new SchedulerRegistry();
  const config: Partial<AppConfig> = {
    UPLOAD_MAX_MD_BYTES: 1000,
    UPLOAD_MAX_IMAGE_BYTES: 2000,
    RECONCILE_INTERVAL_MS: 60000,
    RAG_RETRY_INTERVAL_MS: 60000,
    ...opts.config,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule(config, opts.stream)],
    providers: [
      DocumentsService,
      DocumentLifecycle,
      DocumentsScheduler,
      DocumentsCrudService,
      DocumentTasks,
      { provide: DocumentClock, useValue: opts.clock ?? new DocumentClock() },
      { provide: MONGO_DB, useValue: db },
      { provide: AssetsService, useValue: assets },
      { provide: IndexingService, useValue: indexing },
      { provide: LogsService, useValue: logs },
      { provide: RagClient, useValue: rag },
      {
        provide: EventEmitterReadinessWatcher,
        useValue: opts.ready ?? { waitUntilReady: jest.fn(async () => undefined) },
      },
      { provide: SchedulerRegistry, useValue: registry },
    ],
  }).compile();
  const repo = moduleRef.get(DocumentsCrudService);
  await repo.ensureIndexes();
  const tasks = moduleRef.get(DocumentTasks);
  return {
    moduleRef,
    db,
    assets,
    indexing,
    logs,
    rag,
    registry,
    service: moduleRef.get(DocumentsService),
    lifecycle: moduleRef.get(DocumentLifecycle),
    scheduler: moduleRef.get(DocumentsScheduler),
    repo,
    tasks,
    drain: () => tasks.drain(),
    close: async () => {
      await tasks.drain();
      for (const name of registry.getIntervals()) registry.deleteInterval(name);
      await moduleRef.close();
    },
  };
}

/** 조건이 참이 될 때까지 짧은 간격으로 확인한다. 시간 안에 안 되면 오류다. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('조건이 시간 안에 참이 되지 않았습니다');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** 끝나지 않는 Promise를 만든다. resolve()로 푼다. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 명세가 문구를 정하지 않은 메시지를 느슨하게 검사한다.
 * 한국어 문장이고, 필요한 정보(파일 이름·한도 등)를 담고, 내부 정보(스택·경로·연결 문자열)가 없어야 한다.
 */
export function expectSafeKoreanMessage(
  message: string,
  mustContain: readonly string[] = [],
): void {
  expect(message).toMatch(/[가-힣]/);
  for (const part of mustContain) expect(message).toContain(part);
  expect(message).not.toMatch(
    /node_modules|\bat \S+:\d+|[A-Za-z]+Error\b|mongodb:\/\/|[A-Za-z]:\\/,
  );
}
