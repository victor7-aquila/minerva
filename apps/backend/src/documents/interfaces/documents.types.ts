import type { ProcessingState, SearchState } from '../../common';

/** 문서 컬렉션 이름이다. */
export const DOCUMENTS_COLLECTION = 'documents';
/** 문서 버전 컬렉션 이름이다. */
export const DOCUMENT_VERSIONS_COLLECTION = 'document_versions';

/** 판 정보다. editionDate는 YYYY-MM-DD다. */
export interface EditionValue {
  label: string;
  editionDate: string;
}

/** 다시 보낼 RAG Server 요청 표시다. */
export interface PendingRag {
  deleteChunks: boolean;
  metadata: boolean;
}

/** MongoDB documents에 저장하는 문서다. MODULE.md 「모델별 필드」와 같다. */
export interface DocumentRecord {
  docId: string;
  name: string;
  edition: EditionValue | null;
  editionEnteredAt: Date;
  searchState: SearchState;
  processingState: ProcessingState;
  latestVersion: string;
  searchableVersion: string | null;
  deleted: boolean;
  pendingRag: PendingRag;
  purged: boolean;
  uploadedAt: Date;
  updatedAt: Date;
}

/** 버전을 만든 계기다. */
export type VersionOrigin = 'upload' | 'content' | 'hints' | 'reindex';

/** 처리 실패 사유다. */
export interface VersionFailure {
  code: string;
  message: string;
  headingPath: string[] | null;
  placeholderId: string | null;
}

/** 처리 결과다. */
export interface VersionResult {
  chunkCount: number;
  fallbackUsed: boolean;
}

/** MongoDB document_versions에 저장하는 버전이다. */
export interface DocumentVersionRecord {
  docId: string;
  version: string;
  origin: VersionOrigin;
  fileName: string;
  originalMarkdown: string;
  indexingMarkdown: string | null;
  jobId: string | null;
  result: VersionResult | null;
  failure: VersionFailure | null;
}

/** 다른 모듈에 주는 문서 참조다. */
export interface DocumentRefData {
  docId: string;
  name: string;
  edition: { label: string; editionDate: string } | null;
  deleted: boolean;
}

/** 평가에 쓰는 문서 정보다. */
export interface EvaluationTarget extends DocumentRefData {
  searchState: SearchState;
  searchableIndexingMarkdown: string | null;
}

/** 응답의 판 정보다. */
export interface EditionView {
  label: string;
  edition_date: string;
}
/** 업로드 응답의 문서 하나다. */
export interface UploadedDocumentView {
  doc_id: string;
  name: string;
  file_name: string;
  unmatched_images: string[];
}
/** 응답의 문서 참조다. */
export interface DocumentRefView {
  doc_id: string;
  name: string;
  edition: EditionView | null;
}
/** 목록의 문서 하나다. */
export interface DocumentSummaryView {
  doc_id: string;
  name: string;
  edition: EditionView | null;
  sibling_editions: EditionView[];
  search_state: SearchState;
  processing_state: ProcessingState;
  stage: 'chunking' | 'embedding' | 'storing' | null;
  failure_message: string | null;
  uploaded_at: string;
  updated_at: string;
}
/** 처리 결과다. */
export interface ProcessingResultView {
  chunk_count: number;
  fallback_used: boolean;
}
/** 처리 실패 사유다. */
export interface ProcessingFailureView {
  code: string;
  message: string;
  heading_path: string[] | null;
  placeholder_id: string | null;
}
/** 표·이미지 하나다. */
export interface AssetView {
  placeholder_id: string;
  kind: 'table' | 'image';
  table_markdown: string | null;
  image_url: string | null;
  text: string;
  is_fallback: boolean;
}
/** 문서 하나의 자세한 정보다. */
export interface DocumentDetailView extends DocumentSummaryView {
  file_name: string;
  result: ProcessingResultView | null;
  failure: ProcessingFailureView | null;
  assets: AssetView[];
}
/** 청크 하나다. */
export interface ChunkView {
  order: number;
  kind: 'text' | 'asset';
  heading_path: string[];
  title: string | null;
  summary: string | null;
  markdown: string;
  split_index: number | null;
  split_total: number | null;
}
/** 원본 MD 응답이다. */
export interface OriginalView {
  markdown: string;
  images: Record<string, string | null>;
}
/** 목록 정렬 열이다. */
export type DocumentSortColumn =
  'name' | 'search_state' | 'processing_state' | 'uploaded_at' | 'updated_at';

/** RAG Server에 색인을 요청하지 못한 실패 사유다. */
export const RAG_UNREACHABLE_FAILURE: VersionFailure = {
  code: 'RAG_UNREACHABLE',
  message: 'RAG Server에 색인을 요청하지 못했습니다',
  headingPath: null,
  placeholderId: null,
};
/** 처리 중에 교체된 실패 사유다. */
export const REPLACED_FAILURE: VersionFailure = {
  code: 'REPLACED',
  message: '같은 판의 다른 문서로 교체되어 처리를 멈췄습니다',
  headingPath: null,
  placeholderId: null,
};
/** 실패 이벤트에 사유가 없을 때 쓰는 사유다. */
export const UNKNOWN_FAILURE: VersionFailure = {
  code: 'UNKNOWN',
  message: 'RAG Server가 실패 사유를 알려 주지 않았습니다',
  headingPath: null,
  placeholderId: null,
};
