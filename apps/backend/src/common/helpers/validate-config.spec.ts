import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigValidationError } from '../interfaces/app-config';
import { BACKEND_ROOT, validateConfig } from './validate-config';

/** 필수 키만 채운 최소 환경 */
const REQUIRED_ENV = {
  MONGODB_URI: 'mongodb://localhost:27017/minerva',
  RAG_SERVER_URL: 'http://localhost:8000',
  RAG_SERVER_API_TOKEN: 'rag-api-token-SENTINEL',
  RAG_EVENTS_TOKEN: 'rag-events-token-SENTINEL',
};

const REQUIRED_KEYS = Object.keys(REQUIRED_ENV);

const ALL_KEYS = [
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
] as const;

const OPTIONAL_KEYS = ALL_KEYS.filter((k) => !REQUIRED_KEYS.includes(k));

/** 호출 결과를 느슨한 타입으로 읽는다. */
function load(env: Record<string, string | undefined>): Record<string, unknown> {
  return validateConfig(env) as unknown as Record<string, unknown>;
}

/** 던져진 ConfigValidationError를 잡아 돌려준다. */
function catchError(env: Record<string, string | undefined>): ConfigValidationError {
  try {
    validateConfig(env);
  } catch (e) {
    return e as ConfigValidationError;
  }
  throw new Error('예외가 발생하지 않았다');
}

