// ★ @Type 메타데이터가 reflect-metadata를 요구한다. 단독 import(단위 테스트)에서도 동작하게 직접 가져온다
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { RagJobStage, RagJobState } from '../../rag';
import type { RagEventNotification } from './indexing.types';

/** 작업 상태 값 목록이다(IF-2 job_state). */
const JOB_STATES: RagJobState[] = ['queued', 'running', 'succeeded', 'failed', 'superseded'];
/** 색인 중 단계 값 목록이다(IF-2 index_state.latest_job_stage). */
const JOB_STAGES: RagJobStage[] = ['chunking', 'embedding', 'storing'];

/** 알림의 문서 색인 상태다(IF-2 index_state). */
export class RagIndexStateDto {
  // ★ null 허용·필수: 빠지면(undefined) 검사를 타서 실패한다
  @ValidateIf((_o: unknown, value: unknown) => value !== null)
  @IsString()
  @IsNotEmpty()
  searchable_version!: string | null;

  @IsString()
  @IsNotEmpty()
  latest_job_id!: string;

  @IsIn(JOB_STATES)
  latest_job_state!: RagJobState;

  @ValidateIf((_o: unknown, value: unknown) => value !== null)
  @IsIn(JOB_STAGES)
  latest_job_stage!: RagJobStage | null;
}

/** RAG Server 작업 상태 알림 본문이다(루트 IF-2). */
export class RagEventDto {
  @IsString()
  @IsNotEmpty()
  doc_id!: string;

  @IsString()
  @IsNotEmpty()
  job_id!: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsIn(JOB_STATES)
  job_state!: RagJobState;

  @IsObject()
  @ValidateNested()
  @Type(() => RagIndexStateDto)
  index_state!: RagIndexStateDto;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence!: number;
}

/** 알림 본문을 서비스 입력으로 옮긴다. */
export function toNotification(dto: RagEventDto): RagEventNotification {
  return {
    docId: dto.doc_id,
    jobId: dto.job_id,
    version: dto.version,
    jobState: dto.job_state,
    searchableVersion: dto.index_state.searchable_version,
    sequence: dto.sequence,
  };
}
