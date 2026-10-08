import {
  evaluatingRecord,
  evaluationRecord,
  goldenSetRecord,
  missMetrics,
  ragMetrics,
} from '../../../test/support/evaluation-fixtures';
import type { EvaluationRecord, GoldenSetRow } from '../interfaces/evaluation.types';
import { summarize } from './evaluation-summary';

/** 골든셋과 최근 기록 한 쌍을 만든다. */
function row(id: string, latest: EvaluationRecord): GoldenSetRow {
  return {
    goldenSet: goldenSetRecord({ goldenSetId: id }),
    latest: { ...latest, goldenSetId: id },
  };
}

/** 실패 기록이다. */
function errorRecord(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return evaluationRecord({
    outcome: 'error',
    n: null,
    base: null,
    expanded: null,
    errorMessage: '실패',
    ...over,
  });
}

const ZERO = { hit_at_1: 0, hit_at_3: 0, hit_at_5: 0, hit_at_n: 0, mrr: 0 };

describe('REQ-BE-5.3.3', () => {
  it('T-SUM-1 명세 예: 실패는 분모에서 빠진다', () => {
    const summary = summarize([
      row('G1', evaluationRecord({ outcome: 'hit', base: missMetrics(), expanded: ragMetrics() })),
      row(
        'G2',
        evaluationRecord({ outcome: 'miss', base: missMetrics(), expanded: missMetrics() }),
      ),
      row('G3', errorRecord()),
    ]);
    expect(summary.expanded.hit_at_1).toBe(0.5);
    expect(summary.expanded.mrr).toBe(0.5);
    expect(summary.expanded.hit_at_n).toBe(0.5);
    expect(summary.base).toEqual(ZERO);
    expect(summary.golden_set_count).toBe(3);
    expect(summary.evaluating_count).toBe(0);
  });

  it('T-SUM-2 비율과 MRR을 정확히 계산한다', () => {
    const summary = summarize([
      row('G1', evaluationRecord({ expanded: ragMetrics({ rank: 1, reciprocalRank: 1 }) })),
      row(
        'G2',
        evaluationRecord({
          expanded: ragMetrics({ hitAt1: false, rank: 2, reciprocalRank: 0.5 }),
        }),
      ),
      row(
        'G3',
        evaluationRecord({
          expanded: ragMetrics({
            hitAt1: false,
            hitAt3: false,
            rank: 4,
            reciprocalRank: 0.25,
          }),
        }),
      ),
      row('G4', evaluationRecord({ outcome: 'miss', expanded: missMetrics() })),
    ]);
    expect(summary.expanded).toEqual({
      hit_at_1: 0.25,
      hit_at_3: 0.5,
      hit_at_5: 0.75,
      hit_at_n: 0.75,
      mrr: 0.4375,
    });
  });

  it('T-SUM-3 평가 중은 분모에서 빠지고 건수만 센다', () => {
    const summary = summarize([
      row('G1', evaluationRecord()),
      row('G2', evaluatingRecord()),
      row('G3', evaluatingRecord()),
    ]);
    expect(summary.expanded.hit_at_1).toBe(1);
    expect(summary.evaluating_count).toBe(2);
    expect(summary.golden_set_count).toBe(3);
  });

  it('T-SUM-4 계산할 기록이 없으면 모두 0이고 마지막 평가 시각은 null이다', () => {
    const empty = summarize([]);
    expect(empty.base).toEqual(ZERO);
    expect(empty.expanded).toEqual(ZERO);
    expect(empty.n).toBe(0);
    expect(empty.last_evaluated_at).toBeNull();
    expect(empty.golden_set_count).toBe(0);
    const unfinished = summarize([row('G1', evaluatingRecord()), row('G2', errorRecord())]);
    expect(unfinished.base).toEqual(ZERO);
    expect(unfinished.expanded).toEqual(ZERO);
    expect(unfinished.n).toBe(0);
    expect(unfinished.last_evaluated_at).toBeNull();
  });

  it('T-SUM-5 N과 마지막 평가 시각은 적중·놓침 기록 중 가장 늦은 것이다', () => {
    const summary = summarize([
      row(
        'G1',
        evaluationRecord({ outcome: 'hit', n: 5, evaluatedAt: new Date('2026-10-05T10:00:00Z') }),
      ),
      row(
        'G2',
        evaluationRecord({
          outcome: 'miss',
          n: 10,
          expanded: missMetrics(),
          evaluatedAt: new Date('2026-10-05T11:00:00Z'),
        }),
      ),
      row('G3', errorRecord({ evaluatedAt: new Date('2026-10-05T12:00:00Z') })),
    ]);
    expect(summary.n).toBe(10);
    // ★ 실패 기록의 늦은 시각은 쓰지 않는다
    expect(summary.last_evaluated_at).toBe('2026-10-05T11:00:00Z');
  });

  it('T-SUM-6 키 순서가 명세와 같다', () => {
    const summary = summarize([row('G1', evaluationRecord())]);
    expect(Object.keys(summary)).toEqual([
      'golden_set_count',
      'evaluating_count',
      'last_evaluated_at',
      'n',
      'base',
      'expanded',
    ]);
    const metricKeys = ['hit_at_1', 'hit_at_3', 'hit_at_5', 'hit_at_n', 'mrr'];
    expect(Object.keys(summary.base)).toEqual(metricKeys);
    expect(Object.keys(summary.expanded)).toEqual(metricKeys);
  });
});
