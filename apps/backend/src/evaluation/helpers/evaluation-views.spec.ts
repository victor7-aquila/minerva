import {
  DOC_A,
  DOC_B,
  evaluatingRecord,
  evaluationRecord,
  goldenSetRecord,
} from '../../../test/support/evaluation-fixtures';
import { EVALUATION_MESSAGES } from '../interfaces/evaluation.types';
import type { AnswerRefView } from '../interfaces/evaluation.types';
import { toAnswerView, toGoldenSetView, toMetricsView, toRecordView } from './evaluation-views';

describe('REQ-BE-5.3.2', () => {
  it('T-VIEW-1 골든셋 응답의 키 집합과 순서가 명세와 같다', () => {
    const answer: AnswerRefView = { doc_id: DOC_A, name: 'N', edition: null };
    const view = toGoldenSetView(
      goldenSetRecord({ editionOnly: true }),
      evaluationRecord({ evaluatedAt: new Date('2026-10-01T00:00:05.678Z') }),
      answer,
    );
    expect(Object.keys(view)).toEqual([
      'golden_set_id',
      'query',
      'answer',
      'answer_span',
      'edition_only',
      'created_at',
      'latest',
    ]);
    expect(view.created_at).toBe('2026-10-01T00:00:00Z');
    expect(view.edition_only).toBe(true);
    expect(Object.keys(view.latest)).toEqual([
      'outcome',
      'n',
      'base',
      'expanded',
      'error_message',
      'evaluated_at',
    ]);
    // ★ 밀리초를 버린다
    expect(view.latest.evaluated_at).toBe('2026-10-01T00:00:05Z');
    const all = JSON.stringify(view);
    for (const key of ['recordId', 'startedAt', 'goldenSetId', '_id']) {
      expect(all).not.toContain(`"${key}"`);
    }
  });

  it('T-VIEW-2 정답 문서 참조는 삭제된 문서도 이름·판을 주고 없으면 알 수 없는 문서다', () => {
    const edition = { label: 'v1', editionDate: '2025-01-31' };
    const deleted = toAnswerView(DOC_A, { docId: DOC_A, name: 'N', edition, deleted: true });
    expect(deleted).toEqual({
      doc_id: DOC_A,
      name: 'N',
      edition: { label: 'v1', edition_date: '2025-01-31' },
    });
    expect(Object.keys(deleted).sort()).toEqual(['doc_id', 'edition', 'name']);
    expect(
      toAnswerView(DOC_A, { docId: DOC_A, name: 'N', edition: null, deleted: false }).edition,
    ).toBeNull();
    expect(toAnswerView(DOC_B, null)).toEqual({
      doc_id: DOC_B,
      name: '알 수 없는 문서',
      edition: null,
    });
    expect(EVALUATION_MESSAGES.unknownDocument).toBe('알 수 없는 문서');
  });

  it('T-VIEW-3 지표와 평가 중 기록을 snake_case로 바꾼다', () => {
    expect(
      toMetricsView({
        hitAt1: false,
        hitAt3: true,
        hitAt5: true,
        hitAtN: true,
        rank: 2,
        reciprocalRank: 0.5,
        coverage: 0.75,
      }),
    ).toEqual({
      hit_at_1: false,
      hit_at_3: true,
      hit_at_5: true,
      hit_at_n: true,
      rank: 2,
      reciprocal_rank: 0.5,
      coverage: 0.75,
    });
    expect(toRecordView(evaluatingRecord())).toEqual({
      outcome: 'evaluating',
      n: null,
      base: null,
      expanded: null,
      error_message: null,
      evaluated_at: null,
    });
  });
});
