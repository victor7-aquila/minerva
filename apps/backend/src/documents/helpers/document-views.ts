import type { AssetViewData } from '../../assets';
import { toIsoUtc } from '../../common';
import type { ProcessingState, SearchState } from '../../common';
import type { RagDocumentChunk } from '../../rag';
import type {
  AssetView,
  ChunkView,
  DocumentDetailView,
  DocumentRecord,
  DocumentRefView,
  DocumentSummaryView,
  DocumentVersionRecord,
  EditionRow,
  EditionValue,
  EditionView,
  ListSortSpec,
} from '../interfaces/documents.types';

/** 검색 상태 정렬 순서다. */
const SEARCH_STATE_ORDER: readonly SearchState[] = ['searchable', 'not_searchable', 'replaced'];
/** 처리 상태 정렬 순서다. API.md 나열 순이다. */
const PROCESSING_STATE_ORDER: readonly ProcessingState[] = [
  'uploaded',
  'captioning',
  'queued',
  'indexing',
  'completed',
  'failed',
];

/** 코드 포인트 순으로 두 문자열을 비교한다. */
function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** 판 정보를 응답 모양으로 바꾼다. */
export function toEditionView(edition: EditionValue | null): EditionView | null {
  return edition === null ? null : { label: edition.label, edition_date: edition.editionDate };
}

/** 문서를 응답의 문서 참조로 바꾼다. */
export function toRefView(doc: DocumentRecord): DocumentRefView {
  return { doc_id: doc.docId, name: doc.name, edition: toEditionView(doc.edition) };
}

/** 같은 이름의 검색 가능 문서들에서 이름별 가장 늦은 판 날짜를 구한다. */
export function latestEditionDates(searchable: readonly EditionRow[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const doc of searchable) {
    if (doc.edition === null || doc.searchState !== 'searchable' || doc.deleted) continue;
    const current = latest.get(doc.name);
    // ★ YYYY-MM-DD라 문자열 비교로 최댓값을 정한다
    if (current === undefined || doc.edition.editionDate > current) {
      latest.set(doc.name, doc.edition.editionDate);
    }
  }
  return latest;
}

/** 문서의 판 칸을 만든다. */
export function siblingEditions(
  doc: DocumentRecord,
  searchable: readonly EditionRow[],
): EditionView[] {
  if (doc.edition === null) return [];
  const editions: EditionValue[] = [doc.edition];
  for (const other of searchable) {
    if (
      other.docId !== doc.docId &&
      !other.deleted &&
      other.searchState === 'searchable' &&
      other.name === doc.name &&
      other.edition !== null
    ) {
      editions.push(other.edition);
    }
  }
  // ★ 같은 판 두 문서가 교체 전 잠시 함께 검색 가능할 수 있다 — 하나로 합친다
  const unique = new Map<string, EditionValue>();
  for (const edition of editions) {
    unique.set(`${edition.label}\u0000${edition.editionDate}`, edition);
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        compareCodePoints(b.editionDate, a.editionDate) || compareCodePoints(a.label, b.label),
    )
    .map((edition) => ({ label: edition.label, edition_date: edition.editionDate }));
}

/** 이름별 가장 늦은 검색 가능 판 날짜를 쌍 목록으로 준다. */
export function latestEditionPairs(
  rows: readonly EditionRow[],
): Array<{ name: string; editionDate: string }> {
  return [...latestEditionDates(rows)].map(([name, editionDate]) => ({ name, editionDate }));
}

/** 목록 정렬 조건을 만든다. ★ 키 순서가 우선순위이고, 동점은 수정 시각 최근순 → 문서 ID 오름차순이며 방향과 무관하다 */
export function listSortSpec(
  column: 'name' | 'uploaded_at' | 'updated_at',
  order: 'asc' | 'desc',
): ListSortSpec {
  const direction = order === 'asc' ? 1 : -1;
  switch (column) {
    case 'name':
      return { name: direction, updatedAt: -1, docId: 1 };
    case 'uploaded_at':
      return { uploadedAt: direction, updatedAt: -1, docId: 1 };
    case 'updated_at':
      return { updatedAt: direction, docId: 1 };
  }
}

