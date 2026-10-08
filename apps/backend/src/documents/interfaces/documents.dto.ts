import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { ValidationOptions } from 'class-validator';
import { kstDayRange, PageQueryDto } from '../../../libs/utils';
import type { ProcessingState, SearchState } from '../../common';
import type { DocumentSortColumn } from './documents.types';

/** doc_id 형식(소문자 UUID v4)이다. */
export const DOC_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 공백이 아닌 글자가 하나 이상 있다. */
const NOT_BLANK = /\S/;
/** 날짜 형식이다. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 달력에 있는 YYYY-MM-DD 날짜인가를 본다. */
function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  try {
    kstDayRange(value);
    return true;
  } catch {
    return false;
  }
}

/** 달력에 있는 YYYY-MM-DD 날짜만 받는다. */
function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    { name: 'isCalendarDate', validator: { validate: (value: unknown) => isCalendarDate(value) } },
    options,
  );
}

/** 쉼표로 이은 값을 나눈다. ★ 다듬기·빈 항목 제거를 하지 않는다 — 뒤의 검증이 거부한다 */
function splitList(value: unknown): unknown {
  if (typeof value === 'string') return value.split(',');
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => (typeof item === 'string' ? item.split(',') : [item]));
  }
  return value;
}

/** 'true'·'false' 문자열을 불리언으로 바꾼다. 그 밖은 그대로 둬 뒤의 검증이 거부한다. */
function toBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** 평범한 객체인가를 본다. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** meta 필드(JSON 문자열 또는 배열)를 문서 정보 DTO 배열로 바꾼다. */
function parseMeta(value: unknown): unknown {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value; // ★ 원래 문자열을 돌려줘 IsArray가 거부하게 한다
    }
  }
  if (!Array.isArray(parsed)) return parsed;
  return parsed.map((item: unknown) =>
    isPlainObject(item) ? plainToInstance(UploadMetaDto, item) : item,
  );
}

/** 경로의 doc_id다. */
export class DocIdParamDto {
  @IsString()
  @Matches(DOC_ID_PATTERN)
  doc_id!: string;
}

/** 판 정보 요청이다. */
export class EditionDto {
  @IsString()
  @Matches(NOT_BLANK)
  label!: string;

  @IsString()
  @IsCalendarDate()
  edition_date!: string;
}

/** 업로드 문서 정보 하나다. */
export class UploadMetaDto {
  @IsString()
  @IsNotEmpty()
  file_name!: string;

  @IsString()
  @Matches(NOT_BLANK)
  name!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EditionDto)
  edition?: EditionDto | null;
}

/** 업로드 본문이다. */
export class UploadBodyDto {
  // ★ @Type을 달지 않는다 — 인스턴스 만들기를 이 Transform이 맡는다
  @Transform(({ value }: { value: unknown }) => parseMeta(value))
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  meta!: UploadMetaDto[];
}

/** 문서 목록 쿼리다. */
export class ListDocumentsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['name', 'search_state', 'processing_state', 'uploaded_at', 'updated_at'])
  sort?: DocumentSortColumn = 'updated_at';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => splitList(value))
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['searchable', 'not_searchable', 'replaced'], { each: true })
  search_state?: SearchState[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => splitList(value))
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['uploaded', 'captioning', 'queued', 'indexing', 'completed', 'failed'], { each: true })
  processing_state?: ProcessingState[];

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toBoolean(value))
  @IsBoolean()
  has_edition?: boolean;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toBoolean(value))
  @IsBoolean()
  latest_only?: boolean;

  @IsOptional()
  @IsCalendarDate()
  uploaded_from?: string;

  @IsOptional()
  @IsCalendarDate()
  uploaded_to?: string;
}

/** 문서 이름 목록 쿼리다. */
export class DocumentNamesQueryDto {
  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

/** 같은 판 확인 쿼리다. */
export class ReplacementCheckQueryDto {
  @IsString()
  @Matches(NOT_BLANK)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(NOT_BLANK)
  edition_label?: string;

  @IsOptional()
  @Matches(DOC_ID_PATTERN)
  exclude_doc_id?: string;
}

/** 요약·캡션 문장 변경 하나다. */
export class AssetTextUpdateDto {
  @IsString()
  @IsNotEmpty()
  placeholder_id!: string;

  @IsString()
  @Matches(NOT_BLANK)
  text!: string;
}

/** 문서 편집 본문이다. */
export class EditDocumentDto {
  // ★ IsOptional을 쓰지 않는다 — null이 통과한다. 빠진 필드만 건너뛴다
  @ValidateIf((o: EditDocumentDto) => o.name !== undefined)
  @IsString()
  @Matches(NOT_BLANK)
  name?: string;

  // null은 판 정보 지우기다
  @IsOptional()
  @ValidateNested()
  @Type(() => EditionDto)
  edition?: EditionDto | null;

  @ValidateIf((o: EditDocumentDto) => o.assets !== undefined)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssetTextUpdateDto)
  @ArrayUnique((a: AssetTextUpdateDto) => a.placeholder_id)
  assets?: AssetTextUpdateDto[];
}
