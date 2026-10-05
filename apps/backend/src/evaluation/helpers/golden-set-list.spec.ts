import {
  evaluatingRecord,
  evaluationRecord,
  goldenSetRecord,
  missMetrics,
  ragMetrics,
} from '../../../test/support/evaluation-fixtures';
import type { EvaluationRecord, GoldenSetRow } from '../interfaces/evaluation.types';
import {
  evaluationOrder,
  filterRows,
  joinLatest,
  latestByGoldenSet,
  pageRows,
  sortRows,
} from './golden-set-list';

/** 2026-10-05 기준 시각을 만든다. */
function at(hhmm: string): Date {
  return new Date(`2026-10-05T${hhmm}:00Z`);
}

/** 골든셋과 최근 기록 한 쌍을 만든다. */
function row(id: string, createdAt: string, latest: EvaluationRecord): GoldenSetRow {
  return {
    goldenSet: goldenSetRecord({ goldenSetId: id, createdAt: at(createdAt) }),
    latest: { ...latest, goldenSetId: id },
  };
}

/** 공통 행 A~E다. */
function rows(): GoldenSetRow[] {
  return [
    row(
      'A',
      '01:00',
      evaluationRecord({
        outcome: 'hit',
        expanded: ragMetrics({ rank: 1, coverage: 1.0 }),
        evaluatedAt: at('10:05'),
      }),
    ),
    row(
      'B',
      '02:00',
      evaluationRecord({
        outcome: 'hit',
        expanded: ragMetrics({ rank: 3, coverage: 0.5 }),
        evaluatedAt: at('10:03'),
      }),
    ),
    row(
      'C',
      '03:00',
      evaluationRecord({
        outcome: 'miss',
        expanded: { ...missMetrics(), rank: null, coverage: 0.2 },
        evaluatedAt: at('10:04'),
      }),
    ),
    row('D', '04:00', evaluatingRecord()),
    row(
      'E',
      '05:00',
      evaluationRecord({
        outcome: 'error',
        n: null,
        base: null,
        expanded: null,
        errorMessage: '실패',
        evaluatedAt: at('10:09'),
      }),
    ),
  ];
}

/** 행 목록의 골든셋 ID 순서다. */
function ids(list: GoldenSetRow[]): string[] {
  return list.map((r) => r.goldenSet.goldenSetId);
}

describe('REQ-BE-5.3.2', () => {
  it('T-LIST-1 골든셋마다 startedAt이 가장 늦은 기록을 고른다', () => {
    const t1 = evaluationRecord({ recordId: 'r1', goldenSetId: 'G1', startedAt: at('01:00') });
    const t2 = evaluationRecord({ recordId: 'r2', goldenSetId: 'G1', startedAt: at('02:00') });
    const t3 = evaluationRecord({ recordId: 'r3', goldenSetId: 'G1', startedAt: at('03:00') });
    const other = evaluationRecord({ recordId: 'r4', goldenSetId: 'G2', startedAt: at('00:30') });
    const latest = latestByGoldenSet([t2, t1, t3, other]);
    expect(latest.size).toBe(2);
    expect(latest.get('G1')?.recordId).toBe('r3');
    expect(latest.get('G2')?.recordId).toBe('r4');
  });

  it('T-LIST-2 기록이 없는 골든셋은 빼고 입력 순서를 지킨다', () => {
    const goldenSets = ['G1', 'G2', 'G3'].map((id) => goldenSetRecord({ goldenSetId: id }));
    const latest = new Map<string, EvaluationRecord>([
      ['G1', evaluationRecord({ goldenSetId: 'G1' })],
      ['G3', evaluationRecord({ goldenSetId: 'G3' })],
    ]);
    expect(joinLatest(goldenSets, latest).map((r) => r.goldenSet.goldenSetId)).toEqual([
      'G1',
      'G3',
    ]);
  });
});

describe('REQ-BE-5.3.1', () => {
  it('T-LIST-3 결과로 거른다', () => {
    expect(ids(filterRows(rows(), 'hit'))).toEqual(['A', 'B']);
    expect(ids(filterRows(rows(), 'miss'))).toEqual(['C']);
    expect(ids(filterRows(rows(), undefined))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('T-LIST-4 정답 순위 정렬은 값 없는 행을 두 방향 모두 맨 뒤에 둔다', () => {
    expect(ids(sortRows(rows(), 'rank', 'asc'))).toEqual(['A', 'B', 'E', 'D', 'C']);
    expect(ids(sortRows(rows(), 'rank', 'desc'))).toEqual(['B', 'A', 'E', 'D', 'C']);
  });

  it('T-LIST-5 포함 비율 정렬', () => {
    expect(ids(sortRows(rows(), 'coverage', 'desc'))).toEqual(['A', 'B', 'C', 'E', 'D']);
    expect(ids(sortRows(rows(), 'coverage', 'asc'))).toEqual(['C', 'B', 'A', 'E', 'D']);
  });

  it('T-LIST-6 결과 정렬은 적중이 높은 값이다', () => {
    expect(ids(sortRows(rows(), 'outcome', 'desc'))).toEqual(['B', 'A', 'C', 'E', 'D']);
    expect(ids(sortRows(rows(), 'outcome', 'asc'))).toEqual(['C', 'B', 'A', 'E', 'D']);
  });

  it('T-LIST-7 평가 시각 정렬은 실패 행도 값이 있고 평가 중만 뒤다', () => {
    expect(ids(sortRows(rows(), 'evaluated_at', 'desc'))).toEqual(['E', 'A', 'C', 'B', 'D']);
    expect(ids(sortRows(rows(), 'evaluated_at', 'asc'))).toEqual(['B', 'C', 'A', 'E', 'D']);
  });

  it('T-LIST-8 추가 시각 정렬과 동점은 goldenSetId 오름차순이다', () => {
    expect(ids(sortRows(rows(), 'created_at', 'desc'))).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(ids(sortRows(rows(), 'created_at', 'asc'))).toEqual(['A', 'B', 'C', 'D', 'E']);
    const tie = [
      row('gs-b', '01:00', evaluationRecord()),
      row('gs-a', '01:00', evaluationRecord()),
    ];
    expect(ids(sortRows(tie, 'created_at', 'desc'))).toEqual(['gs-a', 'gs-b']);
    expect(ids(sortRows(tie, 'created_at', 'asc'))).toEqual(['gs-a', 'gs-b']);
  });

  it('T-LIST-9 페이지를 자르고 정렬은 입력 배열을 바꾸지 않는다', () => {
    expect(pageRows([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 2]);
    expect(pageRows([1, 2, 3, 4, 5], 3, 2)).toEqual([5]);
    expect(pageRows([1, 2, 3, 4, 5], 4, 2)).toEqual([]);
    const input = rows();
    sortRows(input, 'rank', 'asc');
    expect(ids(input)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('T-LIST-10 전체 다시 평가 순서는 추가 이른 순이다', () => {
    const [a, , c, , e] = rows();
    expect(ids(evaluationOrder([e, a, c]))).toEqual(['A', 'C', 'E']);
  });
});
