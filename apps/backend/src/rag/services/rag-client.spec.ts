import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { RagUnavailableError } from '../../common';
import type { AppConfig } from '../../common';
import { RagClient, RagRequestError } from '../index';
import type { RagIndexRequest } from '../index';
import {
  closedPort,
  readMultipart,
  startFakeRagServer,
} from '../../../test/support/fake-rag-server';
import type {
  FakeReply,
  FakeRagServer,
  RecordedRequest,
} from '../../../test/support/fake-rag-server';

/** 로그·오류 비노출 검사에 쓰는 표식 문자열이다. */
const TOKEN = 'rag-test-token-7f3a';

/** 이진 데이터다. PNG 머리글과 줄바꿈·높은 바이트를 섞어 변환 손실을 잡는다. */
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0xff]);

/** 모든 필드를 채운 색인 요청이다. */
const FULL_INDEX_REQ: RagIndexRequest = {
  docId: 'doc-001',
  version: '3',
  markdown: '# 설치\n\n[[minerva:table:t01 | 환경 변수 표]]',
  assets: [{ placeholderId: 't01', text: '환경 변수별 타입과 기본값을 정리한 표' }],
  name: 'IEEE 1609.2.1',
  edition: { label: '2025', editionDate: '2025-01-31' },
  chunking: 'rule',
  force: true,
};

const TABLE_MD = '| 키 | 값 |\n| --- | --- |\n| A | 1 |';

/** 가짜 설정을 만든다. */
function fakeConfig(values: {
  url: string;
  timeoutMs?: number;
  captionTimeoutMs?: number;
}): ConfigService<AppConfig, true> {
  const map: Record<string, unknown> = {
    RAG_SERVER_URL: values.url,
    RAG_SERVER_API_TOKEN: TOKEN,
    RAG_TIMEOUT_MS: values.timeoutMs ?? 2000,
    RAG_CAPTION_TIMEOUT_MS: values.captionTimeoutMs ?? 2000,
  };
  return { get: (key: string) => map[key] } as unknown as ConfigService<AppConfig, true>;
}

/** 로거 호출 한 건이다. */
interface LogCall {
  level: string;
  args: unknown[];
}

/** 로거 호출을 기록하는 가짜 PinoLogger를 만든다. */
function fakeLogger(): { logger: PinoLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record = (level: string) =>
    jest.fn((...args: unknown[]) => {
      calls.push({ level, args });
    });
  const logger = {
    setContext: jest.fn(),
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  } as unknown as PinoLogger;
  return { logger, calls };
}

/** 가짜 설정·로거로 클라이언트를 만든다. */
function makeClient(
  url: string,
  timeouts: { timeoutMs?: number; captionTimeoutMs?: number } = {},
): { client: RagClient; calls: LogCall[] } {
  const { logger, calls } = fakeLogger();
  return { client: new RagClient(fakeConfig({ url, ...timeouts }), logger), calls };
}

/** 던진 오류를 돌려준다. 던지지 않으면 실패한다. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('예외가 발생하지 않았다');
}

/** 요청 본문을 JSON으로 읽는다. */
function bodyOf(req: RecordedRequest): unknown {
  return JSON.parse(req.body.toString('utf8'));
}

/** 객체 안의 모든 키 이름을 재귀로 모은다. 값 문자열은 보지 않는다. */
function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

/** 응답 본문에 쓰는 문서 청크(공개 응답 형태, snake_case)다. */
const CHUNKS_WIRE = {
  version: '3',
  items: [
    {
      chunk_id: 'c-1',
      order: 0,
      kind: 'text',
      heading_path: ['설치'],
      title: '설치',
      summary: '요약',
      text: '본문 [[minerva:table:t01 | 표]]',
      placeholder_ids: ['t01'],
      split_index: null,
      split_total: null,
    },
    {
      chunk_id: 'c-2',
      order: 1,
      kind: 'asset',
      heading_path: ['설치'],
      title: null,
      summary: null,
      text: '[[minerva:table:t01 | 표]]',
      placeholder_ids: ['t01'],
      split_index: 1,
      split_total: 2,
    },
  ],
};

const CHUNKS_EXPECTED = {
  version: '3',
  items: [
    {
      chunkId: 'c-1',
      order: 0,
      kind: 'text',
      headingPath: ['설치'],
      title: '설치',
      summary: '요약',
      text: '본문 [[minerva:table:t01 | 표]]',
      placeholderIds: ['t01'],
      splitIndex: null,
      splitTotal: null,
    },
    {
      chunkId: 'c-2',
      order: 1,
      kind: 'asset',
      headingPath: ['설치'],
      title: null,
      summary: null,
      text: '[[minerva:table:t01 | 표]]',
      placeholderIds: ['t01'],
      splitIndex: 1,
      splitTotal: 2,
    },
  ],
};

/** 검색 결과의 청크(응답 형태)를 만든다. */
function resultChunkWire(id: string, splitIndex: number | null, splitTotal: number | null) {
  return {
    chunk_id: id,
    kind: 'text',
    text: `본문 ${id}`,
    placeholder_ids: ['t01'],
    split_index: splitIndex,
    split_total: splitTotal,
  };
}

/** 검색 결과의 청크(공개 형태)를 만든다. */
function resultChunkExpected(id: string, splitIndex: number | null, splitTotal: number | null) {
  return {
    chunkId: id,
    kind: 'text',
    text: `본문 ${id}`,
    placeholderIds: ['t01'],
    splitIndex,
    splitTotal,
  };
}

const SEARCH_WIRE = {
  results: [
    {
      rank: 1,
      score: 0.82,
      doc_id: 'doc-001',
      version: '3',
      heading_path: ['설치', '환경'],
      name: 'IEEE 1609.2.1',
      edition: { label: '2025', edition_date: '2025-01-31', is_latest: true },
      other_editions_in_results: true,
      chunks: [resultChunkWire('c-1', null, null)],
      before: [],
      after: [],
    },
    {
      rank: 2,
      score: 0.5,
      doc_id: 'doc-002',
      version: '1',
      heading_path: ['개요'],
      name: '이름 둘',
      edition: null,
      other_editions_in_results: false,
      chunks: [resultChunkWire('c-9', 1, 2)],
      before: [resultChunkWire('c-8', null, null)],
      after: [resultChunkWire('c-10', null, null)],
    },
  ],
};

