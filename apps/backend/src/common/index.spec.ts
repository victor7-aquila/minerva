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
  RagUnavailableError,
  UnauthorizedError,
  UnsupportedFileError,
  parseKstDayRange,
} from './index';
import * as barrel from './index';
import type { AppConfig, ErrorCode, ProcessingState, SearchState } from './index';

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
      'parseKstDayRange',
    ];
    // ★ 내부 이름(ConfigValidationError, scrubForbiddenKeys, createLoggerParams, kstDayRange, toPage 등)이 새면 실패한다
    expect(Object.keys(barrel).sort()).toEqual([...expected].sort());
  });

  it('CommonModule이 클래스다', () => {
    expect(typeof CommonModule).toBe('function');
  });

  it('AppConfig가 16개 키와 타입을 가진다', () => {
    const keys: (keyof AppConfig)[] = [
      'PORT',
      'MONGODB_URI',
      'FILE_STORAGE_DIR',
      'RAG_SERVER_URL',
      'RAG_SERVER_API_TOKEN',
      'RAG_EVENTS_TOKEN',
      'RAG_TIMEOUT_MS',
      'RAG_CAPTION_TIMEOUT_MS',
      'CHUNKING_MODE',
      'RECONCILE_INTERVAL_MS',
      'RAG_RETRY_INTERVAL_MS',
      'LOG_RETENTION_DAYS',
      'UPLOAD_MAX_MD_BYTES',
      'UPLOAD_MAX_IMAGE_BYTES',
      'UPLOAD_MAX_FILES',
      'UPLOAD_MAX_TOTAL_BYTES',
    ];
    expect(keys).toHaveLength(16);

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
  it('parseKstDayRange가 함수이고 start가 Date다', () => {
    expect(typeof parseKstDayRange).toBe('function');
    expect(parseKstDayRange('2026-10-04').start).toBeInstanceOf(Date);
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
