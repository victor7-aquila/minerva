import type { ProcessingState, SearchState } from '../../common';
import type { IndexRejectionCode } from '../../indexing';

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
  /** 색인 대기열. 값이 있으면 그 버전이 대기열에 있다 (REQ-BE-1.10) */
  queuedVersion: string | null;
  latestVersion: string;
  searchableVersion: string | null;
  deleted: boolean;
  pendingRag: PendingRag;
  purged: boolean;
  uploadedAt: Date;
  updatedAt: Date;
}

/** 판 칸·최신판 계산에 쓰는 문서 필드다. */
export type EditionRow = Pick<
  DocumentRecord,
  'docId' | 'name' | 'edition' | 'searchState' | 'deleted'
>;
/** 목록 정렬 조건이다. 키 순서가 정렬 우선순위다. */
export type ListSortSpec = Partial<Record<'name' | 'uploadedAt' | 'updatedAt' | 'docId', 1 | -1>>;
/** 상태 열 정렬에서 값 하나로 좁히는 조건이다. */
export type ListStateFilter = { searchState: SearchState } | { processingState: ProcessingState };

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
  /** 이 버전을 다시 요청 대상으로 돌린 횟수. 만들 때 0, REQ-BE-1.10.5 1단계에서만 1 늘어난다 */
  requestSeq: number;
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
  in_index_queue: boolean | null;
  next_index_at: string | null;
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

/** RAG Server가 색인 요청을 거부한 실패 사유다. 코드는 RAG Server의 오류 코드다 (REQ-BE-1.9.4). */
export const RAG_REJECTED_FAILURES: Readonly<Record<IndexRejectionCode, VersionFailure>> = {
  PAYLOAD_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    message: '색인용 MD가 RAG Server의 크기 한도를 넘어 색인하지 못했습니다',
    headingPath: null,
    placeholderId: null,
  },
  INVALID_REQUEST: {
    code: 'INVALID_REQUEST',
    message: 'RAG Server가 색인 요청을 형식 오류로 거부했습니다',
    headingPath: null,
    placeholderId: null,
  },
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
