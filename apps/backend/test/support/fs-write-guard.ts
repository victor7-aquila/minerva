import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 막힌 쓰기·삭제 호출 한 건의 기록이다. */
export interface BlockedCall {
  /** 막힌 함수 이름이다(예: `promises.rm`, `writeFileSync`). */
  fn: string;
  /** 막힌 대상 경로(절대 경로로 풀린 값)다. */
  target: string;
}

/** 설치된 안전 가드다. */
export interface FsWriteGuard {
  /** 허용 범위 밖 경로를 받아 막힌 호출 목록이다. */
  readonly blocked: BlockedCall[];
  /** 교체하지 못하고 건너뛴 함수 이름 목록이다(예: 이 플랫폼에 없는 함수, 목록의 오타). */
  readonly skipped: string[];
  /** 허용 범위 밖이지만 이 폴더(와 아래)는 잠시 허용한다. 반환 함수를 부르면 다시 막는다. */
  allowExtra(dir: string): () => void;
  /** 가로챈 함수를 원래대로 되돌린다. */
  restore(): void;
}

/** 가드의 허용 범위다. `root` 바로 아래 이름이 `prefix`로 시작하는 폴더(와 그 아래)만 쓰기·삭제를 허용한다. */
export interface FsWriteGuardScope {
  /** 허용 폴더들의 부모(보통 `os.tmpdir()`)다. */
  root: string;
  /** 허용 폴더 이름 접두사(예: `minerva-storage-`)다. */
  prefix: string;
}

/** 경로가 1개 대상인 쓰기·삭제 계열이다. 이름 `X`는 `fs.X`·`fs.XSync`·`fs.promises.X`로 확장한다. */
const SINGLE_PATH_FNS = [
  'rm',
  'rmdir',
  'unlink',
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'truncate',
  'chmod',
  'chown',
  'lchmod',
  'lchown',
  'utimes',
  'lutimes',
  'open',
];

/** 경로가 2개(원본·대상)인 계열이다. 두 경로 모두 허용 범위 안이어야 통과한다. */
const DUAL_PATH_FNS = ['rename', 'copyFile', 'cp', 'link', 'symlink'];

/** 경로 인자를 1개만 받고 동기·콜백 형태만 있는 쓰기 스트림 생성 함수다. */
const STREAM_FNS = ['createWriteStream'];

/** open 계열이 쓰기 의도인지 flags로 판단한다. 읽기 전용(`r`)이면 통과시킨다. */
function isWriteFlags(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & 0b11) !== 0 || (flags & 0o100) !== 0;
  return typeof flags === 'string' && /[wa+]/.test(flags);
}

/** 인자 값을 절대 경로 문자열로 푼다. 경로가 아닌 값이면 undefined다. */
function toPath(value: unknown): string | undefined {
  if (typeof value === 'string') return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString());
  if (value instanceof URL) return path.resolve(value.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return undefined;
}

/** 대상이 base 안(base 자신 포함)인지 본다. */
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 대상이 root 바로 아래 `prefix*` 폴더(접두사만 준 mkdtemp 경로 포함) 안인지 본다. */
function isInsideScope(scope: FsWriteGuardScope, target: string): boolean {
  if (!isInside(scope.root, target)) return false;
  const first = path.relative(scope.root, target).split(path.sep)[0];
  return first.startsWith(scope.prefix);
}

/**
 * node:fs와 node:fs/promises의 쓰기·삭제 계열 함수를 가로채, 허용 범위 밖 경로를 받으면 원래 함수를
 * 절대 실행하지 않고 막은 뒤 기록하는 안전 가드를 설치한다. 허용 범위 안이면 원래 함수를 그대로 실행한다.
 * ★ 결함 구현이 위험 키로 개발자 PC의 기존 파일·폴더를 만들거나 지우지 못하게 하는 장치다.
 */
export function installFsWriteGuard(scopeInput: FsWriteGuardScope): FsWriteGuard {
  const scope: FsWriteGuardScope = {
    root: path.resolve(scopeInput.root),
    prefix: scopeInput.prefix,
  };
  const extras = new Set<string>();
  const skipped: string[] = [];
  /** 허용 범위 안인지(추가 허용 폴더 포함) 본다. */
  const allowed = (target: string): boolean =>
    isInsideScope(scope, target) || [...extras].some((dir) => isInside(dir, target));
  const blocked: BlockedCall[] = [];
  const restores: Array<() => void> = [];

  /** obj[name]을 가드 함수로 바꾼다. 함수가 아니면 건너뛴다. */
  function wrap(
    obj: Record<string, unknown>,
    label: string,
    name: string,
    pathsOf: (args: unknown[]) => unknown[],
    mode: 'promise' | 'throw',
  ): void {
    const original = obj[name];
    if (typeof original !== 'function') {
      skipped.push(`${label}${name}`);
      return;
    }
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const targets = pathsOf(args).map(toPath);
      // 경로를 풀 수 없는 인자(파일 디스크립터 등)는 읽기 전용 호출이 아니면 막는 쪽이 안전하다
      const outside = targets.filter((t) => t === undefined || !allowed(t));
      if (outside.length === 0) return (original as (...a: unknown[]) => unknown).apply(obj, args);
      for (const t of targets) {
        if (t === undefined || !allowed(t)) {
          blocked.push({ fn: `${label}${name}`, target: t ?? '(경로 아님)' });
        }
      }
      const error = new Error(`안전 가드가 허용 범위 밖 쓰기·삭제를 막았습니다: ${label}${name}`);
      if (mode === 'promise') return Promise.reject(error);
      throw error;
    };
    obj[name] = wrapper;
    restores.push(() => {
      obj[name] = original;
    });
  }

  /** open 계열은 쓰기 flags일 때만 경로를 검사한다. */
  const openPaths =
    (flagsIndex: number) =>
    (args: unknown[]): unknown[] =>
      isWriteFlags(args[flagsIndex]) ? [args[0]] : [];

  const fsObj = fs as unknown as Record<string, unknown>;
  const fspObj = fsp as unknown as Record<string, unknown>;

  for (const name of SINGLE_PATH_FNS) {
    const pathsOf = name === 'open' ? openPaths(1) : (args: unknown[]) => [args[0]];
    wrap(fsObj, 'fs.', name, pathsOf, 'throw');
    wrap(fsObj, 'fs.', `${name}Sync`, pathsOf, 'throw');
    wrap(fspObj, 'fs.promises.', name, pathsOf, 'promise');
  }
  for (const name of DUAL_PATH_FNS) {
    const pathsOf = (args: unknown[]) => [args[0], args[1]];
    wrap(fsObj, 'fs.', name, pathsOf, 'throw');
    wrap(fsObj, 'fs.', `${name}Sync`, pathsOf, 'throw');
    wrap(fspObj, 'fs.promises.', name, pathsOf, 'promise');
  }
  for (const name of STREAM_FNS) {
    wrap(fsObj, 'fs.', name, (args) => [args[0]], 'throw');
  }

  return {
    blocked,
    skipped,
    allowExtra: (dir: string) => {
      const resolved = path.resolve(dir);
      extras.add(resolved);
      return () => {
        extras.delete(resolved);
      };
    },
    restore: () => {
      for (const undo of restores.splice(0).reverse()) undo();
    },
  };
}
