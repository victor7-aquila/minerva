import type { AssetViewData } from '../../assets';
import type { RagDocumentChunk } from '../../rag';
import { docRecord, versionRecord } from '../../../test/support/documents-fixtures';
import {
  bucketWindows,
  latestEditionDates,
  latestEditionPairs,
  listSortSpec,
  siblingEditions,
  stateBucketOrder,
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

/** 쌍 목록을 이름 순으로 정렬한 복사본이다. ★ 쌍의 순서는 명세가 정하지 않아 정렬해 비교한다 */
function byName(pairs: Array<{ name: string; editionDate: string }>) {
  return [...pairs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

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
  it.each([
    ['name', 'asc', ['name', 'updatedAt', 'docId'], { name: 1, updatedAt: -1, docId: 1 }],
    ['name', 'desc', ['name', 'updatedAt', 'docId'], { name: -1, updatedAt: -1, docId: 1 }],
    [
      'uploaded_at',
      'asc',
      ['uploadedAt', 'updatedAt', 'docId'],
      { uploadedAt: 1, updatedAt: -1, docId: 1 },
    ],
    [
      'uploaded_at',
      'desc',
      ['uploadedAt', 'updatedAt', 'docId'],
      { uploadedAt: -1, updatedAt: -1, docId: 1 },
    ],
    ['updated_at', 'asc', ['updatedAt', 'docId'], { updatedAt: 1, docId: 1 }],
    ['updated_at', 'desc', ['updatedAt', 'docId'], { updatedAt: -1, docId: 1 }],
  ] as const)(
    'T-PR3-VIEW-1 listSortSpec(%s, %s)는 키 순서가 정렬 우선순위이고 동점은 방향과 무관하다',
    (column, order, keys, expected) => {
      const spec = listSortSpec(column, order);
      // ★ 키 순서가 곧 DB 정렬 우선순위다 — toEqual은 순서를 보지 않으므로 키 목록을 따로 비교한다
      expect(Object.keys(spec)).toEqual([...keys]);
      expect(spec).toEqual(expected);
    },
  );

  it('T-PR3-VIEW-2 stateBucketOrder는 열별 값 순서를 주고 desc는 뒤집는다', () => {
    const searchAsc = ['searchable', 'not_searchable', 'replaced'];
    const processingAsc = ['uploaded', 'captioning', 'queued', 'indexing', 'completed', 'failed'];
    expect(stateBucketOrder('search_state', 'asc')).toEqual(searchAsc);
    expect(stateBucketOrder('search_state', 'desc')).toEqual([...searchAsc].reverse());
    expect(stateBucketOrder('processing_state', 'asc')).toEqual(processingAsc);
    expect(stateBucketOrder('processing_state', 'desc')).toEqual([...processingAsc].reverse());
  });

  it('T-PR3-VIEW-2 반환값을 바꿔도 다음 호출에 영향이 없다', () => {
    for (const column of ['search_state', 'processing_state'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const expected = [...stateBucketOrder(column, order)];
        // ★ 모듈 상수를 그대로 돌려주면 호출자의 변경이 전역으로 번진다
        const first = stateBucketOrder(column, order) as string[];
        first.reverse();
        first.push('오염');
        expect(stateBucketOrder(column, order)).toEqual(expected);
      }
    }
  });

  it('T-PR3-VIEW-3 bucketWindows는 값 구간마다 가져올 범위를 준다', () => {
    // 값 0은 3건, 값 1은 0건, 값 2는 5건이다. skip 2, limit 4 → 값 0의 마지막 1건 + 값 2의 앞 3건
    expect(bucketWindows([3, 0, 5], 2, 4)).toEqual([
      { index: 0, skip: 2, limit: 1 },
      { index: 2, skip: 0, limit: 3 },
    ]);
    // 개수가 0인 값은 건너뛴다
    expect(bucketWindows([0, 4, 0], 0, 10)).toEqual([{ index: 1, skip: 0, limit: 4 }]);
    // 한 값 안에서 끝난다
    expect(bucketWindows([3, 5], 1, 2)).toEqual([{ index: 0, skip: 1, limit: 2 }]);
    // skip이 앞 값을 모두 넘어 뒤 값으로 들어간다
    expect(bucketWindows([3, 5], 3, 5)).toEqual([{ index: 1, skip: 0, limit: 5 }]);
    expect(bucketWindows([3, 5], 4, 2)).toEqual([{ index: 1, skip: 1, limit: 2 }]);
  });

  it('T-PR3-VIEW-3 범위를 넘는 skip은 빈 목록이다', () => {
    expect(bucketWindows([3, 0, 5], 8, 4)).toEqual([]);
    expect(bucketWindows([3, 0, 5], 100, 4)).toEqual([]);
    expect(bucketWindows([0, 0], 0, 4)).toEqual([]);
    expect(bucketWindows([], 0, 4)).toEqual([]);
  });

  it('T-PR3-VIEW-3 limit이 딱 맞으면 거기서 멈추고 남으면 끝까지 간다', () => {
    // limit을 값 0에서 다 채우면 값 1은 보지 않는다
    expect(bucketWindows([3, 5], 0, 3)).toEqual([{ index: 0, skip: 0, limit: 3 }]);
    // 앞 값 끝과 limit이 정확히 맞물려도 다음 값에서 0건짜리 구간을 만들지 않는다
    expect(bucketWindows([2, 2, 2], 2, 2)).toEqual([{ index: 1, skip: 0, limit: 2 }]);
    // limit이 전체보다 크면 가진 만큼만 준다
    expect(bucketWindows([3, 5], 2, 100)).toEqual([
      { index: 0, skip: 2, limit: 1 },
      { index: 1, skip: 0, limit: 5 },
    ]);
  });
});

describe('REQ-BE-1.3.3', () => {
  it('T-PR3-VIEW-4 latestEditionPairs는 이름별 가장 늦은 검색 가능 판 날짜를 쌍으로 준다', () => {
    const old = withEdition('old', 'N', 'v2022', '2022-01-01');
    const latest = withEdition('new', 'N', 'v2025', '2025-01-01');
    expect(latestEditionPairs([old, latest])).toEqual([{ name: 'N', editionDate: '2025-01-01' }]);

    // 2025판이 검색 안 됨이면 2022판이 최신이다
    const hidden = withEdition('new', 'N', 'v2025', '2025-01-01', {
      searchState: 'not_searchable',
    });
    expect(latestEditionPairs([old, hidden])).toEqual([{ name: 'N', editionDate: '2022-01-01' }]);

    // 같은 날짜 판 둘은 쌍 하나로 합쳐진다(둘 다 남기는 일은 조건 쪽이 한다)
    const twin = withEdition('twin', 'N', 'v2025b', '2025-01-01');
    expect(latestEditionPairs([latest, twin])).toEqual([{ name: 'N', editionDate: '2025-01-01' }]);
  });

  it('T-PR3-VIEW-4 판 없는 문서·삭제된 문서는 쌍에 들지 않고 이름마다 쌍이 하나다', () => {
    const rows = [
      docRecord({ docId: 'a', name: 'N', edition: null }),
      withEdition('b', 'N', 'v2030', '2030-01-01', { deleted: true }),
      withEdition('c', 'M', 'v2024', '2024-01-01'),
      withEdition('d', 'M', 'v2023', '2023-01-01'),
      withEdition('e', 'N', 'v2021', '2021-01-01'),
    ];
    expect(byName(latestEditionPairs(rows))).toEqual([
      { name: 'M', editionDate: '2024-01-01' },
      { name: 'N', editionDate: '2021-01-01' },
    ]);
    expect(latestEditionPairs([])).toEqual([]);
    // 판이 없는 문서만 있으면 쌍이 없다
    expect(latestEditionPairs([docRecord({ edition: null })])).toEqual([]);
  });

  it('T-PR3-VIEW-4 latestEditionDates와 같은 판단을 쌍으로 낸다', () => {
    const rows = [
      withEdition('a', 'N', 'v1', '2025-01-01'),
      withEdition('b', 'M', 'v1', '2024-01-01'),
      withEdition('c', 'M', 'v2', '2026-01-01', { searchState: 'not_searchable' }),
    ];
    const fromDates = [...latestEditionDates(rows)].map(([name, editionDate]) => ({
      name,
      editionDate,
    }));
    expect(byName(latestEditionPairs(rows))).toEqual(byName(fromDates));
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
