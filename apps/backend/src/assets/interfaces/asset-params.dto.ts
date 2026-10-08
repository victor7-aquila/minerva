import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** 이미지 요청의 경로 파라미터다. */
export class AssetParamsDto {
  @IsString() @IsNotEmpty() @MaxLength(256) doc_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(256) version!: string;
  @IsString() @IsNotEmpty() @MaxLength(256) placeholder_id!: string;
}
