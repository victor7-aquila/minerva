import 'reflect-metadata';
import { RagUnavailableError } from '../../common';
import { RagRequestError } from '../../rag';
import type { RagSearchRequest, RagSearchResult } from '../../rag';
import { createLogCapture } from '../../../test/support/log-capture';
import {
  CHUNK_SENT,
  DOC_A,
  DOC_B,
  DOC_C,
  DOC_D,
  LABEL_SENT,
  NAME_SENT,
  QUERY_SENT,
  buildSearchTestModule,
  ragChunk,
  ragResult,
  searchBody,
} from '../../../test/support/search-fixtures';
import type { SearchTestModule } from '../../../test/support/search-fixtures';
import type { SearchResponseView } from '../interfaces/search.types';

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];

let t: SearchTestModule;

beforeEach(async () => {
  capture.clear();
  t = await buildSearchTestModule({ stream: capture.stream });
});

afterEach(async () => {
  await t.close();
});

/** 검색을 부른다. 동기 예외도 거부로 바꿔 같은 방식으로 단언한다. */
async function run(plain: Record<string, unknown>): Promise<SearchResponseView> {
  return t.service.search(searchBody(plain));
}

/** 가짜 RAG가 받은 첫 요청이다. */
function ragRequest(): RagSearchRequest {
  expect(t.rag.search).toHaveBeenCalledTimes(1);
  return t.rag.search.mock.calls[0][0];
}

/** 가짜 RAG가 결과를 주게 한다. */
function ragReturns(results: RagSearchResult[]): void {
  t.rag.search.mockResolvedValue(results);
}

/** 보이는 문서만 남기게 한다. */
function visibleOnly(...ids: string[]): void {
  t.documents.visibleDocIds.mockResolvedValue(new Set(ids));
}

/** search.done 로그 줄들이다. */
function doneLines(): Array<Record<string, unknown>> {
  return capture.parsed().filter((line) => line.msg === 'search.done');
}

describe('REQ-BE-4.1.1', () => {
  it('T-REQ-1 모든 조건을 RAG Server 요청 필드로 대응시킨다', async () => {
    t.documents.resolveNames.mockResolvedValue([DOC_A, DOC_B]);
    await run({
      query: 'q',
      top_n: 7,
      names: ['N'],
      edition_scope: 'specific',
      edition: { name: 'N', label: 'v1' },
      expand_neighbors: true,
    });
    const req = ragRequest();
    expect(req).toEqual({
      query: 'q',
      topN: 7,
      docIds: [DOC_A, DOC_B],
      editionScope: 'specific',
      edition: { name: 'N', label: 'v1' },
      expandNeighbors: true,
    });
    expect(Object.keys(req)).toHaveLength(6);
  });

  it('T-REQ-2 빠진 선택 필드는 Backend 기본값(all·false)을 채우고 top_n은 보내지 않는다', async () => {
    await run({ query: 'q' });
    const req = ragRequest();
    expect(Object.keys(req).sort()).toEqual(['editionScope', 'expandNeighbors', 'query']);
    expect(req.editionScope).toBe('all');
    expect(req.expandNeighbors).toBe(false);
  });

  it('T-REQ-3 edition은 specific일 때만 보내고 다듬은 값을 보낸다. null은 빠진 것과 같다', async () => {
    await run({ query: 'q', edition_scope: 'latest', edition: { name: 'N', label: 'v1' } });
    const latest = ragRequest();
    expect(Object.keys(latest)).not.toContain('edition');
    expect(latest.editionScope).toBe('latest');

    t.rag.search.mockClear();
    await run({
      query: 'q',
      edition_scope: 'specific',
      edition: { name: '  N  ', label: ' v1 ' },
    });
    expect(ragRequest().edition).toEqual({ name: 'N', label: 'v1' });

    t.rag.search.mockClear();
    await run({
      query: 'q',
      top_n: null,
      names: null,
      edition_scope: null,
      edition: null,
      expand_neighbors: null,
    });
    const nulls = ragRequest();
    expect(Object.keys(nulls).sort()).toEqual(['editionScope', 'expandNeighbors', 'query']);
    expect(nulls.editionScope).toBe('all');
    expect(nulls.expandNeighbors).toBe(false);
  });

  it('T-REQ-4 query는 다듬지 않고 그대로 보낸다', async () => {
    await run({ query: '  공백 포함 질의  ' });
    expect(ragRequest().query).toBe('  공백 포함 질의  ');
  });
});