/** 상태 열의 값 순서를 준다. desc면 뒤집는다. ★ 매번 새 배열이다 */
export function stateBucketOrder(column: 'search_state', order: 'asc' | 'desc'): SearchState[];
export function stateBucketOrder(
  column: 'processing_state',
  order: 'asc' | 'desc',
): ProcessingState[];
export function stateBucketOrder(
  column: 'search_state' | 'processing_state',
  order: 'asc' | 'desc',
): SearchState[] | ProcessingState[];
export function stateBucketOrder(
  column: 'search_state' | 'processing_state',
  order: 'asc' | 'desc',
): SearchState[] | ProcessingState[] {
  const values: SearchState[] | ProcessingState[] =
    column === 'search_state' ? [...SEARCH_STATE_ORDER] : [...PROCESSING_STATE_ORDER];
  return order === 'desc' ? values.reverse() : values;
}

/** 값별 개수에서 skip·limit이 걸치는 값마다 가져올 범위를 준다. 개수 0인 값은 건너뛴다. */
export function bucketWindows(
  counts: readonly number[],
  skip: number,
  limit: number,
): Array<{ index: number; skip: number; limit: number }> {
  const windows: Array<{ index: number; skip: number; limit: number }> = [];
  let remainingSkip = skip;
  let remainingLimit = limit;
  for (let index = 0; index < counts.length && remainingLimit > 0; index += 1) {
    const count = counts[index];
    if (remainingSkip >= count) {
      remainingSkip -= count;
      continue;
    }
    const take = Math.min(count - remainingSkip, remainingLimit);
    windows.push({ index, skip: remainingSkip, limit: take });
    remainingSkip = 0;
    remainingLimit -= take;
  }
  return windows;
}

/** 문서를 목록 항목으로 바꾼다. */
export function toSummary(
  doc: DocumentRecord,
  extra: {
    siblings: EditionView[];
    stage: DocumentSummaryView['stage'];
    failureMessage: string | null;
  },
): DocumentSummaryView {
  return {
    doc_id: doc.docId,
    name: doc.name,
    edition: toEditionView(doc.edition),
    sibling_editions: extra.siblings,
    search_state: doc.searchState,
    processing_state: doc.processingState,
    stage: doc.processingState === 'indexing' ? extra.stage : null,
    failure_message: doc.processingState === 'failed' ? extra.failureMessage : null,
    uploaded_at: toIsoUtc(doc.uploadedAt),
    updated_at: toIsoUtc(doc.updatedAt),
  };
}

/** 표·이미지를 응답 모양으로 바꾼다. */
export function toAssetView(view: AssetViewData): AssetView {
  return {
    placeholder_id: view.placeholderId,
    kind: view.kind,
    table_markdown: view.tableMarkdown,
    image_url: view.imageUrl,
    text: view.text,
    is_fallback: view.isTemporary,
  };
}

/** 문서를 자세한 정보로 바꾼다. */
export function toDetail(
  doc: DocumentRecord,
  version: DocumentVersionRecord,
  extra: {
    siblings: EditionView[];
    stage: DocumentSummaryView['stage'];
    assets: readonly AssetViewData[];
  },
): DocumentDetailView {
  // ★ 응답 어디에도 version 키를 넣지 않는다 (REQ-BE-1.6.4)
  const summary = toSummary(doc, {
    siblings: extra.siblings,
    stage: extra.stage,
    failureMessage: version.failure?.message ?? null,
  });
  const result =
    doc.processingState === 'completed' && version.result !== null
      ? { chunk_count: version.result.chunkCount, fallback_used: version.result.fallbackUsed }
      : null;
  const failure =
    doc.processingState === 'failed' && version.failure !== null
      ? {
          code: version.failure.code,
          message: version.failure.message,
          heading_path:
            version.failure.headingPath === null ? null : [...version.failure.headingPath],
          placeholder_id: version.failure.placeholderId,
        }
      : null;
  return {
    ...summary,
    file_name: version.fileName,
    result,
    failure,
    assets: extra.assets.map(toAssetView),
  };
}

/** RAG Server 청크와 복원한 본문으로 청크 응답을 만든다. */
export function toChunkView(chunk: RagDocumentChunk, markdown: string): ChunkView {
  return {
    order: chunk.order,
    kind: chunk.kind,
    heading_path: [...chunk.headingPath],
    title: chunk.title,
    summary: chunk.summary,
    markdown,
    split_index: chunk.splitIndex,
    split_total: chunk.splitTotal,
  };
}
