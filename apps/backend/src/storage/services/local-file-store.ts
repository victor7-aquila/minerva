import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvalidRequestError } from '../../common';
import type { AppConfig } from '../../common';
import type { FileStore } from '../interfaces/file-store';

/** 키가 올바르지 않을 때 쓰는 메시지다. ★ 키 원문을 넣지 않는다 */
const INVALID_KEY_MESSAGE = '파일 키가 올바르지 않습니다';

/** 그 키 자리에 파일이 없음을 뜻하는 오류 코드다. */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** 키의 형식을 검사한다. 비었거나, `..`를 담거나, 절대 경로이면 InvalidRequestError를 던진다. */
function assertKeyShape(key: string): void {
  // ★ '..'는 부분 문자열로 막는다. POSIX·Windows 어느 쪽으로든 절대 경로면 막는다
  if (
    key.length === 0 ||
    key.includes('..') ||
    path.posix.isAbsolute(key) ||
    path.win32.isAbsolute(key)
  ) {
    throw new InvalidRequestError(INVALID_KEY_MESSAGE);
  }
}

/** target이 root 안에 있는지 본다. allowRoot면 root 자신도 안으로 본다. */
function isInside(root: string, target: string, allowRoot: boolean): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return allowRoot;
  // ★ 다른 드라이브면 path.relative가 절대 경로를 돌려준다 (Windows)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 오류가 "그 자리에 파일이 없음"인지 본다. ★ 실행 영역(realm)이 달라도 맞도록 instanceof 대신 code 필드로 판별한다 */
function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return MISSING_CODES.has(String(error.code));
}

/** 로컬 파일 시스템에 이미지 파일을 읽고 쓴다. */
@Injectable()
export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(@Inject(ConfigService) config: ConfigService<AppConfig, true>) {
    // common이 이미 절대 경로로 풀어 준다. 비교를 위해 정규화만 한다
    this.root = path.resolve(config.get('FILE_STORAGE_DIR', { infer: true }));
  }

  /** 키 자리에 데이터를 쓴다. 중간 폴더가 없으면 만든다. */
  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolveFileKey(key);
    // ★ node:fs 함수는 호출 시점에 nodeFs.promises로 부른다 (모듈 로드 때 캡처하지 않는다)
    await nodeFs.promises.mkdir(path.dirname(target), { recursive: true });
    await nodeFs.promises.writeFile(target, data);
  }

  /** 키 자리의 데이터를 읽는다. 없으면 null이다. */
  async read(key: string): Promise<Buffer | null> {
    // ★ 검증은 try 밖: InvalidRequestError가 null로 바뀌면 안 된다
    const target = this.resolveFileKey(key);
    try {
      return await nodeFs.promises.readFile(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** 접두사로 시작하는 키의 파일을 모두 지운다. 없으면 아무 일 없이 끝난다. */
  async deletePrefix(prefix: string): Promise<void> {
    assertKeyShape(prefix);
    const cut = prefix.lastIndexOf('/');
    const dirPart = cut < 0 ? '' : prefix.slice(0, cut);
    const namePart = prefix.slice(cut + 1);
    const dir = path.resolve(this.root, dirPart);
    // ★ 접두사 전체도 풀어 확인한다: 'D:x' 같은 Windows 드라이브 상대 접두사는 폴더 부분이 비어도 밖을 가리킨다
    if (
      !isInside(this.root, dir, true) ||
      !isInside(this.root, path.resolve(this.root, prefix), true)
    )
      throw new InvalidRequestError(INVALID_KEY_MESSAGE);
    // ★ 저장 위치 전체를 가리키는 접두사('./' 등)는 빈 키와 같으므로 거부한다
    if (namePart === '' && path.relative(this.root, dir) === '') {
      throw new InvalidRequestError(INVALID_KEY_MESSAGE);
    }

    if (namePart === '') {
      // ★ 접두사가 폴더 전체면 폴더째 지운다 — 문서·버전마다 빈 폴더가 쌓이지 않게 한다
      try {
        // ★ 파일을 폴더처럼 쓴 접두사('a.png/')는 그 파일을 지우지 않는다 — 폴더일 때만 지운다
        const info = await nodeFs.promises.lstat(dir);
        if (info.isDirectory()) {
          await nodeFs.promises.rm(dir, { recursive: true, force: true });
        }
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      return;
    }

    let names: string[];
    try {
      names = await nodeFs.promises.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const matched = names.filter((name) => name.startsWith(namePart));
    await Promise.all(
      matched.map((name) =>
        nodeFs.promises.rm(path.join(dir, name), { recursive: true, force: true }),
      ),
    );
  }

  /** 파일 키를 저장 위치 안의 절대 경로로 푼다. 밖이거나 저장 위치 자신이면 InvalidRequestError를 던진다. */
  private resolveFileKey(key: string): string {
    assertKeyShape(key);
    const target = path.resolve(this.root, key);
    // ★ 형식 검사를 통과해도 풀린 경로가 밖이면 막는다 (Windows 드라이브 상대 경로 등)
    if (!isInside(this.root, target, false)) throw new InvalidRequestError(INVALID_KEY_MESSAGE);
    return target;
  }
}