describe('REQ-BE-4.1.2', () => {
  it('T-NAME-1 이름을 문서 ID로 바꿔 보낸다. 판이 둘인 이름은 ID도 둘이다', async () => {
    t.documents.resolveNames.mockResolvedValue([DOC_A, DOC_B]);
    await run({ query: 'q', names: ['N'] });
    expect(t.documents.resolveNames).toHaveBeenCalledTimes(1);
    expect(t.documents.resolveNames).toHaveBeenCalledWith(['N']);
    expect(ragRequest().docIds).toEqual([DOC_A, DOC_B]);
  });

  it('T-NAME-2 바꾼 결과가 비면 RAG Server를 부르지 않고 빈 결과를 준다', async () => {
    t.documents.resolveNames.mockResolvedValue([]);
    const res = await run({ query: 'q', names: ['없는 이름'] });
    expect(res).toEqual({ results: [] });
    expect(t.rag.search).not.toHaveBeenCalled();
    expect(t.documents.visibleDocIds).not.toHaveBeenCalled();
    expect(t.assets.restore).not.toHaveBeenCalled();
  });

  it('T-NAME-3 names가 빈 배열이면 빈 결과다', async () => {
    const res = await run({ query: 'q', names: [] });
    expect(res).toEqual({ results: [] });
    expect(t.rag.search).not.toHaveBeenCalled();
  });

  it('T-NAME-4 names가 없거나 null이면 이름 범위 없이 검색한다', async () => {
    await run({ query: 'q' });
    expect(Object.keys(ragRequest())).not.toContain('docIds');
    t.rag.search.mockClear();
    await run({ query: 'q', names: null });
    expect(Object.keys(ragRequest())).not.toContain('docIds');
    expect(t.documents.resolveNames).not.toHaveBeenCalled();
  });

  it('T-NAME-5 이름은 앞뒤 공백을 뗀 값으로 조회한다', async () => {
    t.documents.resolveNames.mockResolvedValue([DOC_A]);
    await run({ query: 'q', names: [' A ', 'B'] });
    expect(t.documents.resolveNames).toHaveBeenCalledWith(['A', 'B']);
  });
});

describe('REQ-BE-4.1.3', () => {
  it('T-ANS-1 응답은 results뿐이고 본문은 복원한 청크뿐이다', async () => {
    ragReturns([
      ragResult({ rank: 1, docId: DOC_A, version: '3', chunks: [ragChunk('가')] }),
      ragResult({ rank: 2, docId: DOC_B, version: '1', chunks: [ragChunk('나')] }),
    ]);
    const res = await run({ query: 'q' });
    expect(Object.keys(res)).toEqual(['results']);
    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.markdown)).toEqual(['R[3]가', 'R[1]나']);
  });
});

