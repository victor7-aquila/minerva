import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PageQueryDto } from '../../../libs/utils';
import { LOG_KINDS } from './logs.types';
import type { LogKind, LogOutcome, LogSortColumn } from './logs.types';

/** 날짜 형식이다. 달력에 있는 날짜인지는 서비스에서 parseKstDayRange가 본다. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 쉼표로 이은 값을 나눈다. ★ 다듬기·빈 항목 제거를 하지 않는다 — 뒤의 검증이 거부한다 */
function splitList(value: unknown): unknown {
  if (typeof value === 'string') return value.split(',');
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => (typeof item === 'string' ? item.split(',') : [item]));
  }
  return value;
}

/** 로그 목록 요청이다. */
export class ListLogsQueryDto extends PageQueryDto {
  // ★ whitelist·forbidNonWhitelisted 때문에 모든 필드에 데코레이터가 있어야 한다
  @IsOptional()
  @IsIn(['occurred_at', 'kind', 'outcome'])
  sort?: LogSortColumn = 'occurred_at';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => splitList(value))
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(LOG_KINDS, { each: true })
  kind?: LogKind[];

  @IsOptional()
  @IsIn(['success', 'failure'])
  outcome?: LogOutcome;

  @IsOptional()
  @Matches(DAY_PATTERN)
  from?: string;

  @IsOptional()
  @Matches(DAY_PATTERN)
  to?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  doc_id?: string;
}
