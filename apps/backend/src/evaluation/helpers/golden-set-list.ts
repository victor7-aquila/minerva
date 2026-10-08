import type {
  EvaluationRecord,
  GoldenSetRecord,
  GoldenSetRow,
  GoldenSetSortColumn,
  OutcomeFilter,
} from '../interfaces/evaluation.types';

/** 골든셋마다 startedAt이 가장 늦은 기록을 고른다. */
export function latestByGoldenSet(
  records: readonly EvaluationRecord[],
): Map<string, EvaluationRecord> {
  const latest = new Map<string, EvaluationRecord>();
  for (const record of records) {
    const current = latest.get(record.goldenSetId);
    if (current === undefined || record.startedAt.getTime() > current.startedAt.getTime()) {
      latest.set(record.goldenSetId, record);
    }
  }
  return latest;
}

/** 골든셋에 최근 기록을 붙인다. 기록이 없는 골든셋은 뺀다. 입력 순서를 지킨다. */
export function joinLatest(
  goldenSets: readonly GoldenSetRecord[],
  latest: ReadonlyMap<string, EvaluationRecord>,
): GoldenSetRow[] {
  const rows: GoldenSetRow[] = [];
  for (const goldenSet of goldenSets) {
    const record = latest.get(goldenSet.goldenSetId);
    if (record !== undefined) rows.push({ goldenSet, latest: record });
  }
  return rows;
}

/** 최근 결과로 거른다. outcome이 없으면 모두 남긴다. */
export function filterRows(
  rows: readonly GoldenSetRow[],
  outcome: OutcomeFilter | undefined,
): GoldenSetRow[] {
  if (outcome === undefined) return [...rows];
  return rows.filter((row) => row.latest.outcome === outcome);
}

/** 정렬 열의 값을 준다. 값이 없으면 null이다. */
export function sortKey(row: GoldenSetRow, column: GoldenSetSortColumn): number | null {
  const { latest, goldenSet } = row;
  switch (column) {
    case 'outcome':
      if (latest.outcome === 'hit') return 1;
      return latest.outcome === 'miss' ? 0 : null;
    case 'rank':
      return latest.expanded?.rank ?? null;
    case 'coverage':
      return latest.expanded?.coverage ?? null;
    case 'evaluated_at':
      return latest.evaluatedAt?.getTime() ?? null;
    case 'created_at':
      return goldenSet.createdAt.getTime();
  }
}

/** goldenSetId 오름차순 비교다. ★ 로캘 비교가 아니라 코드 단위 비교다 */
function compareId(a: GoldenSetRow, b: GoldenSetRow): number {
  if (a.goldenSet.goldenSetId < b.goldenSet.goldenSetId) return -1;
  return a.goldenSet.goldenSetId > b.goldenSet.goldenSetId ? 1 : 0;
}

/** 동점을 가른다. createdAt 내림차순, 그다음 goldenSetId 오름차순이다. */
function compareTie(a: GoldenSetRow, b: GoldenSetRow): number {
  const byCreated = b.goldenSet.createdAt.getTime() - a.goldenSet.createdAt.getTime();
  return byCreated !== 0 ? byCreated : compareId(a, b);
}

/** 한 열로 정렬한 새 배열을 준다. 값이 없는 행은 order와 관계없이 맨 뒤다. */
export function sortRows(
  rows: readonly GoldenSetRow[],
  column: GoldenSetSortColumn,
  order: 'asc' | 'desc',
): GoldenSetRow[] {
  const sign = order === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ka = sortKey(a, column);
    const kb = sortKey(b, column);
    if (ka !== null && kb !== null && ka !== kb) return (ka - kb) * sign;
    // ★ 값이 없는 행은 order와 무관하게 뒤다
    if (ka === null && kb !== null) return 1;
    if (ka !== null && kb === null) return -1;
    return compareTie(a, b);
  });
}

/** 페이지 하나를 잘라 준다. page는 1부터다. */
export function pageRows<T>(rows: readonly T[], page: number, pageSize: number): T[] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

/** 전체 다시 평가 순서(추가 이른 순, 같으면 goldenSetId 오름차순)로 정렬한 새 배열을 준다. */
export function evaluationOrder(rows: readonly GoldenSetRow[]): GoldenSetRow[] {
  return [...rows].sort((a, b) => {
    const byCreated = a.goldenSet.createdAt.getTime() - b.goldenSet.createdAt.getTime();
    return byCreated !== 0 ? byCreated : compareId(a, b);
  });
}
