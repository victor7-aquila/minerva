import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validateSync } from 'class-validator';
import { PageQueryDto } from '../interfaces/page-query.dto';
import type { Page } from '../interfaces/page';
import { toPage } from './page';

/** 쿼리 문자열 값을 변환·검증한다. api의 전역 ValidationPipe와 같은 경로다. */
function check<T extends PageQueryDto>(cls: new () => T, plain: Record<string, unknown>) {
  const dto = plainToInstance(cls, plain);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors, properties: errors.map((e) => e.property) };
}

/** 목록 DTO가 이어받는 경우다. */
class SampleListQuery extends PageQueryDto {
  @IsOptional()
  @IsString()
  name?: string;
}

describe('REQ-BE-7.1.3', () => {
  it('T-PAGE-1 값을 주지 않으면 기본값이 채워진다', () => {
    const { dto, errors } = check(PageQueryDto, {});
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.page_size).toBe(20);
    expect(dto.order).toBe('desc');
  });

  it('T-PAGE-2 허용 값을 숫자로 변환한다', () => {
    const { dto, errors } = check(PageQueryDto, { page: '3', page_size: '50', order: 'asc' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.page_size).toBe(50);
    expect(dto.order).toBe('asc');
    expect(check(PageQueryDto, { page_size: '20' }).errors).toHaveLength(0);
    expect(check(PageQueryDto, { page_size: '100' }).errors).toHaveLength(0);
  });

  it.each(['10', '30', '0', '101', 'abc', '50.5'])('T-PAGE-3 page_size %j 는 거부한다', (value) => {
    const { errors, properties } = check(PageQueryDto, { page_size: value });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(properties).toContain('page_size');
  });

  describe('T-PAGE-4 page 제약', () => {
    it.each(['0', '-1', '1.5', 'abc', ''])('page %j 는 거부한다', (value) => {
      expect(check(PageQueryDto, { page: value }).properties).toContain('page');
    });

    it.each(['1', '999'])('page %j 는 통과한다', (value) => {
      expect(check(PageQueryDto, { page: value }).errors).toHaveLength(0);
    });
  });

  it.each(['up', 'ASC'])('T-PAGE-5 order %j 는 거부한다', (value) => {
    expect(check(PageQueryDto, { order: value }).properties).toContain('order');
  });

  describe('T-PAGE-6 상속 DTO', () => {
    it('이어받은 DTO에서도 page_size 제약이 적용된다', () => {
      expect(check(SampleListQuery, { page_size: '30', name: 'a' }).properties).toContain(
        'page_size',
      );
    });

    it('허용 값이면 통과하고 기본값이 이어진다', () => {
      const { dto, errors } = check(SampleListQuery, { page_size: '100', name: 'a' });
      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(1);
      expect(dto.order).toBe('desc');
    });

    it('모르는 필드는 거부하지만 세 필드는 whitelist에서 지워지지 않는다', () => {
      expect(check(SampleListQuery, { foo: '1' }).errors.length).toBeGreaterThanOrEqual(1);
      expect(check(SampleListQuery, { page: '2' }).errors).toHaveLength(0);
      expect(check(SampleListQuery, { page_size: '50' }).errors).toHaveLength(0);
      expect(check(SampleListQuery, { order: 'asc' }).errors).toHaveLength(0);
    });
  });

  describe('T-PAGE-7 toPage', () => {
    it('목록·전체 개수·페이지 정보를 정확히 네 키로 돌려준다', () => {
      const query = Object.assign(new PageQueryDto(), { page: 2, page_size: 50 as const });
      const result = toPage(['a', 'b'], 42, query);
      expect(result).toEqual({ items: ['a', 'b'], total: 42, page: 2, page_size: 50 });
      expect(Object.keys(result).sort()).toEqual(['items', 'page', 'page_size', 'total']);
    });

    it('변환되지 않은 평범한 객체도 기본값으로 채운다', () => {
      expect(toPage([], 0, {})).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
    });

    it('반환 타입이 Page<T>다', () => {
      const p: Page<number> = toPage([1], 1, {});
      expect(p.items).toEqual([1]);
    });
  });
});
