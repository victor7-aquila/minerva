import * as fs from 'node:fs';
import * as path from 'node:path';
import { isURL } from 'class-validator';
import { ConfigValidationError } from '../interfaces/app-config';
import type { AppConfig } from '../interfaces/app-config';

/** package.json이 있는 가장 가까운 상위 폴더를 찾는다. */
function findBackendRoot(from: string): string {
  let dir = from;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    // ★ 못 찾으면 시작 폴더를 돌려준다. 무한 반복을 막는다
    if (parent === dir) return from;
    dir = parent;
  }
  return dir;
}

// ★ 소스(src/)와 빌드 결과(dist/src/)의 깊이가 달라 단계 수로 세지 않고 package.json을 찾아 올라간다
/** Backend 앱 폴더(apps/backend)의 절대 경로다. */
export const BACKEND_ROOT: string = findBackendRoot(__dirname);

/** 키 하나의 정의다. */
interface KeySpec<T> {
  /** 없을 때 쓰는 값. undefined면 필수 키다 */
  readonly fallback?: string;
  /** 문자열을 검증해 값으로 바꾼다. 맞지 않으면 undefined */
  readonly parse: (raw: string) => T | undefined;
}

/** 정수 문자열을 범위 안의 숫자로 바꾸는 파서를 만든다. */
function intIn(
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): (raw: string) => number | undefined {
  return (raw) => {
    if (!/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
  };
}

/** MongoDB 접속 문자열을 검증한다. */
function mongoUri(raw: string): string | undefined {
  return /^mongodb(\+srv)?:\/\/.+/.test(raw) ? raw : undefined;
}

/** http·https URL을 검증한다. */
function httpUrl(raw: string): string | undefined {
  return isURL(raw, { require_protocol: true, protocols: ['http', 'https'], require_tld: false })
    ? raw
    : undefined;
}

/** 비어 있지 않은 문자열을 검증한다. */
function nonEmpty(raw: string): string | undefined {
  return raw.length >= 1 ? raw : undefined;
}

/** 허용 값 목록 중 하나인지 검증하는 파서를 만든다. */
function oneOf<T extends string>(allowed: readonly T[]): (raw: string) => T | undefined {
  return (raw) => allowed.find((value) => value === raw);
}

/** 저장 경로를 BACKEND_ROOT 기준 절대 경로로 푼다. */
function storageDir(raw: string): string | undefined {
  return raw.length >= 1 ? path.resolve(BACKEND_ROOT, raw) : undefined;
}

/** 설정 키 정의다. MODULE.md 「설정」 표 순서와 같다. */
const KEY_SPECS: { readonly [K in keyof AppConfig]: KeySpec<AppConfig[K]> } = {
  PORT: { fallback: '3000', parse: intIn(1, 65535) },
  MONGODB_URI: { parse: mongoUri },
  FILE_STORAGE_DIR: { fallback: '../../data/backend/files', parse: storageDir },
  RAG_SERVER_URL: { parse: httpUrl },
  RAG_SERVER_API_TOKEN: { parse: nonEmpty },
  RAG_EVENTS_TOKEN: { parse: nonEmpty },
  RAG_TIMEOUT_MS: { fallback: '30000', parse: intIn(1) },
  RAG_CAPTION_TIMEOUT_MS: { fallback: '120000', parse: intIn(1) },
  RAG_WAIT_TIMEOUT_MS: { fallback: '600000', parse: intIn(1) },
  CHUNKING_MODE: { fallback: 'semantic', parse: oneOf(['semantic', 'rule'] as const) },
  RECONCILE_INTERVAL_MS: { fallback: '60000', parse: intIn(1) },
  RAG_RETRY_INTERVAL_MS: { fallback: '60000', parse: intIn(1) },
  LOG_RETENTION_DAYS: { fallback: '90', parse: intIn(1) },
  UPLOAD_MAX_MD_BYTES: { fallback: '10485760', parse: intIn(1) },
  UPLOAD_MAX_IMAGE_BYTES: { fallback: '20971520', parse: intIn(1) },
  UPLOAD_MAX_FILES: { fallback: '200', parse: intIn(1) },
  UPLOAD_MAX_TOTAL_BYTES: { fallback: '209715200', parse: intIn(1) },
};

/** 환경 변수 하나를 읽는다. ★ 빈 문자열은 없는 것으로 본다. 값을 다듬지 않는다. */
function readRaw(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

/** 환경 변수를 읽어 「설정」의 타입과 제약으로 검증한다. */
export function validateConfig(env: Record<string, string | undefined>): AppConfig {
  const failedKeys: string[] = [];
  const values: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(KEY_SPECS) as [keyof AppConfig, KeySpec<unknown>][]) {
    // ★ 기본값도 같은 parse를 거친다
    const raw = readRaw(env, key) ?? spec.fallback;
    const parsed = raw === undefined ? undefined : spec.parse(raw);
    if (parsed === undefined) {
      failedKeys.push(key);
    } else {
      values[key] = parsed;
    }
  }

  // ★ 실패 시 키 이름만 담아 던진다. 값은 담지 않는다
  if (failedKeys.length > 0) throw new ConfigValidationError(failedKeys);
  return values as unknown as AppConfig;
}
