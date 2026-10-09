import type { ProcessingState } from '../../common';
import type { RagJobState } from '../../indexing';
import {
  acceptsChange,
  canApplyEvent,
  newerSearchableVersion,
  nextVersion,
  previousVersion,
  targetStateOf,
} from './document-state';
import type { ChangeKind } from './document-state';

const STATES: ProcessingState[] = [
  'uploaded',
  'captioning',
  'queued',
  'indexing',
  'completed',
  'failed',
];

/** REQ-BE-1.9.5 처리 계약(documents MODULE.md)의 출발 상태 규칙을 그대로 옮긴 기대값이다. ★ failed는 어떤 목표의 출발 상태도 아니다 */
function expectedApply(current: ProcessingState, target: ProcessingState): boolean {
  if (target === 'indexing') return current === 'queued';
  if (target === 'completed' || target === 'failed') {
    return current === 'queued' || current === 'indexing';
  }
  return false;
}

/** (현재 상태, 목표 상태) 36칸이다. 곱을 한 단계씩만 반복하도록 먼저 펼친다. */
const GRID: Array<[ProcessingState, ProcessingState, boolean]> = STATES.flatMap((current) =>
  STATES.map((target): [ProcessingState, ProcessingState, boolean] => [
    current,
    target,
    expectedApply(current, target),
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

  it('T-STATE-2 canApplyEvent는 출발 상태 규칙의 36칸과 같다', () => {
    expect(GRID).toHaveLength(36);
  });

  it.each(GRID)('T-STATE-2 현재 %s → 목표 %s는 %s', (current, target, want) => {
    expect(canApplyEvent(current, target)).toBe(want);
  });

  it('T-STATE-2b failed에서 어떤 목표로도 바뀌지 않는다(실패 코드 인자가 없다)', () => {
    for (const target of STATES) expect(canApplyEvent('failed', target)).toBe(false);
  });

  it('T-STATE-2c 핵심 칸: indexing은 queued에서만, completed·failed는 queued·indexing에서만', () => {
    expect(canApplyEvent('queued', 'indexing')).toBe(true);
    expect(canApplyEvent('completed', 'indexing')).toBe(false);
    expect(canApplyEvent('indexing', 'completed')).toBe(true);
    expect(canApplyEvent('queued', 'failed')).toBe(true);
    expect(canApplyEvent('uploaded', 'completed')).toBe(false);
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
  type Doc = Parameters<typeof acceptsChange>[0];
  const doc = (over: Partial<Doc>): Doc => ({
    processingState: 'completed',
    searchState: 'searchable',
    queuedVersion: null,
    latestVersion: '2',
    ...over,
  });
  const KINDS: ChangeKind[] = ['edit', 'content', 'reindex'];

  it('T-STATE-4 completed·failed는 편집·내용 다시 올리기·재색인을 모두 받는다', () => {
    for (const processingState of ['completed', 'failed'] as const) {
      for (const kind of KINDS) {
        expect(acceptsChange(doc({ processingState }), kind)).toBe(true);
      }
    }
  });

  it('T-STATE-4 대기열 queued(queuedVersion === latestVersion)는 편집·내용 다시 올리기만 받고 재색인은 거부한다', () => {
    const queued = doc({ processingState: 'queued', queuedVersion: '2', latestVersion: '2' });
    expect(acceptsChange(queued, 'edit')).toBe(true);
    expect(acceptsChange(queued, 'content')).toBe(true);
    expect(acceptsChange(queued, 'reindex')).toBe(false);
  });

  it('T-STATE-4 대기열 밖 queued(RAG 접수, queuedVersion null)는 셋 다 거부한다', () => {
    const accepted = doc({ processingState: 'queued', queuedVersion: null });
    for (const kind of KINDS) expect(acceptsChange(accepted, kind)).toBe(false);
  });

  it('T-STATE-4 uploaded·captioning·indexing은 셋 다 거부한다', () => {
    for (const processingState of ['uploaded', 'captioning', 'indexing'] as const) {
      for (const kind of KINDS) expect(acceptsChange(doc({ processingState }), kind)).toBe(false);
    }
  });
});

describe('REQ-BE-1.10.6', () => {
  type Doc = Parameters<typeof acceptsChange>[0];

  it('T-STATE-6 queue 변경은 failed만 받는다', () => {
    for (const processingState of STATES) {
      const doc: Doc = {
        processingState,
        searchState: 'not_searchable',
        queuedVersion: processingState === 'queued' ? '1' : null,
        latestVersion: '1',
      };
      expect(acceptsChange(doc, 'queue')).toBe(processingState === 'failed');
    }
  });
});

describe('REQ-BE-1.5.6', () => {
  type Doc = Parameters<typeof acceptsChange>[0];

  it('T-STATE-7 교체된 문서는 처리 상태와 무관하게 네 종류 모두 거부한다', () => {
    const kinds: ChangeKind[] = ['edit', 'content', 'reindex', 'queue'];
    for (const processingState of STATES) {
      const doc: Doc = {
        processingState,
        searchState: 'replaced',
        queuedVersion: processingState === 'queued' ? '1' : null,
        latestVersion: '1',
      };
      for (const kind of kinds) expect(acceptsChange(doc, kind)).toBe(false);
    }
  });
});

describe('REQ-BE-1.6.3', () => {
  it('T-STATE-5 버전 번호는 숫자로 더하고 뺀다', () => {
    expect(nextVersion('9')).toBe('10');
    expect(previousVersion('1')).toBeNull();
    expect(previousVersion('10')).toBe('9');
  });
});
