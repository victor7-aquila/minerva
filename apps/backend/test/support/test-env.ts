import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../src/common';

/** CommonModule이 읽는 18개 키를 모두 채운 환경 변수 객체를 만든다. 덮어쓸 값을 받는다. */
export function buildFullTestEnv(
  overrides: Partial<Record<keyof AppConfig, string>>,
): Record<string, string> {
  // ★ 18개 키를 모두 직접 준다. 그래야 apps/backend/.env 유무가 결과에 섞이지 않는다
  return {
    PORT: '3000',
    MONGODB_URI: 'mongodb://localhost:27017/minerva_test_unset',
    FILE_STORAGE_DIR: path.join(os.tmpdir(), 'minerva-unset'),
    RAG_SERVER_URL: 'http://localhost:8000',
    RAG_SERVER_API_TOKEN: 'e2e-rag-api-token',
    RAG_EVENTS_TOKEN: 'e2e-rag-events-token',
    RAG_TIMEOUT_MS: '30000',
    RAG_CAPTION_TIMEOUT_MS: '120000',
    RAG_WAIT_TIMEOUT_MS: '600000',
    CHUNKING_MODE: 'semantic',
    INDEX_SCHEDULE_CRON: '0 0 * * *',
    RECONCILE_INTERVAL_MS: '60000',
    RAG_RETRY_INTERVAL_MS: '60000',
    LOG_RETENTION_DAYS: '90',
    UPLOAD_MAX_MD_BYTES: '10485760',
    UPLOAD_MAX_IMAGE_BYTES: '20971520',
    UPLOAD_MAX_FILES: '200',
    UPLOAD_MAX_TOTAL_BYTES: '209715200',
    NODE_ENV: 'test',
    ...overrides,
  };
}
