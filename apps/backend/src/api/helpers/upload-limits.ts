import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../common';

const KB = 1024;
const MB = 1024 * 1024;

/** multipart 한도다. */
export interface UploadLimits {
  /** 파일 수 (UPLOAD_MAX_FILES) */
  readonly maxFiles: number;
  /** 파일 하나 = max(UPLOAD_MAX_MD_BYTES, UPLOAD_MAX_IMAGE_BYTES) */
  readonly maxFileBytes: number;
  /** HTTP 본문 전체 (UPLOAD_MAX_TOTAL_BYTES) */
  readonly maxTotalBytes: number;
}

/** 설정에서 multipart 한도를 읽는다. */
export function readUploadLimits(config: ConfigService<AppConfig, true>): UploadLimits {
  const md = config.get('UPLOAD_MAX_MD_BYTES', { infer: true });
  const image = config.get('UPLOAD_MAX_IMAGE_BYTES', { infer: true });
  return {
    maxFiles: config.get('UPLOAD_MAX_FILES', { infer: true }),
    maxFileBytes: Math.max(md, image),
    maxTotalBytes: config.get('UPLOAD_MAX_TOTAL_BYTES', { infer: true }),
  };
}

/** 바이트 수를 한도 표기(MB·KB·바이트)로 바꾼다. */
export function formatBytes(bytes: number): string {
  if (bytes % MB === 0) {
    return `${bytes / MB}MB`;
  }
  if (bytes % KB === 0) {
    return `${bytes / KB}KB`;
  }
  return `${bytes}바이트`;
}

/** 파일 수 초과 메시지를 만든다. */
export function tooManyFilesMessage(maxFiles: number): string {
  return `파일은 한 요청에 ${maxFiles}개까지 올릴 수 있습니다`;
}

/** 파일 하나 크기 초과 메시지를 만든다. */
export function fileTooLargeMessage(fileName: string, maxFileBytes: number): string {
  const base = `파일 하나의 크기 한도(${formatBytes(maxFileBytes)})를 넘었습니다`;
  return fileName === '' ? base : `${base}: ${fileName}`;
}

/** 요청 전체 크기 초과 메시지를 만든다. */
export function requestTooLargeMessage(maxTotalBytes: number): string {
  return `요청 전체 크기 한도(${formatBytes(maxTotalBytes)})를 넘었습니다`;
}
