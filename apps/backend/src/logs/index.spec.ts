import * as barrel from './index';
import type { LogDetail, LogInput, LogKind, LogsService } from './index';
import type { ProcessingState } from '../common';

/** 두 타입이 정확히 같은지 본다. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

describe('REQ-BE-6.1.1', () => {
  it('T-SURF-1 배럴의 값 export는 LogsModule·LogsService뿐이다', () => {
    expect(Object.keys(barrel).sort()).toEqual(['LogsModule', 'LogsService']);
  });

  it('T-SURF-2 LogKind·LogInput·LogDetail의 모양이 고정이다', () => {
    expect(
      assertType<
        Equals<
          LogKind,
          | 'upload'
          | 'content_upload'
          | 'captioning'
          | 'processing_state'
          | 'edit'
          | 'delete'
          | 'replace'
        >
      >(),
    ).toBe(true);
    expect(
      assertType<
        Equals<
          LogInput,
          {
            kind: LogKind;
            docId: string;
            name: string;
            editionLabel: string | null;
            outcome: 'success' | 'failure';
            detail?: LogDetail;
          }
        >
      >(),
    ).toBe(true);
    expect(
      assertType<
        Equals<
          LogDetail,
          {
            fromState?: ProcessingState;
            toState?: ProcessingState;
            reasonCode?: string;
            count?: number;
            failedCount?: number;
            changedFields?: ReadonlyArray<'name' | 'edition' | 'hints'>;
            replacedByDocId?: string;
          }
        >
      >(),
    ).toBe(true);
  });

  it('T-SURF-3 record 시그니처가 고정이다', () => {
    expect(assertType<Equals<Parameters<LogsService['record']>, [LogInput]>>()).toBe(true);
    expect(assertType<Equals<ReturnType<LogsService['record']>, Promise<void>>>()).toBe(true);
  });

  it('T-SURF-4 LogKind가 일곱 값을 명세 순서대로 갖는다', () => {
    // ★ 배열 항목 타입이 LogKind라 타입에 없는 값이나 오타는 컴파일 오류다
    const kinds: LogKind[] = [
      'upload',
      'content_upload',
      'captioning',
      'processing_state',
      'edit',
      'delete',
      'replace',
    ];
    expect(kinds).toHaveLength(7);
    expect(new Set(kinds).size).toBe(7);
  });
});

describe('REQ-BE-6.1.3', () => {
  it('T-SURF-5 자유 문장 필드와 틀 밖 값은 타입 오류다', () => {
    const base = { docId: 'doc-1', name: '이름', editionLabel: null } as const;
    // ★ 각 줄은 변수 대입이라 초과 속성 검사가 걸린다
    // @ts-expect-error message 필드는 없다
    const a: LogInput = { ...base, kind: 'upload', outcome: 'success', message: '자유 문장' };
    // @ts-expect-error description 필드는 없다
    const b: LogInput = { ...base, kind: 'upload', outcome: 'success', description: '설명' };
    // @ts-expect-error detail에 text 필드는 없다
    const c: LogInput = { ...base, kind: 'edit', outcome: 'success', detail: { text: '본문' } };
    const e: LogInput = {
      ...base,
      kind: 'edit',
      outcome: 'success',
      // @ts-expect-error 편집 필드는 name·edition·hints뿐이다
      detail: { changedFields: ['body'] },
    };
    // @ts-expect-error 없는 종류다
    const f: LogInput = { ...base, kind: 'other', outcome: 'success' };
    // @ts-expect-error 없는 결과다
    const g: LogInput = { ...base, kind: 'upload', outcome: 'partial' };
    expect([a, b, c, e, f, g]).toHaveLength(6);
  });
});