const SEARCH_EXPECTED = [
  {
    rank: 1,
    score: 0.82,
    docId: 'doc-001',
    version: '3',
    headingPath: ['설치', '환경'],
    name: 'IEEE 1609.2.1',
    edition: { label: '2025', editionDate: '2025-01-31', isLatest: true },
    otherEditionsInResults: true,
    chunks: [resultChunkExpected('c-1', null, null)],
    before: [],
    after: [],
  },
  {
    rank: 2,
    score: 0.5,
    docId: 'doc-002',
    version: '1',
    headingPath: ['개요'],
    name: '이름 둘',
    edition: null,
    otherEditionsInResults: false,
    chunks: [resultChunkExpected('c-9', 1, 2)],
    before: [resultChunkExpected('c-8', null, null)],
    after: [resultChunkExpected('c-10', null, null)],
  },
];

const EVALUATION_WIRE = {
  n: 5,
  base: {
    hit_at_1: false,
    hit_at_3: true,
    hit_at_5: true,
    hit_at_n: true,
    rank: 2,
    reciprocal_rank: 0.5,
    coverage: 0.8,
  },
  expanded: {
    hit_at_1: false,
    hit_at_3: false,
    hit_at_5: false,
    hit_at_n: false,
    rank: null,
    reciprocal_rank: 0,
    coverage: 0,
  },
};

const EVALUATION_EXPECTED = {
  n: 5,
  base: {
    hitAt1: false,
    hitAt3: true,
    hitAt5: true,
    hitAtN: true,
    rank: 2,
    reciprocalRank: 0.5,
    coverage: 0.8,
  },
  expanded: {
    hitAt1: false,
    hitAt3: false,
    hitAt5: false,
    hitAtN: false,
    rank: null,
    reciprocalRank: 0,
    coverage: 0,
  },
};

/** 색인 작업 응답의 공통 필드다. */
const JOB_BASE = { doc_id: 'doc-001', version: '3' };

/** 경로별 정상 응답을 돌려준다. 정의에 없는 요청은 404로 답한다. */
function okHandler(req: RecordedRequest): FakeReply {
  const route = `${req.method} ${req.url}`;
  switch (route) {
    case 'POST /v1/captions/table':
      return { status: 200, json: { summary: '환경 변수별 기본값을 정리한 표' } };
    case 'POST /v1/captions/image':
      return { status: 200, json: { caption: '설치 화면 캡처' } };
    case 'POST /v1/index-jobs':
      return {
        status: 202,
        json: { outcome: 'queued', job_id: 'job-7f3a', doc_id: 'doc-001', version: '3' },
      };
    case 'GET /v1/index-jobs/job-fail':
      return {
        status: 200,
        json: {
          job_id: 'job-fail',
          ...JOB_BASE,
          state: 'failed',
          stage: null,
          failure: {
            code: 'CHUNKING_FAILED',
            message: '청킹 실패',
            heading_path: ['설치', '환경'],
            placeholder_id: 't01',
          },
          result: null,
        },
      };
    case 'GET /v1/index-jobs/job-ok':
      return {
        status: 200,
        json: {
          job_id: 'job-ok',
          ...JOB_BASE,
          state: 'succeeded',
          stage: null,
          failure: null,
          result: { chunk_count: 12, fallback_used: true },
        },
      };
    case 'GET /v1/index-jobs/job-run':
      return {
        status: 200,
        json: {
          job_id: 'job-run',
          ...JOB_BASE,
          state: 'running',
          stage: 'embedding',
          failure: null,
          result: null,
        },
      };
    case 'GET /v1/documents/doc-001/index-state':
      return {
        status: 200,
        json: {
          doc_id: 'doc-001',
          searchable_version: '2',
          latest_job_id: 'job-7f3a',
          latest_job_state: 'running',
          latest_job_stage: 'storing',
        },
      };
    case 'POST /v1/documents/index-states': {
      const ids = (bodyOf(req) as { doc_ids: string[] }).doc_ids;
      return {
        status: 200,
        json: {
          items: ids.map((id) => ({
            doc_id: id,
            searchable_version: null,
            latest_job_id: null,
            latest_job_state: null,
            latest_job_stage: null,
          })),
        },
      };
    }
    case 'GET /v1/documents/doc-001/chunks':
      return { status: 200, json: CHUNKS_WIRE };
    case 'GET /v1/documents/doc-empty/chunks':
      return { status: 200, json: { version: null, items: [] } };
    case 'POST /v1/search':
      return { status: 200, json: SEARCH_WIRE };
    case 'POST /v1/evaluations':
      return { status: 200, json: EVALUATION_WIRE };
    case 'PUT /v1/documents/doc-001/metadata':
    case 'DELETE /v1/documents/doc-001':
      return { status: 204 };
    default:
      return {
        status: 404,
        json: { error: { code: 'NOT_FOUND_IN_FAKE', message: '가짜 서버에 규칙이 없습니다' } },
      };
  }
}

/** 메서드 하나를 부르는 함수다. */
type Call = (c: RagClient) => Promise<unknown>;

/** 11개 메서드를 같은 형태로 돌리는 표다. */
const CALLS: [string, Call][] = [
  ['summarizeTable', (c) => c.summarizeTable(TABLE_MD)],
  ['captionImage', (c) => c.captionImage(IMAGE_BYTES, '그림 1.png')],
  ['submitIndexJob', (c) => c.submitIndexJob(FULL_INDEX_REQ)],
  ['getIndexJob', (c) => c.getIndexJob('job-ok')],
  ['deleteDocument', (c) => c.deleteDocument('doc-001')],
  ['getIndexState', (c) => c.getIndexState('doc-001')],
  ['getIndexStates', (c) => c.getIndexStates(['doc-001', 'doc-002'])],
  [
    'updateMetadata',
    (c) =>
      c.updateMetadata('doc-001', 'IEEE 1609.2.1', { label: '2025', editionDate: '2025-01-31' }),
  ],
  ['getDocumentChunks', (c) => c.getDocumentChunks('doc-001')],
  ['search', (c) => c.search({ query: '인증서 갱신 절차' })],
  [
    'evaluate',
    (c) => c.evaluate({ query: '인증서 갱신 절차', docId: 'doc-001', answerSpan: '만료 30일 전' }),
  ],
];

const CAPTION_NAMES = ['summarizeTable', 'captionImage'];
const CAPTION_OPS = CALLS.filter(([name]) => CAPTION_NAMES.includes(name));
const GENERAL_OPS = CALLS.filter(([name]) => !CAPTION_NAMES.includes(name));

/** 호출 이름으로 호출 함수를 찾는다. */
function callOf(name: string): Call {
  const found = CALLS.find(([n]) => n === name);
  if (!found) throw new Error(`알 수 없는 메서드: ${name}`);
  return found[1];
}

let server: FakeRagServer;
let client: RagClient;
let logCalls: LogCall[];

beforeAll(async () => {
  server = await startFakeRagServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
  server.setHandler(okHandler);
  ({ client, calls: logCalls } = makeClient(server.baseUrl));
});

