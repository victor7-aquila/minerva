/** 문서 처리 상태다. API.md의 processing_state 값과 같다. */
export type ProcessingState =
  'uploaded' | 'captioning' | 'queued' | 'indexing' | 'completed' | 'failed';

/** 문서 검색 상태다. API.md의 search_state 값과 같다. */
export type SearchState = 'searchable' | 'not_searchable' | 'replaced';
