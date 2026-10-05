import { describeLog } from './log-description';
import type { LogDetail, LogKind } from '../interfaces/logs.types';

/** describeLog를 부르기 쉽게 감싼다. */
function d(kind: LogKind, outcome: 'success' | 'failure', detail?: LogDetail): string {
  return describeLog({ kind, outcome, detail });
}

describe('REQ-BE-6.1.2', () => {
  it('T-DESC-1 upload 문장', () => {
    expect(d('upload', 'success')).toBe('문서를 올렸습니다');
    expect(d('upload', 'failure')).toBe('문서를 올리지 못했습니다');
  });

  it('T-DESC-2 content_upload 문장', () => {
    expect(d('content_upload', 'success')).toBe('내용을 다시 올렸습니다');
    expect(d('content_upload', 'failure')).toBe('내용을 다시 올리지 못했습니다');
  });

  it('T-DESC-3 captioning 문장', () => {
    expect(d('captioning', 'success', { count: 3, failedCount: 1 })).toBe(
      '요약·캡션 3개를 만들었습니다 (임시 설명 1개)',
    );
    expect(d('captioning', 'failure', {})).toBe('요약·캡션을 만들지 못했습니다');
  });

  it.each([
    ['queued', 'indexing', '처리 상태가 색인 대기에서 색인 중으로 바뀌었습니다'],
    ['indexing', 'completed', '처리 상태가 색인 중에서 완료로 바뀌었습니다'],
    ['uploaded', 'captioning', '처리 상태가 업로드됨에서 요약·캡션 생성 중으로 바뀌었습니다'],
    ['captioning', 'queued', '처리 상태가 요약·캡션 생성 중에서 색인 대기로 바뀌었습니다'],
  ] as const)('T-DESC-4 processing_state 성공 %s → %s', (fromState, toState, expected) => {
    expect(d('processing_state', 'success', { fromState, toState })).toBe(expected);
  });

  it('T-DESC-5 processing_state 실패는 사유 코드를 붙인다', () => {
    expect(
      d('processing_state', 'failure', {
        fromState: 'indexing',
        toState: 'failed',
        reasonCode: 'EMBEDDING_FAILED',
      }),
    ).toBe('처리 상태가 색인 중에서 실패로 바뀌었습니다 (사유 EMBEDDING_FAILED)');
  });

  it.each([
    ['success', ['name'], '이름을 고쳤습니다'],
    ['success', ['hints'], '요약·캡션을 고쳤습니다'],
    ['success', ['edition'], '판 정보를 고쳤습니다'],
    ['success', ['hints', 'name', 'edition'], '이름, 판 정보, 요약·캡션을 고쳤습니다'],
    ['success', ['edition', 'name'], '이름, 판 정보를 고쳤습니다'],
    ['failure', ['name'], '이름을 고치지 못했습니다'],
  ] as const)('T-DESC-6 edit %s %j', (outcome, changedFields, expected) => {
    expect(d('edit', outcome, { changedFields })).toBe(expected);
  });

  it('T-DESC-7 delete·replace 문장', () => {
    expect(d('delete', 'success')).toBe('문서를 삭제했습니다');
    expect(d('delete', 'failure')).toBe('문서 삭제를 마치지 못했습니다');
    expect(d('replace', 'success')).toBe('같은 판의 다른 문서로 교체됐습니다');
  });

  it.each([
    ['uploaded', '업로드됨으로'],
    ['captioning', '요약·캡션 생성 중으로'],
    ['queued', '색인 대기로'],
    ['indexing', '색인 중으로'],
    ['completed', '완료로'],
    ['failed', '실패로'],
  ] as const)('T-DESC-8 toState %s의 표시 이름과 조사', (toState, expected) => {
    expect(d('processing_state', 'success', { fromState: 'queued', toState })).toBe(
      `처리 상태가 색인 대기에서 ${expected} 바뀌었습니다`,
    );
  });
});

