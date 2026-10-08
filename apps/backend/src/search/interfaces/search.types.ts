/** 검색 판 범위다. */
export type EditionScope = 'all' | 'latest' | 'specific';

/** 검색 결과의 판 정보 응답이다 (API.md ResultEdition). */
export interface ResultEditionView {
  label: string;
  edition_date: string;
  is_latest: boolean;
  other_editions_in_results: boolean;
}

/** 검색 결과 하나의 응답이다 (API.md SearchResult). */
export interface SearchResultView {
  rank: number;
  score: number;
  doc_id: string;
  name: string;
  edition: ResultEditionView | null;
  heading_path: string[];
  markdown: string;
  before: string[];
  after: string[];
}

/** 검색 응답이다. */
export interface SearchResponseView {
  results: SearchResultView[];
}

/** 결과 하나의 복원한 본문이다. */
export interface RestoredTexts {
  /** 복원한 chunks 본문. RAG가 준 순서 그대로 */
  chunks: string[];
  before: string[];
  after: string[];
}
