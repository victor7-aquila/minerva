import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { EditionScope } from './search.types';

/** 공백이 아닌 글자가 하나 이상 있다. */
const NOT_BLANK = /\S/;

/** 판 범위 값 목록이다. */
export const EDITION_SCOPES: readonly EditionScope[] = ['all', 'latest', 'specific'];

/** 검색에서 특정 판을 가리키는 요청이다 (API.md EditionRef). */
export class SearchEditionRefDto {
  @IsString()
  @Matches(NOT_BLANK)
  name!: string;

  @IsString()
  @Matches(NOT_BLANK)
  label!: string;
}

/** 검색 요청 본문이다. */
export class SearchRequestDto {
  @IsString()
  @Matches(NOT_BLANK)
  query!: string;

  // ★ IsOptional은 null도 건너뛴다 — null은 빠진 것과 같다
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  top_n?: number | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(NOT_BLANK, { each: true })
  names?: string[] | null;

  @IsOptional()
  @IsIn(EDITION_SCOPES)
  edition_scope?: EditionScope | null;

  // ★ specific이면 필수, 그 밖에는 주었을 때만 형식을 본다
  @ValidateIf(
    (o: SearchRequestDto) =>
      o.edition_scope === 'specific' || (o.edition !== undefined && o.edition !== null),
  )
  @IsDefined()
  @ValidateNested()
  @Type(() => SearchEditionRefDto)
  edition?: SearchEditionRefDto | null;

  @IsOptional()
  @IsBoolean()
  expand_neighbors?: boolean | null;
}