describe('REQ-BE-10.1.1', () => {
  /** 메서드별 기대 요청 줄이다. */
  const REQUEST_LINES: [string, string, string][] = [
    ['summarizeTable', 'POST', '/v1/captions/table'],
    ['captionImage', 'POST', '/v1/captions/image'],
    ['submitIndexJob', 'POST', '/v1/index-jobs'],
    ['getIndexJob', 'GET', '/v1/index-jobs/job-ok'],
    ['deleteDocument', 'DELETE', '/v1/documents/doc-001'],
    ['getIndexState', 'GET', '/v1/documents/doc-001/index-state'],
    ['getIndexStates', 'POST', '/v1/documents/index-states'],
    ['updateMetadata', 'PUT', '/v1/documents/doc-001/metadata'],
    ['getDocumentChunks', 'GET', '/v1/documents/doc-001/chunks'],
    ['search', 'POST', '/v1/search'],
    ['evaluate', 'POST', '/v1/evaluations'],
  ];

  it.each(REQUEST_LINES)(
    'T-URL-1 %s의 요청은 정확히 1건이고 메서드·경로가 명세와 같다',
    async (name, method, url) => {
      await callOf(name)(client);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe(method);
      expect(server.requests[0]?.url).toBe(url);
    },
  );

  describe('T-URL-2 JSON 본문 정확 일치', () => {
    it('summarizeTable은 table_markdown만 보낸다', async () => {
      await client.summarizeTable(TABLE_MD);
      expect(bodyOf(server.requests[0]!)).toEqual({ table_markdown: TABLE_MD });
    });

    it('submitIndexJob은 snake_case 본문을 보낸다', async () => {
      await client.submitIndexJob(FULL_INDEX_REQ);
      expect(bodyOf(server.requests[0]!)).toEqual({
        doc_id: 'doc-001',
        version: '3',
        markdown: FULL_INDEX_REQ.markdown,
        assets: [{ placeholder_id: 't01', text: '환경 변수별 타입과 기본값을 정리한 표' }],
        name: 'IEEE 1609.2.1',
        edition: { label: '2025', edition_date: '2025-01-31' },
        chunking: 'rule',
        force: true,
      });
    });

    it('getIndexStates는 doc_ids만 보낸다', async () => {
      await client.getIndexStates(['doc-001', 'doc-002']);
      expect(bodyOf(server.requests[0]!)).toEqual({ doc_ids: ['doc-001', 'doc-002'] });
    });

    it('updateMetadata는 name과 edition을 보낸다', async () => {
      await client.updateMetadata('doc-001', 'IEEE 1609.2.1', {
        label: '2025',
        editionDate: '2025-01-31',
      });
      expect(bodyOf(server.requests[0]!)).toEqual({
        name: 'IEEE 1609.2.1',
        edition: { label: '2025', edition_date: '2025-01-31' },
      });
    });

    it('evaluate는 선택 키 없이 보낸다', async () => {
      await client.evaluate({
        query: '인증서 갱신 절차',
        docId: 'doc-001',
        answerSpan: '만료 30일 전',
      });
      // ★ top_n·edition_only 키가 없어야 한다
      expect(bodyOf(server.requests[0]!)).toEqual({
        query: '인증서 갱신 절차',
        doc_id: 'doc-001',
        answer_span: '만료 30일 전',
      });
    });

    it('search 최소 요청은 query만 보낸다', async () => {
      await client.search({ query: '인증서 갱신 절차' });
      expect(bodyOf(server.requests[0]!)).toEqual({ query: '인증서 갱신 절차' });
    });

    it.each(CALLS.filter(([n]) => n !== 'captionImage'))(
      '%s의 JSON 요청 content-type은 application/json이고 GET·DELETE는 본문이 없다',
      async (_name, call) => {
        await call(client);
        const req = server.requests[0]!;
        if (req.method === 'GET' || req.method === 'DELETE') {
          expect(req.body.length).toBe(0);
        } else {
          expect(String(req.headers['content-type'])).toMatch(/^application\/json/);
        }
      },
    );
  });

  describe('T-URL-3 선택 필드 생략·전체', () => {
    it('edition null·chunking·force 생략이면 해당 키가 없다', async () => {
      await client.submitIndexJob({
        ...FULL_INDEX_REQ,
        edition: null,
        chunking: undefined,
        force: undefined,
      });
      // ★ edition 키가 null로도 나오면 안 된다
      const keys = Object.keys(bodyOf(server.requests[0]!) as object).sort();
      expect(keys).toEqual(['assets', 'doc_id', 'markdown', 'name', 'version']);
    });

    it('search 전체 필드를 snake_case로 보낸다', async () => {
      await client.search({
        query: '인증서 갱신 절차',
        topN: 3,
        docIds: ['a', 'b'],
        editionScope: 'specific',
        edition: { name: 'IEEE 1609.2.1', label: '2025' },
        expandNeighbors: true,
      });
      expect(bodyOf(server.requests[0]!)).toEqual({
        query: '인증서 갱신 절차',
        top_n: 3,
        doc_ids: ['a', 'b'],
        edition_scope: 'specific',
        edition: { name: 'IEEE 1609.2.1', label: '2025' },
        expand_neighbors: true,
      });
    });

    it('evaluate의 editionOnly·topN을 보낸다', async () => {
      await client.evaluate({
        query: 'q',
        docId: 'doc-001',
        answerSpan: 's',
        editionOnly: true,
        topN: 7,
      });
      expect(bodyOf(server.requests[0]!)).toEqual({
        query: 'q',
        doc_id: 'doc-001',
        answer_span: 's',
        edition_only: true,
        top_n: 7,
      });
    });
  });

  it('T-URL-4 updateMetadata의 null 판 정보는 edition 키를 null로 보낸다', async () => {
    await client.updateMetadata('doc-001', '이름', null);
    expect(bodyOf(server.requests[0]!)).toEqual({ name: '이름', edition: null });
  });

  describe('T-URL-5 multipart', () => {
    it.each(['그림 1.png', 'fig 1.png'])(
      'captionImage가 이미지를 파일 %s로 보낸다',
      async (fileName) => {
        await client.captionImage(IMAGE_BYTES, fileName);
        const req = server.requests[0]!;
        expect(String(req.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
        const form = await readMultipart(req);
        expect([...form.keys()]).toEqual(['image']);
        const file = form.get('image') as File;
        // ★ 한글 파일 이름이 왕복하지 않으면 이름을 바꿔 통과시키지 말고 보고한다
        expect(file.name).toBe(fileName);
        expect(Buffer.from(await file.arrayBuffer()).equals(IMAGE_BYTES)).toBe(true);
      },
    );
  });

  describe('T-URL-6 응답을 camelCase로 변환한다', () => {
    it('summarizeTable·captionImage는 문자열을 돌려준다', async () => {
      await expect(client.summarizeTable(TABLE_MD)).resolves.toBe('환경 변수별 기본값을 정리한 표');
      await expect(client.captionImage(IMAGE_BYTES, 'a.png')).resolves.toBe('설치 화면 캡처');
    });

    it('submitIndexJob', async () => {
      await expect(client.submitIndexJob(FULL_INDEX_REQ)).resolves.toEqual({
        outcome: 'queued',
        jobId: 'job-7f3a',
        docId: 'doc-001',
        version: '3',
      });
    });

    it('getIndexJob은 실패·성공·진행 중을 모두 옮긴다', async () => {
      await expect(client.getIndexJob('job-fail')).resolves.toEqual({
        jobId: 'job-fail',
        docId: 'doc-001',
        version: '3',
        state: 'failed',
        stage: null,
        failure: {
          code: 'CHUNKING_FAILED',
          message: '청킹 실패',
          headingPath: ['설치', '환경'],
          placeholderId: 't01',
        },
        result: null,
      });
      await expect(client.getIndexJob('job-ok')).resolves.toEqual({
        jobId: 'job-ok',
        docId: 'doc-001',
        version: '3',
        state: 'succeeded',
        stage: null,
        failure: null,
        result: { chunkCount: 12, fallbackUsed: true },
      });
      const running = await client.getIndexJob('job-run');
      expect(running.stage).toBe('embedding');
      expect(running.state).toBe('running');
    });

    it('getIndexState·getIndexStates', async () => {
      await expect(client.getIndexState('doc-001')).resolves.toEqual({
        docId: 'doc-001',
        searchableVersion: '2',
        latestJobId: 'job-7f3a',
        latestJobState: 'running',
        latestJobStage: 'storing',
      });
      const empty = (docId: string) => ({
        docId,
        searchableVersion: null,
        latestJobId: null,
        latestJobState: null,
        latestJobStage: null,
      });
      await expect(client.getIndexStates(['doc-001', 'doc-002'])).resolves.toEqual([
        empty('doc-001'),
        empty('doc-002'),
      ]);
    });

    it('getDocumentChunks는 청크 전체 필드를 옮기고 null을 유지한다', async () => {
      await expect(client.getDocumentChunks('doc-001')).resolves.toEqual(CHUNKS_EXPECTED);
      await expect(client.getDocumentChunks('doc-empty')).resolves.toEqual({
        version: null,
        items: [],
      });
    });

    it('search·evaluate', async () => {
      await expect(client.search({ query: 'q' })).resolves.toEqual(SEARCH_EXPECTED);
      await expect(
        client.evaluate({ query: 'q', docId: 'doc-001', answerSpan: 's' }),
      ).resolves.toEqual(EVALUATION_EXPECTED);
    });

    it('deleteDocument·updateMetadata는 undefined로 끝난다', async () => {
      await expect(client.deleteDocument('doc-001')).resolves.toBeUndefined();
      await expect(client.updateMetadata('doc-001', 'n', null)).resolves.toBeUndefined();
    });

    it('반환 객체의 키에 snake_case가 없다', async () => {
      const results = await Promise.all([
        client.submitIndexJob(FULL_INDEX_REQ),
        client.getIndexJob('job-fail'),
        client.getIndexJob('job-ok'),
        client.getIndexState('doc-001'),
        client.getIndexStates(['doc-001']),
        client.getDocumentChunks('doc-001'),
        client.search({ query: 'q' }),
        client.evaluate({ query: 'q', docId: 'doc-001', answerSpan: 's' }),
      ]);
      const keys = collectKeys(results);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => key.includes('_'))).toEqual([]);
    });
  });

  it.each(['queued', 'joined', 'reused'] as const)(
    'T-URL-7 submitIndexJob의 접수 결과 %s는 오류가 아니다',
    async (outcome) => {
      const status = outcome === 'reused' ? 200 : 202;
      server.setHandler(() => ({
        status,
        json: { outcome, job_id: `job-${outcome}`, doc_id: 'doc-001', version: '3' },
      }));
      const accepted = await client.submitIndexJob(FULL_INDEX_REQ);
      expect(accepted.outcome).toBe(outcome);
      expect(accepted.jobId).toBe(`job-${outcome}`);
    },
  );

  describe('T-URL-8 주소 접두사·끝 슬래시, 경로 변수 인코딩', () => {
    it('끝 슬래시가 있는 설정 주소에서도 // 없이 접두사를 붙인다', async () => {
      // ★ okHandler는 정확 경로만 받으므로, 접두사 주소에는 정상 응답을 주는 핸들러를 따로 건다
      server.setHandler(() => ({ status: 200, json: { results: [] } }));
      const { client: prefixed } = makeClient(`${server.baseUrl}/rag/`);
      await prefixed.search({ query: 'q' });
      expect(server.requests[0]?.url).toBe('/rag/v1/search');
    });

    it('경로 변수를 인코딩한다', async () => {
      server.setHandler(() => ({ status: 404 }));
      await caught(client.getIndexState('a/b c?#'));
      await caught(client.getIndexJob('j/1'));
      expect(server.requests.map((r) => r.url)).toEqual([
        '/v1/documents/a%2Fb%20c%3F%23/index-state',
        '/v1/index-jobs/j%2F1',
      ]);
    });
  });

  describe('T-URL-9 getIndexStates는 100개씩 나눠 보낸다', () => {
    const ids = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
    const sizes = (): number[] =>
      server.requests.map((r) => (bodyOf(r) as { doc_ids: string[] }).doc_ids.length);

    it('250개는 100·100·50 세 번이고 순서를 지킨다', async () => {
      const input = ids(250);
      const result = await client.getIndexStates(input);
      const sent = server.requests.map((r) => (bodyOf(r) as { doc_ids: string[] }).doc_ids);
      expect(sent.map((s) => s.length)).toEqual([100, 100, 50]);
      expect(sent.flat()).toEqual(input);
      expect(result).toHaveLength(250);
      expect(result.map((s) => s.docId)).toEqual(input);
    });

    it('정확히 100개는 1건, 101개는 2건(100·1)이다', async () => {
      await client.getIndexStates(ids(100));
      expect(sizes()).toEqual([100]);
      server.requests.length = 0;
      await client.getIndexStates(ids(101));
      expect(sizes()).toEqual([100, 1]);
    });

    it('빈 배열은 요청 없이 []를 돌려준다', async () => {
      await expect(client.getIndexStates([])).resolves.toEqual([]);
      expect(server.requests).toHaveLength(0);
    });
  });

  it('T-URL-10 응답 items가 비어 있으면 []를 돌려준다', async () => {
    server.setHandler(() => ({ status: 200, json: { items: [] } }));
    await expect(client.getIndexStates(['doc-001'])).resolves.toEqual([]);
  });

  // ★ 스택 초과 회귀: 묶음 응답을 합칠 때 인자 펼치기(push(...items))를 쓰면 응답이 클 때 RangeError가 난다
  it('T-URL-12 묶음마다 응답 항목이 200000개여도 예외 없이 모두 모은다', async () => {
    const perBatch = 200000;
    const item = (docId: string) => ({ doc_id: docId });
    server.setHandler((req) => {
      const first = (bodyOf(req) as { doc_ids: string[] }).doc_ids[0] ?? '';
      return {
        status: 200,
        json: { items: Array.from({ length: perBatch }, (_, i) => item(`${first}-${i}`)) },
      };
    });
    const ids = Array.from({ length: 101 }, (_, i) => `doc-${i}`);
    const result = await client.getIndexStates(ids);
    // 100개 묶음 + 1개 묶음 = 두 요청, 응답 합산 400000개
    expect(server.requests).toHaveLength(2);
    expect(result).toHaveLength(perBatch * 2);
    expect(result[0]?.docId).toBe('doc-0-0');
    expect(result[perBatch - 1]?.docId).toBe(`doc-0-${perBatch - 1}`);
    expect(result[perBatch]?.docId).toBe('doc-100-0');
    expect(result[perBatch * 2 - 1]?.docId).toBe(`doc-100-${perBatch - 1}`);
  });

  it('T-URL-11 search의 결과가 없으면 []를 돌려준다', async () => {
    server.setHandler(() => ({ status: 200, json: { results: [] } }));
    await expect(client.search({ query: 'q' })).resolves.toEqual([]);
  });
});

