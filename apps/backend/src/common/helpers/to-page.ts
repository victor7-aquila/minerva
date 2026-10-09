import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../interfaces/page-query.dto';
import type { PageQueryDto } from '../interfaces/page-query.dto';
import type { Page } from '../interfaces/page';

/** 목록과 전체 개수로 페이지 응답을 만든다. */
export function toPage<T>(items: T[], total: number, query: PageQueryDto): Page<T> {
  // ★ 변환되지 않은 평범한 객체가 와도 기본값을 채운다
  return {
    items,
    total,
    page: query.page ?? DEFAULT_PAGE,
    page_size: query.page_size ?? DEFAULT_PAGE_SIZE,
  };
}
