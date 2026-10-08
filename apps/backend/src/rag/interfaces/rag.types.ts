/** 청킹 방식이다. */
export type RagChunking = 'semantic' | 'rule';

/** 색인 작업 상태다. IF-BE-1의 RagJobState와 같은 값이다. */
export type RagJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'superseded';

/** 색인 중 단계다. */
export type RagJobStage = 'chunking' | 'embedding' | 'storing';

/** 색인 요청 접수 결과다. */
export type RagIndexOutcome = 'queued' | 'joined' | 'reused';

/** 청크 종류다. text는 본문, asset은 표·이미지 청크다. */
export type RagChunkKind = 'text' | 'asset';

/** 검색 판 범위다. */
export type RagEditionScope = 'all' | 'latest' | 'specific';

/** 판 정보다. editionDate는 ISO 8601 날짜 문자열이다. */
export interface RagEdition {
  label: string;
  editionDate: string;
}

/** 검색에서 특정 판을 가리킨다. */
export interface RagEditionRef {
  name: string;
  label: string;
}

/** 자리표시 하나의 요약·캡션 문장이다. */
export interface RagAssetText {
  placeholderId: string;
  text: string;
}

/** 색인 요청이다. */
export interface RagIndexRequest {
  docId: string;
  version: string;
  /** 색인용 MD */
  markdown: string;
  assets: readonly RagAssetText[];
  name: string;
  /** null이면 판 정보가 없는 문서다. ★ 전송 본문에서는 키를 뺀다 */
  edition: RagEdition | null;
  /** 빠지면 RAG Server 기본값(semantic) */
  chunking?: RagChunking;
  /** 빠지면 RAG Server 기본값(false) */
  force?: boolean;
}

/** 색인 요청 접수 응답이다. */
export interface RagIndexJobAccepted {
  outcome: RagIndexOutcome;
  jobId: string;
  docId: string;
  version: string;
}

/** 작업 실패 사유다. */
export interface RagJobFailure {
  code: string;
  message: string;
  headingPath: string[] | null;
  placeholderId: string | null;
}

/** 작업 결과다. */
export interface RagJobResult {
  chunkCount: number;
  fallbackUsed: boolean;
}

/** 색인 작업 하나의 상태다. */
export interface RagIndexJob {
  jobId: string;
  docId: string;
  version: string;
  state: RagJobState;
  stage: RagJobStage | null;
  failure: RagJobFailure | null;
  result: RagJobResult | null;
}

/** 문서 하나의 색인 상태다. */
export interface RagIndexState {
  docId: string;
  searchableVersion: string | null;
  latestJobId: string | null;
  latestJobState: RagJobState | null;
  latestJobStage: RagJobStage | null;
}

/** 문서의 지금 검색되는 청크 하나다. */
export interface RagDocumentChunk {
  chunkId: string;
  order: number;
  kind: RagChunkKind;
  headingPath: string[];
  title: string | null;
  summary: string | null;
  text: string;
  placeholderIds: string[];
  splitIndex: number | null;
  splitTotal: number | null;
}

/** 문서 청크 조회 응답이다. version이 null이면 items는 빈 배열이다. */
export interface RagDocumentChunks {
  version: string | null;
  items: RagDocumentChunk[];
}

/** 검색 요청이다. 선택 필드가 빠지면 RAG Server 기본값을 쓴다. */
export interface RagSearchRequest {
  query: string;
  topN?: number;
  docIds?: readonly string[];
  editionScope?: RagEditionScope;
  /** editionScope가 specific일 때만 쓴다 */
  edition?: RagEditionRef;
  expandNeighbors?: boolean;
}

/** 검색 결과의 판 정보다. */
export interface RagResultEdition {
  label: string;
  editionDate: string;
  isLatest: boolean;
}

/** 검색 결과의 청크 하나다. */
export interface RagResultChunk {
  chunkId: string;
  kind: RagChunkKind;
  text: string;
  placeholderIds: string[];
  splitIndex: number | null;
  splitTotal: number | null;
}

/** 검색 결과 하나다. */
export interface RagSearchResult {
  rank: number;
  score: number;
  docId: string;
  version: string;
  headingPath: string[];
  name: string;
  edition: RagResultEdition | null;
  otherEditionsInResults: boolean;
  chunks: RagResultChunk[];
  before: RagResultChunk[];
  after: RagResultChunk[];
}

/** 골든셋 한 건 평가 요청이다. */
export interface RagEvaluationRequest {
  query: string;
  docId: string;
  answerSpan: string;
  /** 빠지면 RAG Server 기본값(false) */
  editionOnly?: boolean;
  /** 빠지면 RAG Server 기본 개수 */
  topN?: number;
}

/** 평가 지표다. */
export interface RagEvaluationMetrics {
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  hitAtN: boolean;
  rank: number | null;
  reciprocalRank: number;
  coverage: number;
}

/** 평가 결과다. */
export interface RagEvaluationResult {
  n: number;
  base: RagEvaluationMetrics;
  expanded: RagEvaluationMetrics;
}