describe('REQ-BE-10.1.2', () => {
  describe('T-ERR-1 연결 거부', () => {
    it.each(CALLS)('%s는 RagUnavailableError', async (_name, call) => {
      const port = await closedPort();
      const { client: refused } = makeClient(`http://127.0.0.1:${port}`);
      const err = await caught(call(refused));
      expect(err).toBeInstanceOf(RagUnavailableError);
      expect((err as RagUnavailableError).code).toBe('RAG_UNAVAILABLE');
    });
  });

  describe('T-ERR-2 503', () => {
    it.each(CALLS)('%s는 503에서 RagUnavailableError', async (_name, call) => {
      server.setHandler(() => ({
        status: 503,
        json: { error: { code: 'SERVER_NOT_READY', message: '준비 중' } },
      }));
      const err = await caught(call(client));
      expect(err).toBeInstanceOf(RagUnavailableError);
      expect(err).not.toBeInstanceOf(RagRequestError);
    });

    it.each([
      ['search', 'MODEL_UNAVAILABLE'],
      ['search', 'STORE_UNAVAILABLE'],
      ['submitIndexJob', 'SHUTTING_DOWN'],
    ])('%s의 503 %s도 RagUnavailableError', async (name, code) => {
      server.setHandler(() => ({ status: 503, json: { error: { code, message: 'm' } } }));
      const err = await caught(callOf(name)(client));
      expect(err).toBeInstanceOf(RagUnavailableError);
      expect(err).not.toBeInstanceOf(RagRequestError);
    });

    it('본문 없는 503도 RagUnavailableError', async () => {
      server.setHandler(() => ({ status: 503 }));
      const err = await caught(client.search({ query: 'q' }));
      expect(err).toBeInstanceOf(RagUnavailableError);
      expect(err).not.toBeInstanceOf(RagRequestError);
    });
  });

  describe('T-ERR-3 그 밖의 오류 응답은 RagRequestError', () => {
    it('evaluate 409는 상태와 코드를 담는다', async () => {
      server.setHandler(() => ({
        status: 409,
        json: { error: { code: 'DOCUMENT_NOT_SEARCHABLE', message: 'm' } },
      }));
      const err = await caught(client.evaluate({ query: 'q', docId: 'doc-001', answerSpan: 's' }));
      expect(err).toBeInstanceOf(RagRequestError);
      expect(err).not.toBeInstanceOf(RagUnavailableError);
      const typed = err as RagRequestError;
      expect(typed.status).toBe(409);
      expect(typed.code).toBe('DOCUMENT_NOT_SEARCHABLE');
      expect(typed.name).toBe('RagRequestError');
    });

    it.each([
      ['submitIndexJob', 400, 'INVALID_REQUEST'],
      ['getIndexState', 401, 'UNAUTHORIZED'],
      ['getIndexJob', 404, 'JOB_NOT_FOUND'],
      ['captionImage', 413, 'PAYLOAD_TOO_LARGE'],
      ['deleteDocument', 500, 'INTERNAL_ERROR'],
      ['search', 500, 'VECTOR_DIMENSION_MISMATCH'],
      ['summarizeTable', 502, 'CAPTION_FAILED'],
    ])('%s의 %i %s는 RagRequestError', async (name, status, code) => {
      server.setHandler(() => ({ status, json: { error: { code, message: 'm' } } }));
      const err = await caught(callOf(name)(client));
      expect(err).toBeInstanceOf(RagRequestError);
      expect(err).not.toBeInstanceOf(RagUnavailableError);
      expect((err as RagRequestError).status).toBe(status);
      expect((err as RagRequestError).code).toBe(code);
    });
  });

  describe('T-ERR-4 error.code가 없는 오류 응답', () => {
    const cases: [string, FakeReply][] = [
      ['502 HTML', { status: 502, raw: '<html>Bad Gateway</html>', contentType: 'text/html' }],
      ['500 detail', { status: 500, json: { detail: 'x' } }],
      ['404 본문 없음', { status: 404 }],
      ['400 숫자 코드', { status: 400, json: { error: { code: 123 } } }],
    ];
    it.each(cases)('%s는 UNKNOWN 코드의 RagRequestError', async (_label, reply) => {
      server.setHandler(() => reply);
      const err = await caught(client.getIndexState('doc-001'));
      expect(err).toBeInstanceOf(RagRequestError);
      expect((err as RagRequestError).code).toBe('UNKNOWN');
      expect((err as RagRequestError).status).toBe(reply.status);
    });
  });

  describe('T-ERR-5 계약과 다른 성공 응답', () => {
    const cases: [string, string, FakeReply][] = [
      ['getIndexState', 'JSON이 아님', { status: 200, raw: 'not json', contentType: 'text/plain' }],
      ['getIndexJob', '배열', { status: 200, json: [] }],
      ['evaluate', 'null', { status: 200, json: null }],
      ['search', 'results가 배열이 아님', { status: 200, json: { results: 'x' } }],
      ['getIndexStates', 'items가 null', { status: 200, json: { items: null } }],
    ];
    it.each(cases)('%s의 %s 응답은 RagUnavailableError', async (name, _label, reply) => {
      server.setHandler(() => reply);
      const err = await caught(callOf(name)(client));
      expect(err).toBeInstanceOf(RagUnavailableError);
    });
  });

  describe('T-ERR-6 다시 시도하지 않는다', () => {
    it.each([503, 500])('%i 응답 뒤 요청은 1건이다', async (status) => {
      server.setHandler(() => ({ status, json: { error: { code: 'X', message: 'm' } } }));
      await caught(client.search({ query: 'q' }));
      expect(server.requests).toHaveLength(1);
    });

    it('시간 초과 뒤에도 요청은 1건이다', async () => {
      const { client: quick } = makeClient(server.baseUrl, { timeoutMs: 150 });
      server.setHandler(() => ({ status: 200, json: { results: [] }, delayMs: 600 }));
      await caught(quick.search({ query: 'q' }));
      expect(server.requests).toHaveLength(1);
      // 지연 시간이 지난 뒤에도 다시 보내지 않았는지 본다
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(server.requests).toHaveLength(1);
    });
  });

  describe('T-ERR-7 오류와 로그에 민감 정보가 없다', () => {
    /** 표식 문자열을 요청에 넣는 호출들이다. */
    const SECRET_CALLS: [string, Call][] = [
      ['summarizeTable', (c) => c.summarizeTable('SECRET-TABLE-1')],
      ['captionImage', (c) => c.captionImage(IMAGE_BYTES, 'SECRET-FILE-1.png')],
      ['submitIndexJob', (c) => c.submitIndexJob({ ...FULL_INDEX_REQ, markdown: 'SECRET-MD-1' })],
      ['search', (c) => c.search({ query: 'SECRET-QUERY-1' })],
      [
        'evaluate',
        (c) =>
          c.evaluate({
            query: 'SECRET-QUERY-2',
            docId: 'doc-001',
            answerSpan: 'SECRET-SPAN-1',
          }),
      ],
    ];

    /** 응답 본문에 표식을 심은 실패 경로다. */
    const SECRET_BODY = { error: { code: 'SOME_CODE', message: 'SECRET-SERVER-MSG' } };
    /** 모드 옵션이다. only는 적용할 호출 이름(없으면 전부), slow는 100ms 제한을 쓴다는 뜻이다. */
    interface ModeOpts {
      only?: readonly string[];
      slow?: boolean;
    }
    const MODES: [string, FakeReply | 'refused', ModeOpts?][] = [
      ['409', { status: 409, json: { ...SECRET_BODY, detail: 'SECRET-RESP-1' } }],
      ['503', { status: 503, json: { ...SECRET_BODY, detail: 'SECRET-RESP-1' } }],
      ['400', { status: 400, json: { ...SECRET_BODY, detail: 'SECRET-RESP-1' } }],
      ['500 error.message 밖의 필드', { status: 500, json: { detail: 'SECRET-RESP-1' } }],
      ['502 HTML', { status: 502, raw: '<html>SECRET-RESP-1</html>', contentType: 'text/html' }],
      ['400 text/plain', { status: 400, raw: 'SECRET-RESP-1', contentType: 'text/plain' }],
      ['200 JSON 아님', { status: 200, raw: 'SECRET-RESP-1 {', contentType: 'text/plain' }],
      // 래퍼 배열(results)이 필수인 호출에만 건다. 나머지 호출은 필드 타입을 검사하지 않고
      // 계약을 믿는 결정(CONTEXT 확인 필요 1)이라 이 응답에서도 던지지 않는다
      [
        '200 래퍼 필드 오류(객체)',
        { status: 200, json: { results: 'SECRET-RESP-1' } },
        { only: ['search'] },
      ],
      ['200 구조 다름(배열)', { status: 200, json: ['SECRET-RESP-1'] }],
      ['시간 초과', { status: 200, json: { x: 'SECRET-RESP-1' }, delayMs: 600 }, { slow: true }],
      [
        '본문 읽는 중 시간 초과',
        { status: 200, json: { x: 'SECRET-RESP-1' }, stallBodyMs: 600 },
        { slow: true },
      ],
      ['본문 읽는 중 연결 끊김', { status: 200, json: { x: 'SECRET-RESP-1' }, dropBody: true }],
      ['연결 거부', 'refused'],
    ];

    /** 한 경우를 돌려 오류·로거 호출·가짜 서버 포트를 모은다. */
    async function runSecret(
      mode: FakeReply | 'refused',
      call: Call,
      slow: boolean,
    ): Promise<{ err: unknown; logs: LogCall[]; port: string }> {
      // 100ms 제한은 지연·정지 모드에만 쓴다. 나머지는 기본 제한이라 부하로 시간 초과 경로가 되지 않는다
      const timeouts = slow ? { timeoutMs: 100, captionTimeoutMs: 100 } : {};
      if (mode === 'refused') {
        const port = await closedPort();
        const made = makeClient(`http://127.0.0.1:${port}`, timeouts);
        const err = await caught(call(made.client));
        return { err, logs: made.calls, port: String(port) };
      }
      server.setHandler(() => mode);
      const made = makeClient(server.baseUrl, timeouts);
      const err = await caught(call(made.client));
      return { err, logs: made.calls, port: new URL(server.baseUrl).port };
    }

    describe.each(MODES)('%s', (_label, mode, opts) => {
      const calls = SECRET_CALLS.filter(([name]) => !opts?.only || opts.only.includes(name));
      const slow = opts?.slow ?? false;

      it.each(calls)(
        'T-ERR-7 %s의 오류에 표식, 토큰, 주소, 포트, cause가 없다',
        async (_name, call) => {
          const { err, port } = await runSecret(mode, call, slow);
          expect(err).toBeInstanceOf(Error);
          const typed = err as Error;
          const text = [typed.message, String(err), JSON.stringify(err)].join('\n');
          // 자기 속성(stack 포함)까지 문자열로 펼쳐 표식·토큰을 본다
          const own = Object.getOwnPropertyNames(typed)
            .map((k) => String((typed as unknown as Record<string, unknown>)[k]))
            .join('\n');
          for (const t of [text, own]) {
            expect(t).not.toContain('SECRET-');
            expect(t).not.toContain(TOKEN);
          }
          expect(text).not.toContain('127.0.0.1');
          expect(text).not.toContain(port);
          // ★ 원래 오류를 cause로 붙이면 호스트·포트·응답 일부가 샌다
          expect(typed.cause).toBeUndefined();
        },
      );

      it.each(calls)(
        'T-LOG-3a %s의 실패 로그 인자에 표식, 토큰, 경로, 문서 id가 없다',
        async (_name, call) => {
          const { logs } = await runSecret(mode, call, slow);
          // 실패 로그가 하나도 없으면 아래 단언이 헛돈다
          expect(logs.length).toBeGreaterThan(0);
          const text = JSON.stringify(logs.map((l) => l.args));
          expect(text).not.toContain('SECRET-');
          expect(text).not.toContain(TOKEN);
          // ★ 아래 둘은 MODULE.md 「로그」가 허용 필드를 operation·status·code·elapsedMs로 닫은 데 기댄다.
          // 명세가 docId 등을 허용 필드에 넣으면 이 두 줄을 함께 고친다
          expect(text).not.toContain('/v1/');
          expect(text).not.toContain('doc-001');
        },
      );
    });
  });

  describe('T-ERR-8 오류 메시지 형식', () => {
    it('RagRequestError는 한국어 메시지를 가진다', () => {
      // 클라이언트로 가는 메시지는 한국어다(AGENTS.md). 메시지에 상태·코드를 담는 것은
      // 구현 결정이라 단언하지 않는다 — status·code 속성이 공개 계약이다
      const err = new RagRequestError(409, 'DOCUMENT_NOT_SEARCHABLE');
      expect(err.message).toMatch(/[가-힣]/);
    });

    it('RagUnavailableError는 한국어 문장이고 내부 정보가 없다', async () => {
      server.setHandler(() => ({ status: 503 }));
      const err = (await caught(client.search({ query: 'q' }))) as Error;
      expect(err.message).toMatch(/[가-힣]/);
      expect(err.message).not.toContain('127.0.0.1');
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain('/v1/');
    });
  });

  describe('T-LOG-1 실패마다 rag.call_failed 한 번', () => {
    // 이벤트명·warn 수준·필드 넷은 MODULE.md 「로그」에 있다. 다른 수준의 로그를 더하는 것은 막지 않는다
    it('evaluate 409는 warn 한 번이고 필드가 넷뿐이다', async () => {
      server.setHandler(() => ({
        status: 409,
        json: { error: { code: 'DOCUMENT_NOT_SEARCHABLE', message: 'm' } },
      }));
      await caught(client.evaluate({ query: 'q', docId: 'doc-001', answerSpan: 's' }));
      const warns = logCalls.filter((c) => c.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.args).toEqual([
        {
          operation: 'evaluate',
          status: 409,
          code: 'DOCUMENT_NOT_SEARCHABLE',
          elapsedMs: expect.any(Number) as number,
        },
        'rag.call_failed',
      ]);
      const fields = warns[0]?.args[0] as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual(['code', 'elapsedMs', 'operation', 'status']);
      expect(fields.elapsedMs as number).toBeGreaterThanOrEqual(0);
    });
  });

  describe('T-LOG-2 상황별 status·code', () => {
    // rag MODULE.md 「로그」(rag.call_failed)는 필드 이름만 정하므로
    // 서버가 준 코드(503 SERVER_NOT_READY, UNKNOWN)만 값을 고정하고, 구현이 정한 내부 코드
    // (CONNECTION_FAILED·TIMEOUT·INVALID_RESPONSE)는 비어 있지 않은 문자열인지만 본다
    /** 실패 로그 필드를 읽는다. */
    const fieldsOf = (calls: LogCall[]): Record<string, unknown> =>
      calls.find((c) => c.level === 'warn')?.args[0] as Record<string, unknown>;

    /** 내부 코드 경우의 공통 단언이다. */
    const expectInternalFailure = (calls: LogCall[], operation: string): void => {
      const fields = fieldsOf(calls);
      expect(fields.operation).toBe(operation);
      expect(typeof fields.code).toBe('string');
      expect((fields.code as string).length).toBeGreaterThan(0);
      expect(fields.status === null || typeof fields.status === 'number').toBe(true);
    };

    it('연결 거부도 한 번 기록한다', async () => {
      const port = await closedPort();
      const made = makeClient(`http://127.0.0.1:${port}`);
      await caught(made.client.getIndexState('doc-001'));
      expectInternalFailure(made.calls, 'getIndexState');
    });

    it('시간 초과도 기록한다', async () => {
      const made = makeClient(server.baseUrl, { timeoutMs: 150 });
      server.setHandler(() => ({ status: 200, json: {}, delayMs: 600 }));
      await caught(made.client.getIndexState('doc-001'));
      expectInternalFailure(made.calls, 'getIndexState');
    });

    it('본문 읽는 중 시간 초과도 기록한다', async () => {
      const made = makeClient(server.baseUrl, { timeoutMs: 150 });
      server.setHandler(() => ({ status: 200, json: { doc_id: 'doc-001' }, stallBodyMs: 600 }));
      await caught(made.client.getIndexState('doc-001'));
      expectInternalFailure(made.calls, 'getIndexState');
    });

    it('T-LOG-2 본문 읽는 중 연결이 끊겨도 RagUnavailableError이고 기록한다', async () => {
      const made = makeClient(server.baseUrl);
      server.setHandler(() => ({ status: 200, json: { doc_id: 'doc-001' }, dropBody: true }));
      const err = await caught(made.client.getIndexState('doc-001'));
      expect(err).toBeInstanceOf(RagUnavailableError);
      expectInternalFailure(made.calls, 'getIndexState');
    });

    it('503 SERVER_NOT_READY는 status 503과 그 코드', async () => {
      server.setHandler(() => ({
        status: 503,
        json: { error: { code: 'SERVER_NOT_READY', message: 'm' } },
      }));
      await caught(client.getIndexState('doc-001'));
      expect(fieldsOf(logCalls)).toMatchObject({
        operation: 'getIndexState',
        status: 503,
        code: 'SERVER_NOT_READY',
      });
    });

    it('502 HTML은 status 502, UNKNOWN', async () => {
      server.setHandler(() => ({ status: 502, raw: '<html/>', contentType: 'text/html' }));
      await caught(client.search({ query: 'q' }));
      expect(fieldsOf(logCalls)).toMatchObject({
        operation: 'search',
        status: 502,
        code: 'UNKNOWN',
      });
    });

    it('200 not json도 기록한다', async () => {
      server.setHandler(() => ({ status: 200, raw: 'not json', contentType: 'text/plain' }));
      await caught(client.getIndexJob('job-ok'));
      expectInternalFailure(logCalls, 'getIndexJob');
    });
  });

  it.each(CALLS)('T-LOG-3b %s의 성공 호출은 실패 로그를 남기지 않는다', async (_name, call) => {
    await call(client);
    // 실패 이벤트만 MODULE.md에 있다. 성공 로그를 더하는 것은 막지 않되 토큰은 새지 않아야 한다
    expect(logCalls.filter((c) => c.args.includes('rag.call_failed'))).toEqual([]);
    expect(JSON.stringify(logCalls.map((c) => c.args))).not.toContain(TOKEN);
  });
});

