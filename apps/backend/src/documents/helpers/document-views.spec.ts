import type { AssetViewData } from '../../assets';
import type { ProcessingState, SearchState } from '../../common';
import type { RagDocumentChunk } from '../../rag';
import { docRecord, versionRecord } from '../../../test/support/documents-fixtures';
import {
  compareDocuments,
  isLatestOrNoEdition,
  latestEditionDates,
  siblingEditions,
  toAssetView,
  toChunkView,
  toDetail,
  toRefView,
  toSummary,
} from './document-views';
import type { DocumentRecord } from '../interfaces/documents.types';

/** 판이 있는 문서를 만든다. */
function withEdition(
  docId: string,
  name: string,
  label: string,
  editionDate: string,
  over: Partial<DocumentRecord> = {},
): DocumentRecord {
  return docRecord({ docId, name, edition: { label, editionDate }, ...over });
}

/** 정렬 결과의 docId 목록이다. */
function sortedIds(
  docs: DocumentRecord[],
  column: Parameters<typeof compareDocuments>[0],
  order: 'asc' | 'desc',
): string[] {
  return [...docs].sort(compareDocuments(column, order)).map((doc) => doc.docId);
}

describe('REQ-BE-1.2.2', () => {
  it('T-VIEW-1 최신판만 거르기는 이름별 가장 늦은 검색 가능 판과 판 없는 문서를 남긴다', () => {
    const old = withEdition('old', 'N', 'v2022', '2022-01-01');
    const latest = withEdition('new', 'N', 'v2025', '2025-01-01');
    let latestMap = latestEditionDates([old, latest]);
    expect(isLatestOrNoEdition(latest, latestMap)).toBe(true);
    expect(isLatestOrNoEdition(old, latestMap)).toBe(false);

    // 2025판이 검색 안 됨이면 2022판이 최신이다
    const hidden = withEdition('new', 'N', 'v2025', '2025-01-01', {
      searchState: 'not_searchable',
    });
    latestMap = latestEditionDates([old, hidden]);
    expect(isLatestOrNoEdition(old, latestMap)).toBe(true);

    // 같은 날짜 판 둘은 모두 남는다
    const twin = withEdition('twin', 'N', 'v2025b', '2025-01-01');
    latestMap = latestEditionDates([latest, twin]);
    expect(isLatestOrNoEdition(latest, latestMap)).toBe(true);
    expect(isLatestOrNoEdition(twin, latestMap)).toBe(true);

    // 판 정보가 없는 문서는 언제나 남는다
    expect(isLatestOrNoEdition(docRecord({ edition: null }), new Map())).toBe(true);
  });
});

describe('REQ-BE-1.3.5', () => {
  const self = withEdition('self', 'N', 'v2022', '2022-01-01');
  const others = [
    withEdition('a', 'N', 'v2025', '2025-01-01'),
    withEdition('b', 'N', 'v2024', '2024-01-01'),
    withEdition('c', 'N', 'v2026', '2026-01-01', { searchState: 'not_searchable' }),
    withEdition('d', 'N', 'v2027', '2027-01-01', { deleted: true }),
    withEdition('e', 'M', 'v2028', '2028-01-01'),
    withEdition('f', 'N', 'v2025', '2025-01-01'),
  ];

  it('T-VIEW-2 판 칸은 자기 판과 같은 이름의 검색 가능 판을 날짜 내림차순으로 중복 없이 모은다', () => {
    const result = siblingEditions(self, [self, ...others]);
    expect(result).toEqual([
      { label: 'v2025', edition_date: '2025-01-01' },
      { label: 'v2024', edition_date: '2024-01-01' },
      { label: 'v2022', edition_date: '2022-01-01' },
    ]);
  });

  it('T-VIEW-2 자기 판 정보가 없으면 빈 목록이다', () => {
    expect(siblingEditions(docRecord({ docId: 'x', edition: null }), others)).toEqual([]);
  });

  it('T-VIEW-2 자기 문서가 검색 안 됨이어도 자기 판은 들어간다', () => {
    const hidden = withEdition('self', 'N', 'v2022', '2022-01-01', {
      searchState: 'not_searchable',
    });
    const result = siblingEditions(hidden, others);
    expect(result.map((edition) => edition.label)).toEqual(['v2025', 'v2024', 'v2022']);
  });

  it('T-VIEW-2 같은 날짜의 두 판은 판 표기 코드 포인트 순이다', () => {
    const mine = withEdition('self', 'N', 'b', '2025-05-05');
    const other = withEdition('o', 'N', 'a', '2025-05-05');
    expect(siblingEditions(mine, [other]).map((edition) => edition.label)).toEqual(['a', 'b']);
  });
});

