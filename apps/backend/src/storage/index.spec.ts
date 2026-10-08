import * as barrel from './index';
import { FILE_STORE, MONGO_DB, StorageModule } from './index';
import type { FileStore } from './index';

describe('REQ-BE-9.1.1', () => {
  it('T-SURF-1 배럴의 값 export 이름이 공개 표면과 정확히 같다', () => {
    // ★ 내부 이름(LocalFileStore, MONGO_CLIENT, MongoConnectError 등)이 새면 실패한다
    expect(Object.keys(barrel).sort()).toEqual(['FILE_STORE', 'MONGO_DB', 'StorageModule']);
  });

  it('T-SURF-2 주입 토큰은 서로 다른 symbol이고 StorageModule은 Nest 모듈이다', () => {
    expect(typeof MONGO_DB).toBe('symbol');
    expect(typeof FILE_STORE).toBe('symbol');
    expect(MONGO_DB).not.toBe(FILE_STORE);
    expect(typeof StorageModule).toBe('function');

    const exported = Reflect.getMetadata('exports', StorageModule) as unknown[];
    expect(exported).toContain(MONGO_DB);
    expect(exported).toContain(FILE_STORE);
  });
});

describe('REQ-BE-9.1.2', () => {
  it('T-SURF-3 FileStore 시그니처가 명세와 같다', () => {
    const ok: FileStore = {
      put: async (_k: string, _d: Buffer) => undefined,
      read: async (_k: string) => null,
      deletePrefix: async (_p: string) => undefined,
    };

    // @ts-expect-error read는 Buffer | null을 돌려줘야 한다
    const badRead: FileStore = { ...ok, read: async (_k: string) => 'text' };
    // @ts-expect-error deletePrefix가 빠졌다
    const missing: FileStore = { put: ok.put, read: ok.read };
    // @ts-expect-error put의 data는 Buffer여야 한다
    const badPut: FileStore = { ...ok, put: async (_k: string, _d: string) => undefined };

    expect(typeof ok.read).toBe('function');
    expect([badRead, missing, badPut]).toHaveLength(3);
  });
});