describe('REQ-BE-10.1.3', () => {
  /** 일반 호출 제한(ms)이다. */
  const TIMEOUT_MS = 200;
  /** 요약·캡션 제한(ms)이다. */
  const CAPTION_TIMEOUT_MS = 1000;
  const GENERAL_DELAY = 1500;
  const MID_DELAY = 500;
  const LONG_DELAY = 3000;

  let timed: RagClient;

  beforeEach(() => {
    ({ client: timed } = makeClient(server.baseUrl, {
      timeoutMs: TIMEOUT_MS,
      captionTimeoutMs: CAPTION_TIMEOUT_MS,
    }));
  });

  /** 모든 경로에 같은 지연을 건 정상 응답을 쓴다. */
  const delayed = (delayMs: number) => (req: RecordedRequest) => ({ ...okHandler(req), delayMs });

  /** 걸린 시간(ms)을 잰다. */
  async function elapsed(promise: Promise<unknown>): Promise<{ err: unknown; ms: number }> {
    const start = Date.now();
    const err = await caught(promise);
    return { err, ms: Date.now() - start };
  }

  it.each(GENERAL_OPS)('T-TMO-1 %s는 RAG_TIMEOUT_MS에서 끝난다', async (_name, call) => {
    server.setHandler(delayed(GENERAL_DELAY));
    const { err, ms } = await elapsed(call(timed));
    expect(err).toBeInstanceOf(RagUnavailableError);
    expect(ms).toBeGreaterThanOrEqual(180);
    expect(ms).toBeLessThan(1000);
  });

  it.each(CAPTION_OPS)('T-TMO-2 %s는 일반 제한을 쓰지 않는다', async (_name, call) => {
    server.setHandler(delayed(MID_DELAY));
    await expect(call(timed)).resolves.toEqual(expect.any(String));
  });

  it.each(CAPTION_OPS)(
    'T-TMO-3 %s는 RAG_CAPTION_TIMEOUT_MS에서 끝난다',
    async (_name, call) => {
      server.setHandler(delayed(LONG_DELAY));
      const { err, ms } = await elapsed(call(timed));
      expect(err).toBeInstanceOf(RagUnavailableError);
      expect(ms).toBeGreaterThanOrEqual(950);
      expect(ms).toBeLessThan(2500);
    },
    10_000,
  );

  it('T-TMO-4 응답 헤더 뒤 본문이 멈춰도 제한에서 끝난다', async () => {
    server.setHandler(() => ({
      status: 200,
      json: { doc_id: 'doc-001' },
      stallBodyMs: GENERAL_DELAY,
    }));
    const { err, ms } = await elapsed(timed.getIndexState('doc-001'));
    expect(err).toBeInstanceOf(RagUnavailableError);
    // 즉시 실패(잘못된 주소 등)가 아니라 제한(200ms)에서 끝났음을 하한으로 고정한다
    expect(ms).toBeGreaterThanOrEqual(180);
    expect(ms).toBeLessThan(1000);
  });

  describe('T-TMO-5 getIndexStates는 요청마다 시간 제한을 건다', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `doc-${String(i).padStart(3, '0')}`);

    it('요청마다 제한 안이면 합계가 제한을 넘어도 성공한다', async () => {
      // 요청당 350ms(제한 600ms 안, 여유 250ms), 3요청 합계 약 1050ms(제한 밖)
      const { client: wide } = makeClient(server.baseUrl, { timeoutMs: 600 });
      server.setHandler((req) => ({ ...okHandler(req), delayMs: 350 }));
      const start = Date.now();
      const result = await wide.getIndexStates(ids);
      const ms = Date.now() - start;
      expect(result.map((s) => s.docId)).toEqual(ids);
      expect(server.requests).toHaveLength(3);
      // 차례로 불렀다면 합계가 제한을 넘는다. 아니면 이 테스트는 "요청마다"를 구분하지 못한다
      expect(ms).toBeGreaterThanOrEqual(700);
    });

    it.each([
      [503, RagUnavailableError],
      [409, RagRequestError],
    ] as const)(
      '두 번째 묶음이 %i이면 그 오류를 던지고 세 번째 요청은 가지 않는다',
      async (status, errorClass) => {
        server.setHandler((req) =>
          server.requests.length === 2
            ? { status, json: { error: { code: 'SECOND_BATCH', message: 'm' } } }
            : okHandler(req),
        );
        const err = await caught(timed.getIndexStates(ids));
        expect(err).toBeInstanceOf(errorClass);
        // 늦게 가는 요청이 없는지 잠시 기다린 뒤 센다
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(server.requests).toHaveLength(2);
      },
    );
  });
});