describe('REQ-BE-1.3.2', () => {
  it('T-VIEW-3 search_state 열은 검색 가능 < 검색 안 됨 < 교체됨 순이다', () => {
    const states: SearchState[] = ['replaced', 'searchable', 'not_searchable'];
    const docs = states.map((state) => docRecord({ docId: state, searchState: state }));
    expect(sortedIds(docs, 'search_state', 'asc')).toEqual([
      'searchable',
      'not_searchable',
      'replaced',
    ]);
    expect(sortedIds(docs, 'search_state', 'desc')).toEqual([
      'replaced',
      'not_searchable',
      'searchable',
    ]);
  });

  it('T-VIEW-3 processing_state 열은 업로드됨부터 실패까지의 순서다', () => {
    const order: ProcessingState[] = [
      'uploaded',
      'captioning',
      'queued',
      'indexing',
      'completed',
      'failed',
    ];
    const docs = [...order]
      .reverse()
      .map((state) => docRecord({ docId: state, processingState: state }));
    expect(sortedIds(docs, 'processing_state', 'asc')).toEqual(order);
    expect(sortedIds(docs, 'processing_state', 'desc')).toEqual([...order].reverse());
  });

  it('T-VIEW-3 name 열은 코드 포인트 순이다', () => {
    const names = ['가', 'b', 'a', 'A'];
    const docs = names.map((name) => docRecord({ docId: name, name }));
    expect(sortedIds(docs, 'name', 'asc')).toEqual(['A', 'a', 'b', '가']);
    expect(sortedIds(docs, 'name', 'desc')).toEqual(['가', 'b', 'a', 'A']);
  });

  it('T-VIEW-3 uploaded_at·updated_at 열은 시각 순이다', () => {
    const t = (hour: number): Date => new Date(Date.UTC(2026, 9, 1, hour));
    const docs = [
      docRecord({ docId: 'x', uploadedAt: t(3), updatedAt: t(1) }),
      docRecord({ docId: 'y', uploadedAt: t(1), updatedAt: t(3) }),
      docRecord({ docId: 'z', uploadedAt: t(2), updatedAt: t(2) }),
    ];
    expect(sortedIds(docs, 'uploaded_at', 'asc')).toEqual(['y', 'z', 'x']);
    expect(sortedIds(docs, 'uploaded_at', 'desc')).toEqual(['x', 'z', 'y']);
    expect(sortedIds(docs, 'updated_at', 'asc')).toEqual(['x', 'z', 'y']);
    expect(sortedIds(docs, 'updated_at', 'desc')).toEqual(['y', 'z', 'x']);
  });

  it('T-VIEW-3 동점은 방향과 무관하게 updatedAt 늦은 순, 같으면 docId 오름차순이다', () => {
    const early = new Date('2026-10-01T00:00:00Z');
    const late = new Date('2026-10-02T00:00:00Z');
    const docs = [
      docRecord({ docId: 'b', name: 'same', updatedAt: early }),
      docRecord({ docId: 'c', name: 'same', updatedAt: late }),
      docRecord({ docId: 'a', name: 'same', updatedAt: early }),
    ];
    for (const order of ['asc', 'desc'] as const) {
      expect(sortedIds(docs, 'name', order)).toEqual(['c', 'a', 'b']);
    }
  });
});

describe('REQ-BE-1.3.8', () => {
  const extra = { siblings: [], stage: 'embedding' as const, failureMessage: 'FM' };

  it('T-VIEW-4 failure_message는 실패일 때만, stage는 색인 중일 때만 값이 있다', () => {
    expect(toSummary(docRecord({ processingState: 'failed' }), extra).failure_message).toBe('FM');
    expect(
      toSummary(docRecord({ processingState: 'completed' }), extra).failure_message,
    ).toBeNull();
    expect(toSummary(docRecord({ processingState: 'indexing' }), extra).stage).toBe('embedding');
    expect(toSummary(docRecord({ processingState: 'queued' }), extra).stage).toBeNull();
  });
});

