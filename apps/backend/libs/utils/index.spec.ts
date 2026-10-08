import * as barrel from './index';
import { PageQueryDto, kstDayRange, toIsoUtc, toPage } from './index';
import type { Page } from './index';

describe('REQ-BE-8.4.1', () => {
  it('T-SURF 배럴의 값 export 이름이 공개 표면 목록과 정확히 같다', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      ['PageQueryDto', 'kstDayRange', 'toIsoUtc', 'toPage'].sort(),
    );
  });

  it('toIsoUtc·kstDayRange가 함수이고 start가 Date다', () => {
    expect(typeof toIsoUtc).toBe('function');
    expect(typeof kstDayRange).toBe('function');
    expect(kstDayRange('2026-10-04').start).toBeInstanceOf(Date);
  });
});

describe('REQ-BE-7.1.3', () => {
  it('PageQueryDto가 클래스이고 toPage가 기본값을 채운다', () => {
    expect(typeof PageQueryDto).toBe('function');
    expect(toPage([], 0, {})).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
  });

  it('Page<T> 형태를 갖는다', () => {
    const page: Page<string> = { items: [], total: 0, page: 1, page_size: 20 };
    expect(page.page_size).toBe(20);
  });
});