describe('REQ-BE-10.1.4', () => {
  it.each(CALLS)('T-TOK-1a %s의 모든 요청에 토큰 헤더가 있다', async (_name, call) => {
    await call(client);
    expect(server.requests.length).toBeGreaterThan(0);
    for (const req of server.requests) expect(req.headers['x-minerva-token']).toBe(TOKEN);
  });

  it('T-TOK-1b getIndexStates 250개의 세 요청 모두에 토큰 헤더가 있다', async () => {
    await client.getIndexStates(Array.from({ length: 250 }, (_, i) => `doc-${i}`));
    expect(server.requests).toHaveLength(3);
    for (const req of server.requests) expect(req.headers['x-minerva-token']).toBe(TOKEN);
  });

  it.each([503, 409])('T-TOK-2 %i 응답을 받는 요청에도 토큰 헤더가 있다', async (status) => {
    server.setHandler(() => ({ status, json: { error: { code: 'X', message: 'm' } } }));
    await caught(client.search({ query: 'q' }));
    expect(server.requests[0]?.headers['x-minerva-token']).toBe(TOKEN);
  });

  it.each([301, 302, 303, 307, 308])(
    'T-TOK-3 %i 리다이렉트로 토큰이 설정 주소 밖으로 나가지 않는다',
    async (status) => {
      const target = await startFakeRagServer();
      try {
        server.setHandler(() => ({
          status,
          headers: { location: `${target.baseUrl}/v1/search` },
        }));
        const err = await caught(client.search({ query: 'q' }));
        // ★ 핵심 단언: 다른 출처로 요청(토큰)이 가지 않는다
        expect(target.requests).toHaveLength(0);
        // 리다이렉트를 따르지 않고(redirect: 'error') RagUnavailableError로 끝낸다
        expect(err).toBeInstanceOf(RagUnavailableError);
      } finally {
        await target.close();
      }
    },
  );
});
