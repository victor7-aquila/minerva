/** 검증을 마친 설정값이다. 키는 「설정」 표와 하나씩 대응한다. */
export interface AppConfig {
  PORT: number;
  MONGODB_URI: string;
  /** ★ BACKEND_ROOT 기준으로 푼 절대 경로 */
  FILE_STORAGE_DIR: string;
  RAG_SERVER_URL: string;
  RAG_SERVER_API_TOKEN: string;
  RAG_EVENTS_TOKEN: string;
  RAG_TIMEOUT_MS: number;
  RAG_CAPTION_TIMEOUT_MS: number;
  RAG_WAIT_TIMEOUT_MS: number;
  CHUNKING_MODE: 'semantic' | 'rule';
  INDEX_SCHEDULE_CRON: string;
  RECONCILE_INTERVAL_MS: number;
  RAG_RETRY_INTERVAL_MS: number;
  LOG_RETENTION_DAYS: number;
  UPLOAD_MAX_MD_BYTES: number;
  UPLOAD_MAX_IMAGE_BYTES: number;
  UPLOAD_MAX_FILES: number;
  UPLOAD_MAX_TOTAL_BYTES: number;
}

/** 설정 검증 실패다. 키 이름만 담는다. */
export class ConfigValidationError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    // ★ 키 이름만 담는다. 값(비밀 포함)은 절대 넣지 않는다 (REQ-BE-8.1.1)
    super(`설정값이 없거나 올바르지 않습니다: ${keys.join(', ')}`);
    this.name = 'ConfigValidationError';
    this.keys = [...keys];
  }
}
