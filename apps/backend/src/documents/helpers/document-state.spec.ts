import type { ProcessingState, SearchState } from '../../common';
import type { RagJobState } from '../../indexing';
import {
  canApplyEvent,
  isLocked,
  newerSearchableVersion,
  nextVersion,
  previousVersion,
  targetStateOf,
} from './document-state';

const STATES: ProcessingState[] = [
  'uploaded',
  'captioning',
  'queued',
  'indexing',
  'completed',
  'failed',
];
const TARGETS: ProcessingState[] = ['queued', 'indexing', 'completed', 'failed'];
const CODES: Array<string | null> = [null, 'RAG_UNREACHABLE', 'PARSE_FAILED'];

/** REQ-BE-1.9.5 처리 계약(documents MODULE.md)의 출발 상태 규칙을 그대로 옮긴 기대값이다. */
function expectedApply(
  current: ProcessingState,
  code: string | null,
  target: ProcessingState,
): boolean {
  const retryable = current === 'failed' && code === 'RAG_UNREACHABLE';
  if (target === 'queued') return retryable;
  if (target === 'indexing') return current === 'queued' || retryable;
  return current === 'queued' || current === 'indexing' || retryable;
}

/** (현재 상태, 실패 코드) 쌍이다. 곱을 한 단계씩만 반복하도록 먼저 펼친다. */
const CURRENT_PAIRS = STATES.flatMap((current) =>
  CODES.map((code): [ProcessingState, string | null] => [current, code]),
);

const GRID: Array<[ProcessingState, string | null, ProcessingState, boolean]> =
  CURRENT_PAIRS.flatMap(([current, code]) =>
    TARGETS.map((target): [ProcessingState, string | null, ProcessingState, boolean] => [
      current,
      code,
      target,
      expectedApply(current, code, target),
    ]),
  );

describe('REQ-BE-1.9.5', () => {
  it('T-STATE-1 작업 상태를 처리 상태로 바꾼다', () => {
    const table: Array<[RagJobState, ProcessingState | null]> = [
      ['queued', 'queued'],
      ['running', 'indexing'],
      ['succeeded', 'completed'],
      ['failed', 'failed'],
      ['superseded', null],
    ];
    for (const [job, expected] of table) expect(targetStateOf(job)).toBe(expected);
  });
});

describe('REQ-BE-1.9.6', () => {
  it('T-STATE-2 canApplyEvent는 REQ-BE-1.9.5 출발 상태 규칙의 72칸과 같다', () => {
    expect(GRID).toHaveLength(72);
  });

  it.each(GRID)('T-STATE-2 현재 %s(실패 코드 %s) → 목표 %s는 %s', (current, code, target, want) => {
    expect(canApplyEvent(current, code, target)).toBe(want);
  });

  it('T-STATE-2 핵심 칸: 완료는 처리 중으로 되돌지 않고 재시도 가능한 실패만 되살아난다', () => {
    expect(canApplyEvent('completed', null, 'indexing')).toBe(false);
    expect(canApplyEvent('failed', 'PARSE_FAILED', 'completed')).toBe(false);
    expect(canApplyEvent('failed', 'RAG_UNREACHABLE', 'completed')).toBe(true);
  });
});

describe('REQ-BE-1.9.7', () => {
  it('T-STATE-3 검색되는 버전은 숫자로 비교해 더 클 때만 바뀐다', () => {
    expect(newerSearchableVersion(null, '1')).toBe('1');
    expect(newerSearchableVersion('2', '1')).toBeNull();
    expect(newerSearchableVersion('2', '10')).toBe('10');
    expect(newerSearchableVersion('2', null)).toBeNull();
    expect(newerSearchableVersion('2', '2')).toBeNull();
  });
});

describe('REQ-BE-1.5.5', () => {
  it('T-STATE-4 처리 중이거나 교체된 문서는 잠긴다', () => {
    const lock = (processingState: ProcessingState, searchState: SearchState): boolean =>
      isLocked({ processingState, searchState });
    for (const state of ['uploaded', 'captioning', 'queued', 'indexing'] as const) {
      expect(lock(state, 'searchable')).toBe(true);
    }
    expect(lock('completed', 'searchable')).toBe(false);
    expect(lock('failed', 'not_searchable')).toBe(false);
    expect(lock('completed', 'replaced')).toBe(true);
  });
});

describe('REQ-BE-1.6.3', () => {
  it('T-STATE-5 버전 번호는 숫자로 더하고 뺀다', () => {
    expect(nextVersion('9')).toBe('10');
    expect(previousVersion('1')).toBeNull();
    expect(previousVersion('10')).toBe('9');
  });
});
