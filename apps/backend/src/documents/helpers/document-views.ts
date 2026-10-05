import type { AssetViewData } from '../../assets';
import { toIsoUtc } from '../../../libs/utils';
import type { RagDocumentChunk } from '../../rag';
import type {
  AssetView,
  ChunkView,
  DocumentDetailView,
  DocumentRecord,
  DocumentRefView,
  DocumentSortColumn,
  DocumentSummaryView,
  DocumentVersionRecord,
  EditionValue,
  EditionView,
} from '../interfaces/documents.types';

/** 검색 상태 정렬 순서다. */
const SEARCH_STATE_ORDER = ['searchable', 'not_searchable', 'replaced'];
/** 처리 상태 정렬 순서다. API.md 나열 순이다. */
const PROCESSING_STATE_ORDER = [
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
export function latestEditionDates(searchable: readonly DocumentRecord[]): Map<string, string> {
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

/** 최신판만 거르기에서 남는 문서인가를 돌려준다. */
export function isLatestOrNoEdition(
  doc: DocumentRecord,
  latest: ReadonlyMap<string, string>,
): boolean {
  if (doc.edition === null) return true;
  return doc.searchState === 'searchable' && doc.edition.editionDate === latest.get(doc.name);
}

/** 문서의 판 칸을 만든다. */
export function siblingEditions(
  doc: DocumentRecord,
  searchable: readonly DocumentRecord[],
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

/** 첫 정렬 열의 비교값을 구한다. */
function primaryCompare(column: DocumentSortColumn, a: DocumentRecord, b: DocumentRecord): number {
  switch (column) {
    case 'name':
      return compareCodePoints(a.name, b.name);
    case 'search_state':
      return SEARCH_STATE_ORDER.indexOf(a.searchState) - SEARCH_STATE_ORDER.indexOf(b.searchState);
    case 'processing_state':
      return (
        PROCESSING_STATE_ORDER.indexOf(a.processingState) -
        PROCESSING_STATE_ORDER.indexOf(b.processingState)
      );
    case 'uploaded_at':
      return a.uploadedAt.getTime() - b.uploadedAt.getTime();
    case 'updated_at':
      return a.updatedAt.getTime() - b.updatedAt.getTime();
  }
}

/** 목록 정렬 비교 함수를 만든다. */
export function compareDocuments(
  column: DocumentSortColumn,
  order: 'asc' | 'desc',
): (a: DocumentRecord, b: DocumentRecord) => number {
  const sign = order === 'asc' ? 1 : -1;
  return (a, b) => {
    const primary = primaryCompare(column, a, b) * sign;
    if (primary !== 0) return primary;
    // ★ 동점은 수정 시각 최근순 → 문서 ID 오름차순이며 방향과 무관하다
    const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (byUpdated !== 0) return byUpdated;
    return compareCodePoints(a.docId, b.docId);
  };
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