describe('REQ-BE-4.2.1', () => {
  it('T-RES-1 chunks·before·after 본문마다 결과의 version으로 복원한다', async () => {
    ragReturns([
      ragResult({
        docId: DOC_A,
        version: '7',
        chunks: [ragChunk('본문 [[minerva:table:t1 | 표]]')],
        before: [ragChunk('앞1'), ragChunk('앞2')],
        after: [ragChunk('뒤1')],
      }),
    ]);
    const res = await run({ query: 'q', expand_neighbors: true });
    expect(t.assets.restore).toHaveBeenCalledTimes(4);
    const calls = t.assets.restore.mock.calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        [DOC_A, '7', '본문 [[minerva:table:t1 | 표]]'],
        [DOC_A, '7', '앞1'],
        [DOC_A, '7', '앞2'],
        [DOC_A, '7', '뒤1'],
      ]),
    );
    expect(res.results[0].markdown).toBe('R[7]본문 [[minerva:table:t1 | 표]]');
    expect(res.results[0].before).toEqual(['R[7]앞1', 'R[7]앞2']);
    expect(res.results[0].after).toEqual(['R[7]뒤1']);
  });

  it('T-RES-2 여러 조각 청크는 RAG가 준 순서로 줄바꿈 하나로 잇는다', async () => {
    ragReturns([
      ragResult({
        version: '3',
        chunks: [
          ragChunk('가', { splitIndex: 0, splitTotal: 3 }),
          ragChunk('나', { splitIndex: 1, splitTotal: 3 }),
          ragChunk('다', { splitIndex: 2, splitTotal: 3 }),
        ],
      }),
    ]);
    const res = await run({ query: 'q' });
    expect(res.results[0].markdown).toBe('R[3]가\nR[3]나\nR[3]다');
  });

  it('T-RES-3 결과마다 그 결과의 문서·버전으로 복원한다', async () => {
    ragReturns([
      ragResult({ rank: 1, docId: DOC_A, version: '3', chunks: [ragChunk('가')] }),
      ragResult({ rank: 2, docId: DOC_B, version: '1', chunks: [ragChunk('나')] }),
    ]);
    await run({ query: 'q' });
    const calls = t.assets.restore.mock.calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        [DOC_A, '3', '가'],
        [DOC_B, '1', '나'],
      ]),
    );
    expect(calls).toHaveLength(2);
  });

  it('T-RES-4 before·after가 비면 응답도 빈 배열이고 chunks만 복원한다', async () => {
    ragReturns([ragResult({ chunks: [ragChunk('가'), ragChunk('나')] })]);
    const res = await run({ query: 'q' });
    expect(res.results[0].before).toEqual([]);
    expect(res.results[0].after).toEqual([]);
    expect(t.assets.restore).toHaveBeenCalledTimes(2);
  });

  it('T-RES-5 빠진 결과는 복원하지 않는다', async () => {
    ragReturns([ragResult({ rank: 1, docId: DOC_A }), ragResult({ rank: 2, docId: DOC_B })]);
    visibleOnly(DOC_A);
    await run({ query: 'q' });
    const restoredDocs = t.assets.restore.mock.calls.map((call) => call[0]);
    expect(restoredDocs).not.toContain(DOC_B);
    expect(restoredDocs).toContain(DOC_A);
  });
});

