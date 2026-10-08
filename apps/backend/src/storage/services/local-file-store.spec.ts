import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { InvalidRequestError } from '../../common';
import type { AppConfig } from '../../common';
import type { FileStore } from '../interfaces/file-store';
import { LocalFileStore } from './local-file-store';
import { installFsWriteGuard } from '../../../test/support/fs-write-guard';
import type { FsWriteGuard } from '../../../test/support/fs-write-guard';

/** 이진 데이터다. 줄바꿈·높은 바이트를 섞어 변환 손실을 잡는다. */
const BYTES = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x0a, 0x0d]);

let base: string;
let root: string;
let store: FileStore;
let guard: FsWriteGuard;

/** 가드 허용 범위다. os.tmpdir() 바로 아래 이 파일이 만든 minerva-storage- 폴더들만 허용한다. */
const GUARD_SCOPE = { root: os.tmpdir(), prefix: 'minerva-storage-' };

/** 위험 키 호출 한 건의 시간 제한(ms)이다. */
const RISKY_CALL_LIMIT_MS = 3000;

/** 아직 끝나지 않은 위험 키 호출이다. afterAll이 끝나기를 기다린 뒤에만 가드를 복원한다. */
const pending = new Set<Promise<unknown>>();

/**
 * 위험 키 호출에 짧은 시간 제한을 둔다. 제한을 넘기면 테스트는 실패하지만 호출 자체는 계속 돌 수 있으므로
 * pending에 남기고, 그 호출이 끝날 때까지 가드를 풀지 않는다.
 */
function withLimit<T>(task: Promise<T>): Promise<T> {
  pending.add(task);
  const settle = (): void => {
    pending.delete(task);
  };
  task.then(settle, settle);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('위험 키 호출이 시간 제한을 넘겼습니다')),
      RISKY_CALL_LIMIT_MS,
    );
  });
  return Promise.race([task, limit]).finally(() => clearTimeout(timer));
}

// ★ 가드는 파일 단위로 설치한다. 테스트별 설치·복원 사이의 틈이나 타임아웃 뒤 남은 작업이
//   가드 밖에서 실행되는 일이 없게, 복원은 남은 호출이 모두 끝난 뒤 afterAll에서만 한다
beforeAll(() => {
  guard = installFsWriteGuard(GUARD_SCOPE);
});

afterAll(async () => {
  // 남은 위험 키 호출을 기다린다. 끝나지 않으면 복원하지 않고 프로세스 종료까지 가드를 유지한다
  let waitTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => {
      waitTimer = setTimeout(resolve, 10_000);
    }),
  ]);
  clearTimeout(waitTimer);
  if (pending.size === 0) guard.restore();
}, 15_000);

// ★ root를 일부러 아직 없는 폴더로, base보다 두 단계 깊게 둔다. 첫 put이 만들어야 하고,
//   '../x'·'../../x.png'가 풀리는 자리도 base 안이 된다
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'minerva-storage-'));
  root = path.join(base, 'p1', 'p2', 'files');
  const config = {
    get: (key: string) => (key === 'FILE_STORAGE_DIR' ? root : undefined),
  } as unknown as ConfigService<AppConfig, true>;
  store = new LocalFileStore(config);
  // 테스트마다 막힌 호출 기록을 비운다(가드는 파일 단위라 기록이 이어진다)
  guard.blocked.length = 0;
});

afterEach(async () => {
  // ★ base 정리도 가드가 켜진 상태에서 한다(base는 허용 범위 안이다)
  await fs.rm(base, { recursive: true, force: true });
});

/** 거부 오류를 잡아 돌려준다. 거부되지 않으면 undefined다. */
async function catchError(task: Promise<unknown>): Promise<unknown> {
  return withLimit(task).then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** 폴더 아래 파일(폴더 제외)의 경로 목록이다. 폴더가 없으면 빈 목록이다. */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  } catch {
    return [];
  }
}

/** 경로가 있는지 본다. */
async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

const FORBIDDEN_KEYS = [
  '',
  '..',
  '../x',
  '../../x.png',
  'a/../../x',
  'a/..',
  'a/../b',
  'a..b.png',
  '/abs/x.png',
  'C:\\x.png',
  'C:/x.png',
  '\\\\server\\share\\x.png',
  '..\\x',
];