describe('REQ-BE-1.4.2', () => {
  const base = { siblings: [], stage: 'embedding' as const, assets: [] };

  it('T-VIEW-5 상세는 상태에 맞는 결과·사유·단계를 담는다', () => {
    const completed = toDetail(
      docRecord({ processingState: 'completed' }),
      versionRecord({ result: { chunkCount: 7, fallbackUsed: true } }),
      base,
    );
    expect(completed.result).toEqual({ chunk_count: 7, fallback_used: true });
    expect(completed.failure).toBeNull();
    expect(completed.stage).toBeNull();

    const failed = toDetail(
      docRecord({ processingState: 'failed' }),
      versionRecord({
        result: null,
        failure: { code: 'C', message: 'M', headingPath: ['A', 'B'], placeholderId: 't1' },
      }),
      base,
    );
    expect(failed.failure).toEqual({
      code: 'C',
      message: 'M',
      heading_path: ['A', 'B'],
      placeholder_id: 't1',
    });
    expect(failed.result).toBeNull();

    const indexing = toDetail(docRecord({ processingState: 'indexing' }), versionRecord(), base);
    expect(indexing.stage).toBe('embedding');

    const uploaded = toDetail(
      docRecord({ processingState: 'uploaded' }),
      versionRecord({ result: null }),
      base,
    );
    expect(uploaded.stage).toBeNull();
    expect(uploaded.result).toBeNull();
    expect(uploaded.failure).toBeNull();
  });
});

describe('REQ-BE-1.6.4', () => {
  const summaryKeys = [
    'doc_id',
    'edition',
    'failure_message',
    'name',
    'processing_state',
    'search_state',
    'sibling_editions',
    'stage',
    'updated_at',
    'uploaded_at',
  ];
  const chunk: RagDocumentChunk = {
    chunkId: 'c1',
    order: 1,
    kind: 'text',
    headingPath: ['H'],
    title: null,
    summary: null,
    text: 'T',
    placeholderIds: [],
    splitIndex: null,
    splitTotal: null,
  };
  const asset: AssetViewData = {
    placeholderId: 't1',
    kind: 'table',
    tableMarkdown: '| a |',
    imageUrl: null,
    text: '요약',
    isTemporary: false,
  };

  it('T-VIEW-6 응답 모양의 키 집합이 API.md와 같고 version 키가 없다', () => {
    const extra = { siblings: [], stage: null, assets: [asset] };
    const summary = toSummary(docRecord(), { siblings: [], stage: null, failureMessage: null });
    const detail = toDetail(docRecord(), versionRecord(), extra);
    const assetView = toAssetView(asset);
    const chunkView = toChunkView(chunk, 'M');
    const ref = toRefView(docRecord());
    expect(Object.keys(summary).sort()).toEqual(summaryKeys);
    expect(Object.keys(detail).sort()).toEqual(
      [...summaryKeys, 'assets', 'failure', 'file_name', 'result'].sort(),
    );
    expect(Object.keys(assetView).sort()).toEqual([
      'image_url',
      'is_fallback',
      'kind',
      'placeholder_id',
      'table_markdown',
      'text',
    ]);
    expect(Object.keys(chunkView).sort()).toEqual([
      'heading_path',
      'kind',
      'markdown',
      'order',
      'split_index',
      'split_total',
      'summary',
      'title',
    ]);
    expect(Object.keys(ref).sort()).toEqual(['doc_id', 'edition', 'name']);
    for (const view of [summary, detail, assetView, chunkView, ref]) {
      expect(Object.keys(view)).not.toContain('version');
    }
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-VIEW-7 임시 설명인 표는 is_fallback이 참이고 이미지 주소는 null이다', () => {
    const view = toAssetView({
      placeholderId: 't1',
      kind: 'table',
      tableMarkdown: '| a |\n| --- |',
      imageUrl: null,
      text: '임시',
      isTemporary: true,
    });
    expect(view.is_fallback).toBe(true);
    expect(view.table_markdown).toBe('| a |\n| --- |');
    expect(view.image_url).toBeNull();
    expect(view.placeholder_id).toBe('t1');
    expect(view.kind).toBe('table');
    expect(view.text).toBe('임시');
  });
});

describe('REQ-BE-8.4.1', () => {
  it('T-VIEW-8 시각은 밀리초 없는 UTC 문자열이다', () => {
    const doc = docRecord({ uploadedAt: new Date('2026-10-04T05:05:31.123Z') });
    const summary = toSummary(doc, { siblings: [], stage: null, failureMessage: null });
    expect(summary.uploaded_at).toBe('2026-10-04T05:05:31Z');
  });
});
