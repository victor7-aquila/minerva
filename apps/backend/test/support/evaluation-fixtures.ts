import type { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { DocumentRefData, EvaluationTarget } from '../../src/documents';
import { DocumentsService } from '../../src/documents';
import { RagClient } from '../../src/rag';
import type {
  RagEvaluationMetrics,
  RagEvaluationRequest,
  RagEvaluationResult,
} from '../../src/rag';
import { MONGO_DB } from '../../src/storage';
// ★ 배럴에는 EvaluationModule만 있다. 테스트 전용 예외로 내부 파일을 직접 import한다
import { EvaluationController } from '../../src/evaluation/controllers/evaluation.controller';
import type {
  EvaluationRecord,
  GoldenSetRecord,
} from '../../src/evaluation/interfaces/evaluation.types';
import { EvaluationClock } from '../../src/evaluation/services/evaluation-clock';
import { EvaluationCrudService } from '../../src/evaluation/services/evaluation-crud.service';
import { EvaluationTasks } from '../../src/evaluation/services/evaluation-tasks';
import { EvaluationService } from '../../src/evaluation/services/evaluation.service';
import { createFakeDb } from './fake-mongo';
import type { FakeDb } from './fake-mongo';
import { createTestCommonModule } from './test-common.module';

/** 로그 비노출 검사용 센티널(질의)이다. */
export const QUERY_SENT = 'QUERY-SENT-71 인증서 갱신 방법';
/** 로그 비노출 검사용 센티널(정답 구간)이다. */
export const SPAN_SENT = 'SPAN-SENT-72 관리 화면에서 갱신을 누른다';
/** 로그 비노출 검사용 센티널(문서 이름)이다. */
export const NAME_SENT = 'NAME-SENT-73';
/** 로그 비노출 검사용 센티널(판 표기)이다. */
export const LABEL_SENT = 'LABEL-SENT-74';
/** 로그 비노출 검사용 센티널(색인용 MD)이다. */
export const IDX_SENT = 'IDX-SENT-75';

/** 문서 ID 상수 A다(소문자 UUID v4). */
export const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** 문서 ID 상수 B다(소문자 UUID v4). */
export const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** 정답 구간 SPAN_SENT를 담은 색인용 MD다. 표 자리표시가 하나 있다. */
export const INDEXING_MD = [
  `# ${IDX_SENT}`,
  '',
  SPAN_SENT,
  '',
  '[[minerva:table:t1 | 인증서 종류별 유효 기간 표]]',
  '',
  '갱신 뒤에는 다시 로그인한다.',
].join('\n');

/** 적중(순위 1) 지표를 만든다. */
export function ragMetrics(over: Partial<RagEvaluationMetrics> = {}): RagEvaluationMetrics {
  return {
    hitAt1: true,
    hitAt3: true,
    hitAt5: true,
    hitAtN: true,
    rank: 1,
    reciprocalRank: 1,
    coverage: 1,
    ...over,
  };
}

/** 놓침 지표를 만든다. */
export function missMetrics(): RagEvaluationMetrics {
  return {
    hitAt1: false,
    hitAt3: false,
    hitAt5: false,
    hitAtN: false,
    rank: null,
    reciprocalRank: 0,
    coverage: 0,
  };
}

/** RAG 평가 결과를 만든다. */
export function ragEvalResult(over: Partial<RagEvaluationResult> = {}): RagEvaluationResult {
  return { n: 10, base: ragMetrics(), expanded: ragMetrics(), ...over };
}

/** 평가 대상 문서를 만든다. 기본은 판 정보가 있는 검색 가능 문서다. */
export function evaluationTarget(over: Partial<EvaluationTarget> = {}): EvaluationTarget {
  return {
    docId: DOC_A,
    name: NAME_SENT,
    edition: { label: LABEL_SENT, editionDate: '2025-01-31' },
    deleted: false,
    searchState: 'searchable',
    searchableIndexingMarkdown: INDEXING_MD,
    ...over,
  };
}

/** 골든셋 저장 레코드를 만든다. */
export function goldenSetRecord(over: Partial<GoldenSetRecord> = {}): GoldenSetRecord {
  return {
    goldenSetId: 'gs-1',
    query: QUERY_SENT,
    docId: DOC_A,
    answerSpan: SPAN_SENT,
    editionOnly: false,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

/** 평가 기록 저장 레코드를 만든다. 기본은 끝난 적중 기록이다. */
export function evaluationRecord(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    recordId: 'rec-1',
    goldenSetId: 'gs-1',
    outcome: 'hit',
    n: 10,
    base: ragMetrics(),
    expanded: ragMetrics(),
    errorMessage: null,
    startedAt: new Date('2026-10-01T00:00:00Z'),
    evaluatedAt: new Date('2026-10-01T00:00:05Z'),
    ...over,
  };
}

/** 평가 중 기록을 만든다. */
export function evaluatingRecord(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return evaluationRecord({
    outcome: 'evaluating',
    n: null,
    base: null,
    expanded: null,
    evaluatedAt: null,
    ...over,
  });
}

/** 가짜 Db에 골든셋과 기록을 넣는다. */
export async function seedEvaluation(
  db: FakeDb,
  goldenSets: GoldenSetRecord[],
  records: EvaluationRecord[],
): Promise<void> {
  for (const goldenSet of goldenSets)
    await db.collection('golden_sets').insertOne({ ...goldenSet });
  for (const record of records) await db.collection('evaluation_records').insertOne({ ...record });
}

/** 가짜 DocumentsService(평가용 조회 두 개)를 만든다. */
export function createFakeEvaluationDocuments() {
  return {
    getEvaluationTarget: jest.fn(async (_docId: string): Promise<EvaluationTarget | null> =>
      evaluationTarget(),
    ),
    getRef: jest.fn(async (docId: string): Promise<DocumentRefData | null> => ({
      docId,
      name: NAME_SENT,
      edition: { label: LABEL_SENT, editionDate: '2025-01-31' },
      deleted: false,
    })),
  };
}

/** 가짜 RagClient(evaluate 하나)를 만든다. */
export function createFakeEvaluationRag() {
  return {
    evaluate: jest.fn(async (_req: RagEvaluationRequest): Promise<RagEvaluationResult> =>
      ragEvalResult(),
    ),
  };
}

/** 부를 때마다 1초씩 늦은 시각을 주는 가짜 시계를 만든다. peek()은 마지막으로 준 값이다. */
export function createFakeEvaluationClock(startIso = '2026-10-05T00:00:00Z') {
  let next = new Date(startIso).getTime();
  let last = new Date(next);
  const now = jest.fn((): Date => {
    last = new Date(next);
    next += 1000;
    return last;
  });
  return { now, peek: (): Date => last };
}

/** 끝나지 않는 Promise와 그 resolve·reject를 만든다. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 조건이 참이 될 때까지 10ms 간격으로 확인한다. 시간 안에 안 되면 오류다. */
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

/** buildEvaluationTestModule 옵션이다. */
export interface EvaluationTestOptions {
  stream: Writable;
  db?: FakeDb;
  documents?: ReturnType<typeof createFakeEvaluationDocuments>;
  rag?: ReturnType<typeof createFakeEvaluationRag>;
  clock?: ReturnType<typeof createFakeEvaluationClock>;
  /** false면 init(onModuleInit)을 부르지 않는다. 기동 전 데이터를 넣을 때 쓴다. 기본 true */
  init?: boolean;
}

/** evaluation 서비스 테스트 모듈이다. */
export interface EvaluationHarness {
  moduleRef: TestingModule;
  service: EvaluationService;
  controller: EvaluationController;
  tasks: EvaluationTasks;
  db: FakeDb;
  documents: ReturnType<typeof createFakeEvaluationDocuments>;
  rag: ReturnType<typeof createFakeEvaluationRag>;
  clock: ReturnType<typeof createFakeEvaluationClock>;
  /** 진행 중 작업을 기다린 뒤 모듈을 닫는다 */
  close(): Promise<void>;
}

/** 가짜 이웃 위에 진짜 evaluation provider를 올린다. */
export async function buildEvaluationTestModule(
  options: EvaluationTestOptions,
): Promise<EvaluationHarness> {
  const db = options.db ?? createFakeDb();
  const documents = options.documents ?? createFakeEvaluationDocuments();
  const rag = options.rag ?? createFakeEvaluationRag();
  const clock = options.clock ?? createFakeEvaluationClock();
  const moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({}, options.stream)],
    controllers: [EvaluationController],
    providers: [
      EvaluationService,
      EvaluationCrudService,
      EvaluationTasks,
      { provide: EvaluationClock, useValue: clock },
      { provide: MONGO_DB, useValue: db },
      { provide: DocumentsService, useValue: documents },
      { provide: RagClient, useValue: rag },
    ],
  }).compile();
  if (options.init !== false) await moduleRef.init();
  const tasks = moduleRef.get(EvaluationTasks);
  return {
    moduleRef,
    service: moduleRef.get(EvaluationService),
    controller: moduleRef.get(EvaluationController),
    tasks,
    db,
    documents,
    rag,
    clock,
    close: async () => {
      await tasks.drain();
      await moduleRef.close();
    },
  };
}