describe('REQ-BE-4.2.2', () => {
  it('T-VIS-1 보이지 않는 문서의 결과를 빼고 순위를 1부터 다시 매긴다', async () => {
    ragReturns([
      ragResult({ rank: 1, docId: DOC_A }),
      ragResult({ rank: 2, docId: DOC_B }),
      ragResult({ rank: 3, docId: DOC_C }),
    ]);
    visibleOnly(DOC_A, DOC_C);
    const res = await run({ query: 'q' });
    expect(res.results).toHaveLength(2);
    expect(res.results.map((r) => r.rank)).toEqual([1, 2]);
    expect(res.results.map((r) => r.doc_id)).toEqual([DOC_A, DOC_C]);
  });

  it('T-VIS-2 같은 문서의 결과가 띄엄띄엄 있어도 남은 결과로 다시 매긴다', async () => {
    ragReturns([
      ragResult({ rank: 1, docId: DOC_B, score: 0.4 }),
      ragResult({ rank: 2, docId: DOC_A, score: 0.3 }),
      ragResult({ rank: 3, docId: DOC_B, score: 0.2 }),
      ragResult({ rank: 4, docId: DOC_A, score: 0.1 }),
    ]);
    visibleOnly(DOC_A);
    const res = await run({ query: 'q' });
    expect(res.results.map((r) => r.doc_id)).toEqual([DOC_A, DOC_A]);
    expect(res.results.map((r) => r.rank)).toEqual([1, 2]);
    expect(res.results.map((r) => r.score)).toEqual([0.3, 0.1]);
  });

  it('T-VIS-3 모두 보이지 않으면 빈 결과이고 복원하지 않는다', async () => {
    ragReturns([ragResult({ rank: 1, docId: DOC_A }), ragResult({ rank: 2, docId: DOC_B })]);
    visibleOnly();
    const res = await run({ query: 'q' });
    expect(res).toEqual({ results: [] });
    expect(t.assets.restore).not.toHaveBeenCalled();
  });

  it('T-VIS-4 RAG 결과가 없으면 가시성 조회를 하지 않는다', async () => {
    ragReturns([]);
    const res = await run({ query: 'q' });
    expect(res).toEqual({ results: [] });
    expect(t.documents.visibleDocIds).not.toHaveBeenCalled();
  });

  it('T-VIS-5 RAG의 rank 순서로 정렬해 다시 매긴다', async () => {
    ragReturns([
      ragResult({ rank: 3, score: 0.3, docId: DOC_C }),
      ragResult({ rank: 1, score: 0.1, docId: DOC_A }),
      ragResult({ rank: 2, score: 0.2, docId: DOC_B }),
    ]);
    const res = await run({ query: 'q' });
    expect(res.results.map((r) => r.score)).toEqual([0.1, 0.2, 0.3]);
    expect(res.results.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('T-VIS-6 가시성은 결과의 문서 ID를 중복 없이 한 번에 묻는다', async () => {
    ragReturns([
      ragResult({ rank: 1, docId: DOC_A }),
      ragResult({ rank: 2, docId: DOC_B }),
      ragResult({ rank: 3, docId: DOC_A }),
    ]);
    await run({ query: 'q' });
    expect(t.documents.visibleDocIds).toHaveBeenCalledTimes(1);
    const arg = t.documents.visibleDocIds.mock.calls[0][0];
    expect(new Set(arg)).toEqual(new Set([DOC_A, DOC_B]));
    expect(arg).toHaveLength(2);
  });
});

describe('REQ-BE-4.2.3', () => {
  it('T-FLD-1 결과 필드는 명세의 키만 있고 version이 없다', async () => {
    ragReturns([
      ragResult({
        score: 0.87,
        headingPath: ['인증서', '갱신'],
        edition: { label: '2025', editionDate: '2025-01-31', isLatest: true },
        otherEditionsInResults: false,
      }),
    ]);
    const res = await run({ query: 'q' });
    const result = res.results[0];
    expect(Object.keys(result).sort()).toEqual([
      'after',
      'before',
      'doc_id',
      'edition',
      'heading_path',
      'markdown',
      'name',
      'rank',
      'score',
    ]);
    expect(Object.keys(result)).not.toContain('version');
    expect(Object.keys(result.edition ?? {}).sort()).toEqual([
      'edition_date',
      'is_latest',
      'label',
      'other_editions_in_results',
    ]);
    expect(result.score).toBe(0.87);
    expect(result.heading_path).toEqual(['인증서', '갱신']);
    expect(result.edition).toEqual({
      label: '2025',
      edition_date: '2025-01-31',
      is_latest: true,
      other_editions_in_results: false,
    });
    expect(result.doc_id).toBe(DOC_A);
    expect(result.name).toBe(NAME_SENT);
  });

  it('T-FLD-2 판 정보가 없으면 edition은 null이다', async () => {
    ragReturns([ragResult({ edition: null, otherEditionsInResults: false })]);
    const res = await run({ query: 'q' });
    expect(res.results[0].edition).toBeNull();
  });

  describe('T-FLD-3 other_editions_in_results는 남은 결과 기준으로 다시 계산한다', () => {
    /** 판 정보가 있는 결과를 만든다. */
    const withEdition = (
      rank: number,
      docId: string,
      name: string,
      label: string,
      flag: boolean,
    ): RagSearchResult =>
      ragResult({
        rank,
        docId,
        name,
        edition: { label, editionDate: '2025-01-01', isLatest: false },
        otherEditionsInResults: flag,
      });

    it('(a) 다른 판 결과가 빠지면 거짓이 된다', async () => {
      ragReturns([
        withEdition(1, DOC_A, 'N', '2024', true),
        withEdition(2, DOC_B, 'N', '2025', true),
      ]);
      visibleOnly(DOC_A);
      const res = await run({ query: 'q' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].edition?.other_editions_in_results).toBe(false);
    });

    it('(b) 둘 다 남으면 둘 다 참이다', async () => {
      ragReturns([
        withEdition(1, DOC_A, 'N', '2024', true),
        withEdition(2, DOC_B, 'N', '2025', true),
      ]);
      const res = await run({ query: 'q' });
      expect(res.results.map((r) => r.edition?.other_editions_in_results)).toEqual([true, true]);
    });

    it('(c) 남은 결과가 같은 판뿐이면 거짓이다', async () => {
      ragReturns([
        withEdition(1, DOC_A, 'N', '2024', true),
        withEdition(2, DOC_B, 'N', '2024', true),
        withEdition(3, DOC_C, 'N', '2025', true),
      ]);
      visibleOnly(DOC_A, DOC_B);
      const res = await run({ query: 'q' });
      expect(res.results.map((r) => r.edition?.other_editions_in_results)).toEqual([false, false]);
    });

    it('(d) RAG 값이 거짓이면 참으로 올리지 않는다', async () => {
      ragReturns([
        withEdition(1, DOC_A, 'N', '2024', false),
        withEdition(2, DOC_B, 'N', '2025', false),
      ]);
      const res = await run({ query: 'q' });
      expect(res.results.map((r) => r.edition?.other_editions_in_results)).toEqual([false, false]);
    });

    it('(e) 판 정보가 없는 같은 이름 결과는 다른 판으로 센다', async () => {
      ragReturns([
        withEdition(1, DOC_A, 'N', '2024', true),
        ragResult({
          rank: 2,
          docId: DOC_D,
          name: 'N',
          edition: null,
          otherEditionsInResults: false,
        }),
      ]);
      const res = await run({ query: 'q' });
      expect(res.results[0].edition?.other_editions_in_results).toBe(true);
      expect(res.results[1].edition).toBeNull();
    });

    it('(f) 이름이 다르면 다른 판으로 세지 않는다', async () => {
      ragReturns([
        withEdition(1, DOC_A, 'N', '2024', true),
        withEdition(2, DOC_B, 'M', '2025', true),
      ]);
      const res = await run({ query: 'q' });
      expect(res.results.map((r) => r.edition?.other_editions_in_results)).toEqual([false, false]);
    });
  });

  it('T-FLD-4 is_latest는 RAG 값 그대로다', async () => {
    ragReturns([
      ragResult({ edition: { label: '2025', editionDate: '2025-01-31', isLatest: false } }),
    ]);
    const res = await run({ query: 'q' });
    expect(res.results[0].edition?.is_latest).toBe(false);
  });
});

describe('REQ-BE-10.1.2', () => {
  it('T-ERR-1 RagUnavailableError는 그대로 전파하고 완료 로그를 남기지 않는다', async () => {
    const err = new RagUnavailableError();
    t.rag.search.mockRejectedValue(err);
    await expect(run({ query: 'q' })).rejects.toBe(err);
    expect(doneLines()).toHaveLength(0);
  });

  it('T-ERR-2 RagRequestError는 RagUnavailableError로 바꿔 던진다', async () => {
    for (const error of [
      new RagRequestError(500, 'VECTOR_DIMENSION_MISMATCH'),
      new RagRequestError(400, 'INVALID_REQUEST'),
    ]) {
      t.rag.search.mockRejectedValue(error);
      const caught: unknown = await run({ query: 'q' }).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(RagUnavailableError);
      expect((caught as RagUnavailableError).code).toBe('RAG_UNAVAILABLE');
    }
  });

  it('T-ERR-3 그 밖의 예외는 바꾸지 않고 다시 던진다', async () => {
    const err = new Error('boom');
    t.rag.search.mockRejectedValue(err);
    await expect(run({ query: 'q' })).rejects.toBe(err);
  });
});

describe('REQ-BE-8.2.1', () => {
  /** search.done 줄 하나를 꺼낸다. */
  function onlyDone(): Record<string, unknown> {
    const lines = doneLines();
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  /** 기본 필드를 뺀 키 목록이다. */
  function fieldKeys(line: Record<string, unknown>): string[] {
    return Object.keys(line)
      .filter((key) => !PINO_BASE.includes(key))
      .sort();
  }

  const EXPECTED_KEYS = ['elapsedMs', 'names', 'queryChars', 'ragResults', 'removed'];

  it('T-LOG-1 search.done은 개수·시간 필드만 남긴다', async () => {
    // (a) 이름 2개, RAG 결과 3개 중 1개 빠짐
    t.documents.resolveNames.mockResolvedValue([DOC_A, DOC_B]);
    ragReturns([
      ragResult({ rank: 1, docId: DOC_A }),
      ragResult({ rank: 2, docId: DOC_B }),
      ragResult({ rank: 3, docId: DOC_C }),
    ]);
    visibleOnly(DOC_A, DOC_B);
    await run({ query: '인증서 갱신', names: ['N', 'M'] });
    let line = onlyDone();
    expect(line.level).toBe(30);
    expect(line.context).toBe('SearchService');
    expect(fieldKeys(line)).toEqual(EXPECTED_KEYS);
    expect(line.queryChars).toBe(6);
    expect(line.names).toBe(2);
    expect(line.ragResults).toBe(3);
    expect(line.removed).toBe(1);
    expect(Number.isInteger(line.elapsedMs)).toBe(true);
    expect(line.elapsedMs as number).toBeGreaterThanOrEqual(0);

    // (b) names 없음, 결과 0개
    capture.clear();
    t.rag.search.mockResolvedValue([]);
    await run({ query: 'q' });
    line = onlyDone();
    expect(fieldKeys(line)).toEqual(EXPECTED_KEYS);
    expect(line.names).toBeNull();
    expect(line.ragResults).toBe(0);
    expect(line.removed).toBe(0);

    // (c) 이름이 빈 결과로 바뀐 경로도 남긴다
    capture.clear();
    t.documents.resolveNames.mockResolvedValue([]);
    await run({ query: 'q', names: ['없는 이름'] });
    line = onlyDone();
    expect(fieldKeys(line)).toEqual(EXPECTED_KEYS);
    expect(line.ragResults).toBe(0);
    expect(line.removed).toBe(0);
    expect(line.names).toBe(1);

    // (d) 글자 수는 코드 포인트 기준이다
    capture.clear();
    await run({ query: '😀a' });
    expect(onlyDone().queryChars).toBe(2);
  });

  it('T-LOG-2 질의·이름·판 표기·본문·문서 ID를 로그에 남기지 않는다', async () => {
    const input = {
      query: QUERY_SENT,
      names: [NAME_SENT],
      edition_scope: 'specific',
      edition: { name: NAME_SENT, label: LABEL_SENT },
    };
    t.documents.resolveNames.mockResolvedValue([DOC_A]);
    ragReturns([
      ragResult({
        docId: DOC_A,
        name: NAME_SENT,
        edition: { label: LABEL_SENT, editionDate: '2025-01-31', isLatest: true },
        chunks: [ragChunk(CHUNK_SENT)],
      }),
    ]);
    await run(input);
    // 실패 경로도 한 번
    t.rag.search.mockRejectedValue(new RagRequestError(500, 'VECTOR_DIMENSION_MISMATCH'));
    await run(input).catch(() => undefined);

    const all = capture.lines.join('\n');
    for (const secret of ['QUERY-SENT-81', NAME_SENT, LABEL_SENT, CHUNK_SENT, DOC_A]) {
      expect(all).not.toContain(secret);
    }
  });
});
