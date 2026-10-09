import {
  AnswerSpanNotFoundError,
  AssetNotFoundError,
  CommonModule,
  DocumentLockedError,
  DocumentNotFoundError,
  DocumentNotSearchableError,
  DomainError,
  EvaluationInProgressError,
  GoldenSetNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
  PageQueryDto,
  RagUnavailableError,
  REDACTED_LOG_PATHS,
  UnauthorizedError,
  UnsupportedFileError,
  kstDayRange,
  createLoggerParams,
  createPinoHttpOptions,
  parseKstDayRange,
  scrubForbiddenKeys,
  toIsoUtc,
  toPage,
} from './index';
import * as barrel from './index';
import type { AppConfig, ErrorCode, Page, ProcessingState, SearchState } from './index';

describe('REQ-BE-8.1.1', () => {
  // ★ contract·unused 도구가 없어 공개 표면 전체(오류·날짜 변환 포함)를 여기서 한 번에 보완 검증한다
  it('T-SURF 배럴의 값 export 이름이 공개 표면 목록과 정확히 같다', () => {
    const expected = [
      'CommonModule',
      'DomainError',
      'InvalidRequestError',
      'UnsupportedFileError',
      'PayloadTooLargeError',
      'UnauthorizedError',
      'DocumentNotFoundError',
      'AssetNotFoundError',
      'GoldenSetNotFoundError',
      'DocumentLockedError',
      'DocumentNotSearchableError',
      'AnswerSpanNotFoundError',
      'EvaluationInProgressError',
      'RagUnavailableError',
      'toIsoUtc',
      'kstDayRange',
      'parseKstDayRange',
      'toPage',
      'PageQueryDto',
      'REDACTED_LOG_PATHS',
      'createLoggerParams',
      'createPinoHttpOptions',
      'scrubForbiddenKeys',
    ];
    // ★ 내부 이름(FORBIDDEN_LOG_KEYS, REMOVED, DEFAULT_PAGE, ConfigValidationError, validateConfig, BACKEND_ROOT)이 새면 실패한다
    expect(Object.keys(barrel).sort()).toEqual([...expected].sort());
    for (const internal of [
      'FORBIDDEN_LOG_KEYS',
      'REMOVED',
      'DEFAULT_PAGE',
      'ConfigValidationError',
      'validateConfig',
      'BACKEND_ROOT',
    ]) {
      expect(Object.keys(barrel)).not.toContain(internal);
    }
    // ★ libs의 AppLoggerModule은 CommonModule로 합쳐져 없다
    expect(Object.keys(barrel)).not.toContain('AppLoggerModule');
  });

  it('CommonModule이 클래스다', () => {
    expect(typeof CommonModule).toBe('function');
  });

  it('AppConfig가 18개 키와 타입을 가진다', () => {
    const keys: (keyof AppConfig)[] = [
      'PORT',
      'MONGODB_URI',
      'FILE_STORAGE_DIR',
      'RAG_SERVER_URL',
      'RAG_SERVER_API_TOKEN',
      'RAG_EVENTS_TOKEN',
      'RAG_TIMEOUT_MS',
      'RAG_CAPTION_TIMEOUT_MS',
      'RAG_WAIT_TIMEOUT_MS',
      'CHUNKING_MODE',
      'INDEX_SCHEDULE_CRON',
      'RECONCILE_INTERVAL_MS',
      'RAG_RETRY_INTERVAL_MS',
      'LOG_RETENTION_DAYS',
      'UPLOAD_MAX_MD_BYTES',
      'UPLOAD_MAX_IMAGE_BYTES',
      'UPLOAD_MAX_FILES',
      'UPLOAD_MAX_TOTAL_BYTES',
    ];
    expect(keys).toHaveLength(18);

    const port: AppConfig['PORT'] = 1;
    const mode: AppConfig['CHUNKING_MODE'] = 'rule';
    // @ts-expect-error CHUNKING_MODE는 semantic·rule만 허용한다
    const _bad: AppConfig['CHUNKING_MODE'] = 'fixed';
    expect(port).toBe(1);
    expect(mode).toBe('rule');
  });
});

describe('REQ-BE-8.3.1', () => {
  it('ErrorCode 타입이 배럴에서 import된다', () => {
    const code: ErrorCode = 'DOCUMENT_NOT_FOUND';
    expect(code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('하위 클래스 인스턴스가 배럴의 DomainError 인스턴스다', () => {
    const classes = [
      InvalidRequestError,
      UnsupportedFileError,
      PayloadTooLargeError,
      UnauthorizedError,
      DocumentNotFoundError,
      AssetNotFoundError,
      GoldenSetNotFoundError,
      DocumentLockedError,
      DocumentNotSearchableError,
      AnswerSpanNotFoundError,
      EvaluationInProgressError,
      RagUnavailableError,
    ];
    expect(classes).toHaveLength(12);
    for (const Cls of classes) {
      expect(new Cls()).toBeInstanceOf(DomainError);
    }
  });
});

describe('REQ-BE-8.4.1', () => {
  it('toIsoUtc·kstDayRange·parseKstDayRange가 함수이고 start가 Date다', () => {
    expect(typeof toIsoUtc).toBe('function');
    expect(typeof kstDayRange).toBe('function');
    expect(typeof parseKstDayRange).toBe('function');
    expect(kstDayRange('2026-10-04').start).toBeInstanceOf(Date);
    expect(parseKstDayRange('2026-10-04').start).toBeInstanceOf(Date);
  });
});

describe('REQ-BE-8.2.1', () => {
  it('createLoggerParams·createPinoHttpOptions·scrubForbiddenKeys가 함수다', () => {
    expect(typeof createLoggerParams).toBe('function');
    expect(typeof createPinoHttpOptions).toBe('function');
    expect(typeof scrubForbiddenKeys).toBe('function');
  });

  it('REDACTED_LOG_PATHS가 배열이고 req.body를 담는다', () => {
    expect(Array.isArray(REDACTED_LOG_PATHS)).toBe(true);
    expect(REDACTED_LOG_PATHS).toContain('req.body');
  });
});

describe('REQ-BE-7.1.3', () => {
  it('PageQueryDto가 클래스이고 toPage가 기본값을 채운다', () => {
    expect(typeof PageQueryDto).toBe('function');
    expect(toPage([], 0, {})).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
  });

  it('Page<T> 형태를 갖는다', () => {
    const page: Page<string> = { items: [], total: 0, page: 1, page_size: 20 };
    expect(page.page_size).toBe(20);
  });
});

describe('REQ-BE-1.9', () => {
  it('ProcessingState·SearchState가 API.md 값과 같다', () => {
    const ps: ProcessingState[] = [
      'uploaded',
      'captioning',
      'queued',
      'indexing',
      'completed',
      'failed',
    ];
    const ss: SearchState[] = ['searchable', 'not_searchable', 'replaced'];
    // @ts-expect-error done은 처리 상태가 아니다
    const _bad: ProcessingState = 'done';
    expect(ps).toHaveLength(6);
    expect(ss).toHaveLength(3);
  });
});
