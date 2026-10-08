import { toIsoUtc } from '../../../libs/utils';
import type { DocumentRefData } from '../../documents';
import type { RagEvaluationMetrics } from '../../rag';
import { EVALUATION_MESSAGES } from '../interfaces/evaluation.types';
import type {
  AnswerRefView,
  EvaluationMetricsView,
  EvaluationRecord,
  EvaluationRecordView,
  GoldenSetRecord,
  GoldenSetView,
} from '../interfaces/evaluation.types';

/** 지표를 응답 모양으로 바꾼다. */
export function toMetricsView(m: RagEvaluationMetrics): EvaluationMetricsView {
  return {
    hit_at_1: m.hitAt1,
    hit_at_3: m.hitAt3,
    hit_at_5: m.hitAt5,
    hit_at_n: m.hitAtN,
    rank: m.rank,
    reciprocal_rank: m.reciprocalRank,
    coverage: m.coverage,
  };
}

/** 평가 기록을 응답 모양으로 바꾼다. */
export function toRecordView(r: EvaluationRecord): EvaluationRecordView {
  return {
    outcome: r.outcome,
    n: r.n,
    base: r.base === null ? null : toMetricsView(r.base),
    expanded: r.expanded === null ? null : toMetricsView(r.expanded),
    error_message: r.errorMessage,
    evaluated_at: r.evaluatedAt === null ? null : toIsoUtc(r.evaluatedAt),
  };
}

/** 정답 문서 참조를 응답 모양으로 바꾼다. 참조가 없으면 알 수 없는 문서로 채운다. */
export function toAnswerView(docId: string, ref: DocumentRefData | null): AnswerRefView {
  if (ref === null) {
    return { doc_id: docId, name: EVALUATION_MESSAGES.unknownDocument, edition: null };
  }
  return {
    doc_id: ref.docId,
    name: ref.name,
    edition:
      ref.edition === null
        ? null
        : { label: ref.edition.label, edition_date: ref.edition.editionDate },
  };
}

/** 골든셋을 응답 모양으로 바꾼다. */
export function toGoldenSetView(
  gs: GoldenSetRecord,
  latest: EvaluationRecord,
  answer: AnswerRefView,
): GoldenSetView {
  return {
    golden_set_id: gs.goldenSetId,
    query: gs.query,
    answer,
    answer_span: gs.answerSpan,
    edition_only: gs.editionOnly,
    created_at: toIsoUtc(gs.createdAt),
    latest: toRecordView(latest),
  };
}
