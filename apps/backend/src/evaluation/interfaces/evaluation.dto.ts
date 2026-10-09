import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PageQueryDto } from '../../common';
import { GOLDEN_SET_SORT_COLUMNS, OUTCOME_FILTERS } from './evaluation.types';
import type { GoldenSetSortColumn, OutcomeFilter } from './evaluation.types';

/** 공백이 아닌 글자가 하나 이상 있다. */
const NOT_BLANK = /\S/;

/** 골든셋 추가 요청이다. */
export class CreateGoldenSetDto {
  @IsString()
  @Matches(NOT_BLANK)
  query!: string;

  // ★ UUID 형식 검사를 하지 않는다. 형식이 달라도 "문서 없음" 404다
  @IsString()
  @Matches(NOT_BLANK)
  doc_id!: string;

  @IsString()
  @Matches(NOT_BLANK)
  answer_span!: string;

  // ★ IsOptional은 null도 건너뛴다 — null은 빠진 것(false)과 같다
  @IsOptional()
  @IsBoolean()
  edition_only?: boolean | null;
}

/** 골든셋 목록 요청이다. */
export class ListGoldenSetsQueryDto extends PageQueryDto {
  // ★ whitelist·forbidNonWhitelisted 때문에 모든 필드에 데코레이터가 있어야 한다
  @IsOptional()
  @IsIn(GOLDEN_SET_SORT_COLUMNS)
  sort?: GoldenSetSortColumn = 'created_at';

  @IsOptional()
  @IsIn(OUTCOME_FILTERS)
  outcome?: OutcomeFilter;
}

/** 골든셋 경로 파라미터다. */
export class GoldenSetIdParamDto {
  // ★ 형식 검사를 하지 않는다. 없는 ID는 404 GOLDEN_SET_NOT_FOUND다
  @IsString()
  golden_set_id!: string;
}