describe('REQ-BE-6.1.3', () => {
  // 결정 4(CONTEXT.md): 틀에 넣을 값이 없으면 기록은 남기고 빈 값을 대체한다
  it('T-DESC-9 captioning 개수가 없거나 잘못되면 0이다', () => {
    const zero = '요약·캡션 0개를 만들었습니다 (임시 설명 0개)';
    expect(d('captioning', 'success')).toBe(zero);
    expect(d('captioning', 'success', { count: 2, failedCount: 0 })).toBe(
      '요약·캡션 2개를 만들었습니다 (임시 설명 0개)',
    );
    expect(d('captioning', 'success', { count: -1, failedCount: 1.5 })).toBe(zero);
  });

  it('T-DESC-10 처리 상태 값이 없으면 알 수 없음이다', () => {
    expect(d('processing_state', 'success')).toBe(
      '처리 상태가 알 수 없음에서 알 수 없음으로 바뀌었습니다',
    );
  });

  // 결정 4(CONTEXT.md): 코드 형식이 아닌 reasonCode는 알 수 없음으로 대체한다
  it.each([
    [undefined, '알 수 없음'],
    ['문서 본문 일부가 여기 들어감', '알 수 없음'],
    ['lower_case', '알 수 없음'],
    ['A'.repeat(65), '알 수 없음'],
    ['REPLACED', 'REPLACED'],
  ])('T-DESC-11 reasonCode %j', (reasonCode, shown) => {
    const text = d('processing_state', 'failure', { reasonCode });
    expect(text).toContain(`(사유 ${shown})`);
    expect(text).not.toContain('문서 본문');
    expect(text).not.toContain('lower_case');
  });

  // 결정 3·4(CONTEXT.md): 편집 필드가 없거나 표에 없으면 항목으로 대체한다
  it('T-DESC-12 edit 변경 필드가 없거나 표에 없으면 항목이다', () => {
    expect(d('edit', 'success')).toBe('항목을 고쳤습니다');
    expect(d('edit', 'success', { changedFields: [] })).toBe('항목을 고쳤습니다');
    expect(d('edit', 'success', { changedFields: ['name', 'name'] })).toBe('이름을 고쳤습니다');
    expect(d('edit', 'success', { changedFields: ['body'] as never })).toBe('항목을 고쳤습니다');
  });

  it('T-DESC-13 replace는 실패여도 같은 문장이고 교체 문서 id가 없다', () => {
    const expected = '같은 판의 다른 문서로 교체됐습니다';
    expect(d('replace', 'failure')).toBe(expected);
    const text = d('replace', 'success', { replacedByDocId: 'doc-x' });
    expect(text).toBe(expected);
    expect(text).not.toContain('doc-x');
  });

  it('T-DESC-14 모든 종류·결과의 문장이 틀 문장 표와 같다', () => {
    // ★ 틀 밖의 글자(자유 문장)가 없음을 기대 문장 전체 비교로 고정한다
    const detail: LogDetail = {
      count: 3,
      failedCount: 1,
      fromState: 'queued',
      toState: 'indexing',
      reasonCode: 'REPLACED',
      changedFields: ['name'],
      replacedByDocId: 'doc-x',
    };
    const expected: Array<[LogKind, 'success' | 'failure', string]> = [
      ['upload', 'success', '문서를 올렸습니다'],
      ['upload', 'failure', '문서를 올리지 못했습니다'],
      ['content_upload', 'success', '내용을 다시 올렸습니다'],
      ['content_upload', 'failure', '내용을 다시 올리지 못했습니다'],
      ['captioning', 'success', '요약·캡션 3개를 만들었습니다 (임시 설명 1개)'],
      ['captioning', 'failure', '요약·캡션을 만들지 못했습니다'],
      ['processing_state', 'success', '처리 상태가 색인 대기에서 색인 중으로 바뀌었습니다'],
      [
        'processing_state',
        'failure',
        '처리 상태가 색인 대기에서 실패로 바뀌었습니다 (사유 REPLACED)',
      ],
      ['edit', 'success', '이름을 고쳤습니다'],
      ['edit', 'failure', '이름을 고치지 못했습니다'],
      ['delete', 'success', '문서를 삭제했습니다'],
      ['delete', 'failure', '문서 삭제를 마치지 못했습니다'],
      ['replace', 'success', '같은 판의 다른 문서로 교체됐습니다'],
    ];
    for (const [kind, outcome, text] of expected) {
      expect(d(kind, outcome, detail)).toBe(text);
    }
  });
});
