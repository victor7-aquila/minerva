import * as barrel from './index';
import { RagClient, RagModule, RagRequestError } from './index';
import { DomainError } from '../common';
import type {
  RagAssetText,
  RagChunkKind,
  RagChunking,
  RagDocumentChunk,
  RagDocumentChunks,
  RagEdition,
  RagEditionRef,
  RagEditionScope,
  RagEvaluationMetrics,
  RagEvaluationRequest,
  RagEvaluationResult,
  RagIndexJob,
  RagIndexJobAccepted,
  RagIndexOutcome,
  RagIndexRequest,
  RagIndexState,
  RagJobFailure,
  RagJobResult,
  RagJobStage,
  RagJobState,
  RagResultChunk,
  RagResultEdition,
  RagSearchRequest,
  RagSearchResult,
} from './index';

/** MODULE.md의 RagClient 공개 시그니처다. */
interface RagClientSpec {
  summarizeTable(tableMarkdown: string): Promise<string>;
  captionImage(image: Buffer, fileName: string): Promise<string>;
  submitIndexJob(req: RagIndexRequest): Promise<RagIndexJobAccepted>;
  getIndexJob(jobId: string): Promise<RagIndexJob>;
  deleteDocument(docId: string): Promise<void>;
  getIndexState(docId: string): Promise<RagIndexState>;
  getIndexStates(docIds: readonly string[]): Promise<RagIndexState[]>;
  updateMetadata(docId: string, name: string, edition: RagEdition | null): Promise<void>;
  getDocumentChunks(docId: string): Promise<RagDocumentChunks>;
  search(req: RagSearchRequest): Promise<RagSearchResult[]>;
  evaluate(req: RagEvaluationRequest): Promise<RagEvaluationResult>;
}

const METHOD_NAMES = [
  'summarizeTable',
  'captionImage',
  'submitIndexJob',
  'getIndexJob',
  'deleteDocument',
  'getIndexState',
  'getIndexStates',
  'updateMetadata',
  'getDocumentChunks',
  'search',
  'evaluate',
];