describe('REQ-BE-9.1.2', () => {
  it('T-FS-1 put 뒤 read가 같은 바이트를 돌려준다', async () => {
    await store.put('doc1/3/ph-1.png', BYTES);

    const result = await store.read('doc1/3/ph-1.png');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result?.equals(BYTES)).toBe(true);
  });

  it('T-FS-2 파일이 설정한 위치 아래 키 경로에 있다', async () => {
    await store.put('doc1/3/ph-1.png', BYTES);

    const target = path.join(root, 'doc1', '3', 'ph-1.png');
    const raw = await fs.readFile(target);

    expect(raw.equals(BYTES)).toBe(true);
    // 저장 위치 밖(base 아래 다른 곳)에는 파일이 없다
    await expect(listFiles(base)).resolves.toEqual([target]);
  });

  it('T-FS-3 중간 폴더와 저장 위치 자체가 없어도 만든다', async () => {
    await store.put('a/b/c/d.png', BYTES);

    const raw = await fs.readFile(path.join(root, 'a', 'b', 'c', 'd.png'));
    expect(raw.equals(BYTES)).toBe(true);
  });

  describe('없는 키', () => {
    it('T-FS-4a 저장 위치가 아예 없으면 null이다', async () => {
      await expect(store.read('doc1/1/x.png')).resolves.toBeNull();
    });

    it('T-FS-4b 같은 폴더의 다른 파일 이름이면 null이다', async () => {
      await store.put('doc1/1/a.png', BYTES);

      await expect(store.read('doc1/1/b.png')).resolves.toBeNull();
    });

    it('T-FS-4c 파일을 폴더처럼 쓴 키는 null이다', async () => {
      await store.put('doc1/1/a.png', BYTES);

      await expect(store.read('doc1/1/a.png/z')).resolves.toBeNull();
    });
  });

  describe('금지 키', () => {
    it.each(FORBIDDEN_KEYS)(
      'T-FS-5 금지 키 %j는 세 메서드 모두 InvalidRequestError다',
      async (key) => {
        const calls = [
          () => store.put(key, BYTES),
          () => store.read(key),
          () => store.deletePrefix(key),
        ];

        for (const call of calls) {
          const error = await catchError(call());

          expect(error).toBeInstanceOf(InvalidRequestError);
          expect((error as InvalidRequestError).code).toBe('INVALID_REQUEST');
          // ★ 오류 메시지에 키 원문을 넣지 않는다
          if (key !== '') {
            expect((error as Error).message.includes(key)).toBe(false);
          }
        }
        // ★ 저장 위치 밖을 건드리려던 쓰기·삭제 호출이 하나도 없어야 한다
        expect(guard.blocked).toEqual([]);
      },
    );
  });

  it('T-FS-6 거부된 put은 아무것도 쓰지 않는다', async () => {
    for (const key of ['../x', '../../x.png', 'a/../../x']) {
      await expect(withLimit(store.put(key, BYTES))).rejects.toBeInstanceOf(InvalidRequestError);
    }

    await expect(listFiles(base)).resolves.toEqual([]);
  });

  it.each(['D:x.png', 'Z:escape.png'])(
    'T-FS-7 드라이브 상대 키 %s는 세 메서드 모두 저장 위치 밖을 가리키지 못한다',
    async (key) => {
      const drivePrefix = key.slice(0, 2);
      const namePrefix = key.slice(0, key.indexOf('.'));

      if (process.platform === 'win32') {
        // ★ Windows에서는 풀린 경로가 저장 위치 밖이라 세 메서드 모두 거부한다. 접두사 삭제도 같다
        for (const call of [
          () => store.put(key, BYTES),
          () => store.read(key),
          () => store.deletePrefix(key),
          () => store.deletePrefix(namePrefix),
          () => store.deletePrefix(drivePrefix),
        ]) {
          await expect(catchError(call())).resolves.toBeInstanceOf(InvalidRequestError);
        }
        // ★ deletePrefix('D:') 같은 호출도 가드 아래에서만 실행됐고, 밖을 건드리려던 호출은 없어야 한다
        expect(guard.blocked).toEqual([]);
        return;
      }
      // ★ POSIX에서는 평범한 파일 이름이라 root 아래에 쓰이고 지워진다
      await store.put(key, BYTES);
      await expect(store.read(key)).resolves.toEqual(BYTES);
      await expect(fs.readdir(root, { recursive: true })).resolves.toContain(key);

      await store.deletePrefix(namePrefix);

      await expect(store.read(key)).resolves.toBeNull();
      expect(guard.blocked).toEqual([]);
    },
  );

  it('T-FS-14 안전 가드는 허용 범위 밖 쓰기·삭제를 실제로 막고 안은 통과시킨다', async () => {
    // ★ 가드 검증용 밖 폴더는 이 테스트가 직접 만든 임시 폴더이며, 만드는 동안만 허용해 둔다
    const outsideDir = path.join(os.tmpdir(), `minerva-guard-outside-${process.pid}-${Date.now()}`);
    const disallow = guard.allowExtra(outsideDir);
    await fs.mkdir(outsideDir);
    const outsideFile = path.join(outsideDir, 'keep.txt');
    await fs.writeFile(outsideFile, 'keep');
    disallow();
    guard.blocked.length = 0;
    const insideFile = path.join(base, 'inside.txt');
    try {
      await expect(fs.rm(outsideDir, { recursive: true, force: true })).rejects.toThrow();
      await expect(fs.writeFile(path.join(outsideDir, 'new.txt'), 'x')).rejects.toThrow();
      await expect(fs.unlink(outsideFile)).rejects.toThrow();
      await expect(fs.rename(outsideFile, insideFile)).rejects.toThrow();
      expect(() => nodeFs.rmSync(outsideDir, { recursive: true, force: true })).toThrow();
      expect(() => nodeFs.writeFileSync(outsideFile, 'x')).toThrow();
      // 읽기 전용 open은 통과한다
      await (await fs.open(outsideFile, 'r')).close();

      expect(guard.blocked.length).toBe(6);
      await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('keep');
      await expect(exists(path.join(outsideDir, 'new.txt'))).resolves.toBe(false);

      // base 안은 원래 함수가 실행된다
      await fs.writeFile(insideFile, 'ok');
      await expect(fs.readFile(insideFile, 'utf8')).resolves.toBe('ok');
      expect(guard.blocked.length).toBe(6);
    } finally {
      const allowAgain = guard.allowExtra(outsideDir);
      await fs.rm(outsideDir, { recursive: true, force: true });
      allowAgain();
      guard.blocked.length = 0;
    }
  });

  it('T-FS-15 가드 목록의 모든 이름이 실제 함수를 교체했다', () => {
    // ★ 이름 오타는 가드가 조용히 건너뛰므로 건너뛴 목록이 비어 있음을 확인한다.
    //   lchmod 계열은 macOS에만 있는 함수라 다른 플랫폼에서는 없어도 정상이다
    const platformOptional = new Set(['fs.lchmod', 'fs.lchmodSync', 'fs.promises.lchmod']);

    expect(guard.skipped.filter((name) => !platformOptional.has(name))).toEqual([]);
  });

  // 한계: 구현이 모듈 로드 시점에 promisify(fs.rm)처럼 원본 함수를 캡처하면 가드가 우회된다.
  //   IMPL 쪽 제약("node:fs 함수를 로드 시점에 캡처하지 않는다")으로 막고 테스트로는 확인하지 않는다

  it('T-FS-12 같은 키로 다시 put하면 새 내용으로 덮어쓴다', async () => {
    const next = Buffer.from([9, 8, 7]);
    await store.put('doc1/1/a.png', BYTES);

    await store.put('doc1/1/a.png', next);

    expect((await store.read('doc1/1/a.png'))?.equals(next)).toBe(true);
  });

  it('T-FS-13 빈 Buffer도 put 뒤 read하면 빈 Buffer다', async () => {
    await store.put('doc1/1/empty.bin', Buffer.alloc(0));

    const result = await store.read('doc1/1/empty.bin');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result?.length).toBe(0);
  });

  it('T-FS-8 deletePrefix("doc1/") 뒤 그 아래 파일이 없다', async () => {
    const deleted = ['doc1/1/a.png', 'doc1/2/b.png', 'doc1/2/sub/c.png'];
    const kept = ['doc10/1/a.png', 'doc2/1/a.png'];
    for (const key of [...deleted, ...kept]) {
      await store.put(key, BYTES);
    }

    await store.deletePrefix('doc1/');

    for (const key of deleted) {
      await expect(store.read(key)).resolves.toBeNull();
    }
    for (const key of kept) {
      expect((await store.read(key))?.equals(BYTES)).toBe(true);
    }
    await expect(listFiles(path.join(root, 'doc1'))).resolves.toEqual([]);
    // ★ 빈 폴더도 남기지 않는다(파일 목록이 비는 것만으로는 폴더가 남았는지 알 수 없다)
    await expect(exists(path.join(root, 'doc1'))).resolves.toBe(false);
    await expect(exists(path.join(root, 'doc10'))).resolves.toBe(true);
  });

  it('T-PR3-FS-1 폴더 접두사는 폴더째 지우고 하위 폴더 접두사는 그 폴더만 지운다', async () => {
    for (const key of ['doc1/3/a.png', 'doc1/3/sub/b.png', 'doc1/4/c.png']) {
      await store.put(key, BYTES);
    }

    await store.deletePrefix('doc1/3/');

    await expect(exists(path.join(root, 'doc1', '3'))).resolves.toBe(false);
    // ★ 같은 문서의 다른 버전 폴더와 문서 폴더는 남는다
    expect((await store.read('doc1/4/c.png'))?.equals(BYTES)).toBe(true);
    await expect(exists(path.join(root, 'doc1'))).resolves.toBe(true);

    await store.deletePrefix('doc1/');

    await expect(exists(path.join(root, 'doc1'))).resolves.toBe(false);
    await expect(store.read('doc1/4/c.png')).resolves.toBeNull();
  });

  it('T-PR3-FS-2 없는 폴더·파일을 폴더처럼 쓴 접두사는 예외 없이 끝나고 저장 위치 자체는 거부한다', async () => {
    await store.put('doc2/1/a.png', BYTES);

    await expect(store.deletePrefix('nope/')).resolves.toBeUndefined();
    await expect(store.deletePrefix('doc2/1/a.png/')).resolves.toBeUndefined();
    await expect(store.deletePrefix('doc2/1/a.png/x/')).resolves.toBeUndefined();
    // 파일은 그대로다
    expect((await store.read('doc2/1/a.png'))?.equals(BYTES)).toBe(true);

    // ★ 저장 위치 자체를 가리키는 접두사는 폴더째 지우는 분기보다 먼저 거부한다
    await expect(store.deletePrefix('./')).rejects.toBeInstanceOf(InvalidRequestError);
    expect((await store.read('doc2/1/a.png'))?.equals(BYTES)).toBe(true);
  });

  it('T-FS-9 문자열 접두사로 지운다', async () => {
    const keys = ['doc1/3/ph-1.png', 'doc1/3/ph-2.png', 'doc1/3/other.png', 'doc1/30/ph-1.png'];
    for (const key of keys) {
      await store.put(key, BYTES);
    }

    await store.deletePrefix('doc1/3/ph');

    await expect(store.read('doc1/3/ph-1.png')).resolves.toBeNull();
    await expect(store.read('doc1/3/ph-2.png')).resolves.toBeNull();
    expect((await store.read('doc1/3/other.png'))?.equals(BYTES)).toBe(true);
    expect((await store.read('doc1/30/ph-1.png'))?.equals(BYTES)).toBe(true);

    await store.deletePrefix('doc1/3');

    await expect(store.read('doc1/3/other.png')).resolves.toBeNull();
    await expect(store.read('doc1/30/ph-1.png')).resolves.toBeNull();
  });

  it.each(['./', './/'])(
    'T-FS-10 저장 위치 전체를 가리키는 접두사 %j는 거부한다',
    async (prefix) => {
      await store.put('doc1/1/a.png', BYTES);

      await expect(store.deletePrefix(prefix)).rejects.toBeInstanceOf(InvalidRequestError);

      expect((await store.read('doc1/1/a.png'))?.equals(BYTES)).toBe(true);
    },
  );

  describe('없는 접두사 삭제', () => {
    it('T-FS-11a 저장 위치가 아예 없어도 아무 일 없이 끝난다', async () => {
      await expect(store.deletePrefix('doc1/')).resolves.toBeUndefined();
    });

    it('T-FS-11b 일치하는 것이 없어도 다른 파일은 남는다', async () => {
      await store.put('doc2/1/a.png', BYTES);

      await expect(store.deletePrefix('doc1/')).resolves.toBeUndefined();
      await expect(store.deletePrefix('nope')).resolves.toBeUndefined();
      await expect(store.deletePrefix('doc2/1/a.png/x/')).resolves.toBeUndefined();

      expect((await store.read('doc2/1/a.png'))?.equals(BYTES)).toBe(true);
    });
  });
});
