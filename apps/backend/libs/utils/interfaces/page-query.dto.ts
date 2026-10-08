import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** 페이지 번호의 기본값이다. */
export const DEFAULT_PAGE = 1;
/** 페이지 크기의 기본값이다. */
export const DEFAULT_PAGE_SIZE = 20;
/** 허용하는 페이지 크기다. */
const PAGE_SIZES = [20, 50, 100] as const;

/** 페이지 요청이다. 목록 DTO가 이어받는다. */
export class PageQueryDto {
  // ★ whitelist·forbidNonWhitelisted 때문에 세 필드 모두 데코레이터가 있어야 한다
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = DEFAULT_PAGE;

  @IsOptional()
  @Type(() => Number)
  @IsIn(PAGE_SIZES)
  page_size?: 20 | 50 | 100 = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}