describe('REQ-BE-8.1.1', () => {
  describe('T-CFG-1 키별 환경 변수 반영', () => {
    const cases: [string, string, unknown][] = [
      ['PORT', '8080', 8080],
      [
        'MONGODB_URI',
        'mongodb+srv://u:p@cluster.example/db',
        'mongodb+srv://u:p@cluster.example/db',
      ],
      ['FILE_STORAGE_DIR', 'custom/files', path.resolve(BACKEND_ROOT, 'custom/files')],
      ['RAG_SERVER_URL', 'http://rag-server:8000', 'http://rag-server:8000'],
      ['RAG_SERVER_API_TOKEN', 'tok-a', 'tok-a'],
      ['RAG_EVENTS_TOKEN', 'tok-b', 'tok-b'],
      ['RAG_TIMEOUT_MS', '1500', 1500],
      ['RAG_CAPTION_TIMEOUT_MS', '90000', 90000],
      ['RAG_WAIT_TIMEOUT_MS', '45000', 45000],
      ['CHUNKING_MODE', 'rule', 'rule'],
      ['INDEX_SCHEDULE_CRON', '30 6 * * *', '30 6 * * *'],
      ['RECONCILE_INTERVAL_MS', '5000', 5000],
      ['RAG_RETRY_INTERVAL_MS', '7000', 7000],
      ['LOG_RETENTION_DAYS', '30', 30],
      ['UPLOAD_MAX_MD_BYTES', '1024', 1024],
      ['UPLOAD_MAX_IMAGE_BYTES', '2048', 2048],
      ['UPLOAD_MAX_FILES', '5', 5],
      ['UPLOAD_MAX_TOTAL_BYTES', '4096', 4096],
    ];

    it.each(cases)('%s를 주면 반영한다', (key, value, expected) => {
      const result = load({ ...REQUIRED_ENV, [key]: value });
      expect(result[key]).toBe(expected);
      expect(typeof result[key]).toBe(typeof expected);
    });

    it('반환 객체의 키 집합이 18개와 정확히 같고 모르는 환경 변수는 섞이지 않는다', () => {
      const result = load({
        ...REQUIRED_ENV,
        PATH: '/usr/bin',
        NODE_ENV: 'test',
        EXTRA_KEY: 'x',
      });
      expect(Object.keys(result).sort()).toEqual([...ALL_KEYS].sort());
    });
  });

  describe('T-CFG-2 기본값', () => {
    const defaults: [string, unknown][] = [
      ['PORT', 3000],
      ['RAG_TIMEOUT_MS', 30000],
      ['RAG_CAPTION_TIMEOUT_MS', 120000],
      ['RAG_WAIT_TIMEOUT_MS', 600000],
      ['CHUNKING_MODE', 'semantic'],
      ['INDEX_SCHEDULE_CRON', '0 0 * * *'],
      ['RECONCILE_INTERVAL_MS', 60000],
      ['RAG_RETRY_INTERVAL_MS', 60000],
      ['LOG_RETENTION_DAYS', 90],
      ['UPLOAD_MAX_MD_BYTES', 10485760],
      ['UPLOAD_MAX_IMAGE_BYTES', 20971520],
      ['UPLOAD_MAX_FILES', 200],
      ['UPLOAD_MAX_TOTAL_BYTES', 209715200],
    ];

    it.each(defaults)('%s를 주지 않으면 기본값을 쓴다', (key, expected) => {
      expect(load({ ...REQUIRED_ENV })[key]).toBe(expected);
    });

    it('FILE_STORAGE_DIR 기본값은 저장소 루트의 data/backend/files다', () => {
      const dir = load({ ...REQUIRED_ENV }).FILE_STORAGE_DIR;
      expect(dir).toBe(path.resolve(BACKEND_ROOT, '../../data/backend/files'));
      expect(dir).toBe(path.resolve(BACKEND_ROOT, '..', '..', 'data', 'backend', 'files'));
    });
  });

  describe('T-CFG-3 빈 문자열은 없음 [B]', () => {
    const defaultsByKey: Record<string, unknown> = {
      PORT: 3000,
      FILE_STORAGE_DIR: path.resolve(BACKEND_ROOT, '../../data/backend/files'),
      RAG_TIMEOUT_MS: 30000,
      RAG_CAPTION_TIMEOUT_MS: 120000,
      RAG_WAIT_TIMEOUT_MS: 600000,
      CHUNKING_MODE: 'semantic',
      INDEX_SCHEDULE_CRON: '0 0 * * *',
      RECONCILE_INTERVAL_MS: 60000,
      RAG_RETRY_INTERVAL_MS: 60000,
      LOG_RETENTION_DAYS: 90,
      UPLOAD_MAX_MD_BYTES: 10485760,
      UPLOAD_MAX_IMAGE_BYTES: 20971520,
      UPLOAD_MAX_FILES: 200,
      UPLOAD_MAX_TOTAL_BYTES: 209715200,
    };

    it.each(OPTIONAL_KEYS)('선택 키 %s가 빈 문자열이면 기본값이 나온다', (key) => {
      expect(OPTIONAL_KEYS).toHaveLength(14);
      expect(load({ ...REQUIRED_ENV, [key]: '' })[key]).toBe(defaultsByKey[key]);
    });

    it.each(REQUIRED_KEYS)('필수 키 %s가 빈 문자열이면 실패하고 키 이름이 있다', (key) => {
      const env = { ...REQUIRED_ENV, [key]: '' };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
      expect(catchError(env).message).toContain(key);
    });
  });

  describe('T-CFG-4 필수 키 누락', () => {
    it.each(REQUIRED_KEYS)('%s가 없으면 키 이름만 담은 오류를 던진다', (key) => {
      const env: Record<string, string | undefined> = { ...REQUIRED_ENV };
      delete env[key];

      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
      const error = catchError(env);
      expect(error.message).toContain(key);
      for (const other of REQUIRED_KEYS.filter((k) => k !== key)) {
        expect(error.message).not.toContain(REQUIRED_ENV[other as keyof typeof REQUIRED_ENV]);
      }
      expect(error.keys).toEqual([key]);
    });
  });

  describe('T-CFG-5 제약 위반', () => {
    const invalid: [string, string][] = [
      ['PORT', '0'],
      ['PORT', '65536'],
      ['PORT', 'abc-SENTINEL'],
      ['PORT', '3000.5'],
      ['PORT', '-1'],
      ['PORT', ' 3000'],
      ['RAG_TIMEOUT_MS', '0'],
      ['RAG_TIMEOUT_MS', '1e3'],
      ['RAG_WAIT_TIMEOUT_MS', '0'],
      ['UPLOAD_MAX_FILES', '0'],
      ['LOG_RETENTION_DAYS', 'ninety'],
      ['CHUNKING_MODE', 'fixed-SENTINEL'],
      ['RAG_SERVER_URL', 'not a url SENTINEL'],
      ['RAG_SERVER_URL', 'ftp://rag-SENTINEL:21'],
      ['RAG_SERVER_URL', 'rag-server:8000'],
      ['MONGODB_URI', 'http://mongo-SENTINEL:27017'],
      ['MONGODB_URI', 'localhost:27017'],
    ];

    it.each(invalid)('%s=%j 는 실패하고 메시지에 값이 없다', (key, value) => {
      const env = { ...REQUIRED_ENV, [key]: value };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
      const { message } = catchError(env);
      expect(message).toContain(key);
      expect(message).not.toContain(value);
      expect(message).not.toContain('SENTINEL');
    });

    const valid: [string, string][] = [
      ['PORT', '1'],
      ['PORT', '65535'],
      ['RAG_TIMEOUT_MS', '1'],
      ['RAG_WAIT_TIMEOUT_MS', '1'],
      ['RAG_SERVER_URL', 'https://rag.example.com/base'],
      ['RAG_SERVER_URL', 'http://localhost:8000'],
    ];

    it.each(valid)('경계 %s=%s 는 통과한다', (key, value) => {
      expect(() => validateConfig({ ...REQUIRED_ENV, [key]: value })).not.toThrow();
    });
  });

  describe('T-CFG-CRON-1 INDEX_SCHEDULE_CRON이 받는 값', () => {
    // ★ cron 4.4.0이 받고 공백으로 나눈 필드가 정확히 5개인 표현식이다
    const accepted = [
      '0 0 * * *',
      '*/15 9-18 * * 1-5',
      '0 0 1,15 * *',
      '30 2 * JAN-MAR mon',
      '0 0 * * 7',
      '5/10 * * * *',
      '  0 0 * * *  ',
      // 문법은 맞지만 오지 않는 일정이다. 기동은 허용한다(P-3)
      '0 0 31 2 *',
    ];

    it.each(accepted)('%j 는 받는다', (value) => {
      const result = load({ ...REQUIRED_ENV, INDEX_SCHEDULE_CRON: value });
      expect(result.INDEX_SCHEDULE_CRON).toBe(value);
    });
  });

  describe('T-CFG-CRON-2 INDEX_SCHEDULE_CRON이 거부하는 값', () => {
    // ★ 앞 둘은 cron 패키지는 받지만 5필드가 아니라 거부한다
    const rejected = [
      '0 0 0 * * *',
      '@daily',
      '0 0 * *',
      '60 0 * * *',
      '0 24 * * *',
      '0 0 0 * *',
      '0 0 * 13 *',
      '0 0 * * 8',
      '*/0 * * * *',
      '5-1 * * * *',
      '0 0 ? * *',
      '0 0 L * *',
      'abc',
    ];

    it.each(rejected)('%j 는 실패하고 이유에 키 이름만 있다', (value) => {
      const env = { ...REQUIRED_ENV, INDEX_SCHEDULE_CRON: value };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
      const error = catchError(env);
      expect(error.keys).toEqual(['INDEX_SCHEDULE_CRON']);
      expect(error.message).toContain('INDEX_SCHEDULE_CRON');
      expect(error.message).not.toContain(value);
    });

    it('센티널 값이 오류 메시지에 없다', () => {
      const env = { ...REQUIRED_ENV, INDEX_SCHEDULE_CRON: '0 0 * * SENTINEL' };
      const { message } = catchError(env);
      expect(message).toContain('INDEX_SCHEDULE_CRON');
      expect(message).not.toContain('SENTINEL');
    });

    it('빈 문자열은 없는 것으로 보아 기본값을 쓴다', () => {
      expect(load({ ...REQUIRED_ENV, INDEX_SCHEDULE_CRON: '' }).INDEX_SCHEDULE_CRON).toBe(
        '0 0 * * *',
      );
    });
  });

  describe('T-CFG-6 여러 키 실패를 한 번에', () => {
    it('실패한 키를 모두 알리고 표 순서로 담는다', () => {
      const env: Record<string, string | undefined> = {
        ...REQUIRED_ENV,
        PORT: '0',
        CHUNKING_MODE: 'x',
      };
      delete env.MONGODB_URI;

      const error = catchError(env);
      expect(error.message).toContain('PORT');
      expect(error.message).toContain('MONGODB_URI');
      expect(error.message).toContain('CHUNKING_MODE');
      expect(error.keys).toEqual(['PORT', 'MONGODB_URI', 'CHUNKING_MODE']);
    });
  });

  describe('T-CFG-7 상대 경로 기준과 절대 경로', () => {
    it('BACKEND_ROOT는 apps/backend 폴더다', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('@minerva/backend');
    });

    it('FILE_STORAGE_DIR에 절대 경로를 주면 그대로 나온다', () => {
      const abs = path.resolve(os.tmpdir(), 'minerva-files');
      expect(load({ ...REQUIRED_ENV, FILE_STORAGE_DIR: abs }).FILE_STORAGE_DIR).toBe(abs);
    });

    it('FILE_STORAGE_DIR 결과는 항상 절대 경로다', () => {
      expect(path.isAbsolute(load({ ...REQUIRED_ENV }).FILE_STORAGE_DIR as string)).toBe(true);
      expect(
        path.isAbsolute(
          load({ ...REQUIRED_ENV, FILE_STORAGE_DIR: 'rel/dir' }).FILE_STORAGE_DIR as string,
        ),
      ).toBe(true);
    });
  });
});