describe('REQ-BE-10.1.1', () => {
  it('T-SURF-1 배럴의 값 export 이름이 공개 표면과 정확히 같다', () => {
    // ★ RagUnavailableError, InvalidResponseError, 변환 함수 등 내부 이름이 새면 실패한다
    expect(Object.keys(barrel).sort()).toEqual(['RagClient', 'RagModule', 'RagRequestError']);
    expect(typeof RagModule).toBe('function');
  });

  it('T-SURF-3 RagClient 메서드 시그니처가 명세와 같다', () => {
    const asSpec: RagClientSpec = null as unknown as RagClient;
    // 공개 메서드가 늘거나 이름이 바뀌면 Keys가 never가 아니게 되어 컴파일 오류가 난다
    type Keys = Exclude<keyof RagClient, keyof RagClientSpec>;
    const none: Keys extends never ? true : false = true;
    // ★ 타입 검증 전용 함수다. 호출하지 않는다 (null 객체의 메서드를 런타임에 읽지 않기 위함)
    const typeOnly = (client: RagClient): unknown[] => {
      // @ts-expect-error getIndexStates는 배열을 돌려준다
      const bad1: (ids: readonly string[]) => Promise<RagIndexState> = client.getIndexStates;
      // @ts-expect-error captionImage는 Buffer와 파일 이름을 받는다
      const bad2: (image: string) => Promise<string> = client.captionImage;
      // @ts-expect-error deleteDocument는 값을 돌려주지 않는다
      const bad3: (docId: string) => Promise<string> = client.deleteDocument;
      return [bad1, bad2, bad3];
    };
    void [asSpec, typeOnly];
    expect(none).toBe(true);
    for (const name of METHOD_NAMES) {
      expect(typeof (RagClient.prototype as unknown as Record<string, unknown>)[name]).toBe(
        'function',
      );
    }
  });

  it('T-SURF-4 요청·응답 타입의 필드 이름이 고정되어 있다', () => {
    const edition: RagEdition = { label: '2025', editionDate: '2025-01-31' };
    const editionRef: RagEditionRef = { name: 'n', label: 'l' };
    const asset: RagAssetText = { placeholderId: 't01', text: 't' };
    const chunking: RagChunking = 'rule';
    const state: RagJobState = 'superseded';
    const stage: RagJobStage = 'storing';
    const outcome: RagIndexOutcome = 'joined';
    const kind: RagChunkKind = 'asset';
    const scope: RagEditionScope = 'latest';
    const indexReq: RagIndexRequest = {
      docId: 'd',
      version: '1',
      markdown: 'm',
      assets: [asset],
      name: 'n',
      edition,
      chunking,
      force: false,
    };
    const indexReqNull: RagIndexRequest = { ...indexReq, edition: null };
    // @ts-expect-error edition은 필수다
    const noEdition: RagIndexRequest = {
      docId: 'd',
      version: '1',
      markdown: 'm',
      assets: [],
      name: 'n',
    };
    const accepted: RagIndexJobAccepted = { outcome, jobId: 'j', docId: 'd', version: '1' };
    const failure: RagJobFailure = {
      code: 'c',
      message: 'm',
      headingPath: ['a'],
      placeholderId: 't01',
    };
    const failureNull: RagJobFailure = {
      code: 'c',
      message: 'm',
      headingPath: null,
      placeholderId: null,
    };
    const result: RagJobResult = { chunkCount: 1, fallbackUsed: false };
    const job: RagIndexJob = {
      jobId: 'j',
      docId: 'd',
      version: '1',
      state,
      stage,
      failure,
      result,
    };
    const jobNull: RagIndexJob = { ...job, stage: null, failure: null, result: null };
    const indexState: RagIndexState = {
      docId: 'd',
      searchableVersion: '1',
      latestJobId: 'j',
      latestJobState: state,
      latestJobStage: stage,
    };
    const indexStateNull: RagIndexState = {
      docId: 'd',
      searchableVersion: null,
      latestJobId: null,
      latestJobState: null,
      latestJobStage: null,
    };
    const docChunk: RagDocumentChunk = {
      chunkId: 'c',
      order: 0,
      kind,
      headingPath: ['a'],
      title: 't',
      summary: 's',
      text: 'x',
      placeholderIds: [],
      splitIndex: 1,
      splitTotal: 2,
    };
    const docChunkNull: RagDocumentChunk = {
      ...docChunk,
      title: null,
      summary: null,
      splitIndex: null,
      splitTotal: null,
    };
    const docChunks: RagDocumentChunks = { version: '1', items: [docChunk, docChunkNull] };
    const docChunksNull: RagDocumentChunks = { version: null, items: [] };
    const searchReqMin: RagSearchRequest = { query: 'q' };
    const searchReq: RagSearchRequest = {
      query: 'q',
      topN: 1,
      docIds: ['d'],
      editionScope: scope,
      edition: editionRef,
      expandNeighbors: true,
    };
    const resultEdition: RagResultEdition = {
      label: 'l',
      editionDate: '2025-01-31',
      isLatest: true,
    };
    const resultChunk: RagResultChunk = {
      chunkId: 'c',
      kind,
      text: 'x',
      placeholderIds: [],
      splitIndex: null,
      splitTotal: null,
    };
    const searchResult: RagSearchResult = {
      rank: 1,
      score: 0.5,
      docId: 'd',
      version: '1',
      headingPath: ['a'],
      name: 'n',
      edition: resultEdition,
      otherEditionsInResults: false,
      chunks: [resultChunk],
      before: [],
      after: [],
    };
    const searchResultNull: RagSearchResult = { ...searchResult, edition: null };
    const evalReq: RagEvaluationRequest = {
      query: 'q',
      docId: 'd',
      answerSpan: 's',
      editionOnly: true,
      topN: 5,
    };
    const evalReqMin: RagEvaluationRequest = { query: 'q', docId: 'd', answerSpan: 's' };
    const metrics: RagEvaluationMetrics = {
      hitAt1: true,
      hitAt3: true,
      hitAt5: true,
      hitAtN: true,
      rank: 1,
      reciprocalRank: 1,
      coverage: 1,
    };
    const metricsNull: RagEvaluationMetrics = { ...metrics, rank: null };
    const evalResult: RagEvaluationResult = { n: 5, base: metrics, expanded: metricsNull };

    // @ts-expect-error snake_case 키는 없다
    const snakeJob: RagIndexJob = { ...job, job_id: 'x' };
    // @ts-expect-error snake_case 키는 없다
    const snakeMetrics: RagEvaluationMetrics = { ...metrics, hit_at_1: true };
    // @ts-expect-error snake_case 키는 없다
    const snakeResult: RagSearchResult = { ...searchResult, doc_id: 'x' };
    // @ts-expect-error cancelled 상태는 없다
    const badState: RagJobState = 'cancelled';
    // @ts-expect-error parsing 단계는 없다
    const badStage: RagJobStage = 'parsing';

    const all: unknown[] = [
      indexReq,
      indexReqNull,
      noEdition,
      accepted,
      failureNull,
      jobNull,
      indexState,
      indexStateNull,
      docChunks,
      docChunksNull,
      searchReqMin,
      searchReq,
      searchResultNull,
      evalReq,
      evalReqMin,
      evalResult,
      snakeJob,
      snakeMetrics,
      snakeResult,
      badState,
      badStage,
    ];
    expect(all).toHaveLength(21);
  });
});

describe('REQ-BE-10.1.2', () => {
  it('T-SURF-2 RagRequestError는 Error를 상속하고 DomainError가 아니다', () => {
    const err = new RagRequestError(409, 'DOCUMENT_NOT_SEARCHABLE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RagRequestError);
    expect(err).not.toBeInstanceOf(DomainError);
    expect(err.name).toBe('RagRequestError');
    expect(err.status).toBe(409);
    expect(err.code).toBe('DOCUMENT_NOT_SEARCHABLE');
    // @ts-expect-error status는 readonly다
    err.status = 1;
  });
});
