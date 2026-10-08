import { toIsoUtc } from '../../../libs/utils';
import type { RagEvaluationMetrics } from '../../rag';
import type {
  EvaluationRecord,
  EvaluationSummaryView,
  GoldenSetRow,
  SummaryMetricsView,
} from '../interfaces/evaluation.types';

/** 지표가 있는 끝난 기록이다. */
interface FinishedRecord extends EvaluationRecord {
  base: RagEvaluationMetrics;
  expanded: RagEvaluationMetrics;
}

/** 적중·놓침으로 끝나 지표가 있는 기록인지 본다. */
function isFinished(record: EvaluationRecord): record is FinishedRecord {
  return (
    (record.outcome === 'hit' || record.outcome === 'miss') &&
    record.base !== null &&
    record.expanded !== null
  );
}

/** 지표 묶음으로 비율과 MRR을 계산한다. 비면 모두 0이다. */
function metricsOf(list: readonly RagEvaluationMetrics[]): SummaryMetricsView {
  if (list.length === 0) return { hit_at_1: 0, hit_at_3: 0, hit_at_5: 0, hit_at_n: 0, mrr: 0 };
  const ratio = (pick: (m: RagEvaluationMetrics) => boolean): number =>
    list.filter(pick).length / list.length;
  return {
    hit_at_1: ratio((m) => m.hitAt1),
    hit_at_3: ratio((m) => m.hitAt3),
    hit_at_5: ratio((m) => m.hitAt5),
    hit_at_n: ratio((m) => m.hitAtN),
    mrr: list.reduce((sum, m) => sum + m.reciprocalRank, 0) / list.length,
  };
}

/** 골든셋마다 최근 기록으로 요약 지표를 계산한다. */
export function summarize(rows: readonly GoldenSetRow[]): EvaluationSummaryView {
  const finished = rows.map((row) => row.latest).filter(isFinished);
  let newest: FinishedRecord | undefined;
  for (const record of finished) {
    if (record.evaluatedAt === null) continue;
    if (
      newest?.evaluatedAt == null ||
      record.evaluatedAt.getTime() > newest.evaluatedAt.getTime()
    ) {
      newest = record;
    }
  }
  return {
    golden_set_count: rows.length,
    evaluating_count: rows.filter((row) => row.latest.outcome === 'evaluating').length,
    last_evaluated_at: newest?.evaluatedAt ? toIsoUtc(newest.evaluatedAt) : null,
    n: newest?.n ?? 0,
    base: metricsOf(finished.map((r) => r.base)),
    expanded: metricsOf(finished.map((r) => r.expanded)),
  };
}
