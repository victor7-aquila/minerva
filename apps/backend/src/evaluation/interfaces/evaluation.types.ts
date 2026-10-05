import type { RagEvaluationMetrics } from '../../rag';

/** 골든셋 컬렉션 이름이다. */
export const GOLDEN_SETS_COLLECTION = 'golden_sets';
/** 평가 기록 컬렉션 이름이다. */
export const EVALUATION_RECORDS_COLLECTION = 'evaluation_records';

/** 평가 결과다. */
export type EvaluationOutcome = 'evaluating' | 'hit' | 'miss' | 'error';
/** 끝난 평가 결과다. */
export type FinishedOutcome = Exclude<EvaluationOutcome, 'evaluating'>;
/** 목록 거르기 값이다. */
export type OutcomeFilter = 'hit' | 'miss';
/** 목록 거르기 값 목록이다. */
export const OUTCOME_FILTERS: readonly OutcomeFilter[] = ['hit', 'miss'];
/** 목록 정렬 열이다. */
export type GoldenSetSortColumn = 'outcome' | 'rank' | 'coverage' | 'evaluated_at' | 'created_at';
/** 목록 정렬 열 목록이다. */
export const GOLDEN_SET_SORT_COLUMNS: readonly GoldenSetSortColumn[] = [
  'outcome',
  'rank',
  'coverage',
  'evaluated_at',
  'created_at',
];
/** 백그라운드 작업 이름이다. 로그의 task 값이다. */
export type EvaluationTaskName = 'evaluate' | 'evaluate_all';

/** 골든셋 저장 레코드다 (MongoDB golden_sets). */
export interface GoldenSetRecord {
  goldenSetId: string;
  query: string;
  docId: string;
  answerSpan: string;
  editionOnly: boolean;
  createdAt: Date;
}

/** 평가 기록 저장 레코드다 (MongoDB evaluation_records). */
export interface EvaluationRecord {
  recordId: string;
  goldenSetId: string;
  outcome: EvaluationOutcome;
  n: number | null;
  base: RagEvaluationMetrics | null;
  expanded: RagEvaluationMetrics | null;
  errorMessage: string | null;
  startedAt: Date;
  evaluatedAt: Date | null;
}

/** 평가를 끝낼 때 바꾸는 값이다. */
export interface RecordFinish {
  outcome: FinishedOutcome;
  n: number | null;
  base: RagEvaluationMetrics | null;
  expanded: RagEvaluationMetrics | null;
  errorMessage: string | null;
  evaluatedAt: Date;
}

/** 골든셋과 그 최근 기록이다. */
export interface GoldenSetRow {
  goldenSet: GoldenSetRecord;
  latest: EvaluationRecord;
}

/** 응답의 판 정보다. */
export interface AnswerEditionView {
  label: string;
  edition_date: string;
}
/** 응답의 정답 문서 참조다 (API.md DocumentRef). */
export interface AnswerRefView {
  doc_id: string;
  name: string;
  edition: AnswerEditionView | null;
}
/** 응답의 평가 지표다 (API.md EvaluationMetrics). */
export interface EvaluationMetricsView {
  hit_at_1: boolean;
  hit_at_3: boolean;
  hit_at_5: boolean;
  hit_at_n: boolean;
  rank: number | null;
  reciprocal_rank: number;
  coverage: number;
}
/** 응답의 평가 기록이다 (API.md EvaluationRecord). */
export interface EvaluationRecordView {
  outcome: EvaluationOutcome;
  n: number | null;
  base: EvaluationMetricsView | null;
  expanded: EvaluationMetricsView | null;
  error_message: string | null;
  evaluated_at: string | null;
}
/** 응답의 골든셋이다 (API.md GoldenSet). */
export interface GoldenSetView {
  golden_set_id: string;
  query: string;
  answer: AnswerRefView;
  answer_span: string;
  edition_only: boolean;
  created_at: string;
  latest: EvaluationRecordView;
}
/** 요약의 지표다 (API.md SummaryMetrics). */
export interface SummaryMetricsView {
  hit_at_1: number;
  hit_at_3: number;
  hit_at_5: number;
  hit_at_n: number;
  mrr: number;
}
/** 평가 요약이다 (API.md EvaluationSummary). */
export interface EvaluationSummaryView {
  golden_set_count: number;
  evaluating_count: number;
  last_evaluated_at: string | null;
  n: number;
  base: SummaryMetricsView;
  expanded: SummaryMetricsView;
}

/** 평가 사유와 응답 문구다. ★ 클라이언트에 나가는 한국어 문장이다 (E4·E11·E14·E17) */
export const EVALUATION_MESSAGES = {
  ragUnreachable: 'RAG Server에 연결할 수 없습니다',
  notSearchable: '정답 문서가 검색되지 않습니다',
  vectorMismatch: '저장된 벡터와 임베딩 모델의 차원이 달라 평가하지 못했습니다',
  ragRejected: 'RAG Server가 평가 요청을 받지 않았습니다',
  ragFailed: 'RAG Server가 평가 중 오류를 냈습니다',
  unexpected: '평가 중 예상하지 못한 오류가 발생했습니다',
  restarted: '서버가 다시 시작해 평가하지 못했습니다',
  editionRequired: '판 정보가 없는 문서는 판 지정 골든셋의 정답 문서로 고를 수 없습니다',
  unknownDocument: '알 수 없는 문서',
} as const;
