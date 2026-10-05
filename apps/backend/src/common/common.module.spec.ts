import * as path from 'node:path';
import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CommonModule } from './common.module';
import type { AppConfig } from './interfaces/app-config';

/** 필수 키만 채운 최소 환경 */
const REQUIRED_ENV = {
  MONGODB_URI: 'mongodb://localhost:27017/minerva',
  RAG_SERVER_URL: 'http://localhost:8000',
  RAG_SERVER_API_TOKEN: 'rag-api-token-SENTINEL',
  RAG_EVENTS_TOKEN: 'rag-events-token-SENTINEL',
};

const originalEnv = process.env;
let moduleRef: TestingModule | undefined;

// ★ 환경 변수를 통째로 바꾼다. 병합하면 개발자 PC의 .env 값이 섞여 결과가 달라진다
beforeEach(() => {
  moduleRef = undefined;
});

afterEach(async () => {
  process.env = originalEnv;
  await moduleRef?.close();
});

/** CommonModule을 import하지 않고 ConfigService를 주입받는 소비자다. */
@Injectable()
class ConsumerService {
  constructor(@Inject(ConfigService) readonly config: ConfigService<AppConfig, true>) {}
}

// ★ CommonModule을 import하지 않는다. 전역(@Global + exports)이어야만 주입된다
@Module({ providers: [ConsumerService] })
class ConsumerModule {}

/** 환경을 통째로 바꾸고 CommonModule을 올린다. */
async function boot(env: Record<string, string>, withConsumer = false): Promise<TestingModule> {
  process.env = { NODE_ENV: 'test', ...env };
  moduleRef = await Test.createTestingModule({
    imports: withConsumer ? [CommonModule, ConsumerModule] : [CommonModule],
  }).compile();
  return moduleRef;
}

describe('REQ-BE-8.1.1', () => {
  it('T-MOD-1 환경 변수 없이 기본값이 ConfigService로 읽힌다', async () => {
    const ref = await boot({ ...REQUIRED_ENV });
    const config = ref.get<ConfigService<AppConfig, true>>(ConfigService);

    expect(config.get('PORT', { infer: true })).toBe(3000);
    expect(config.get('CHUNKING_MODE', { infer: true })).toBe('semantic');
    expect(config.get('RAG_SERVER_URL', { infer: true })).toBe(REQUIRED_ENV.RAG_SERVER_URL);
    expect(config.get('LOG_RETENTION_DAYS', { infer: true })).toBe(90);
    expect(path.isAbsolute(config.get('FILE_STORAGE_DIR', { infer: true }))).toBe(true);
  });

  it('T-MOD-7 환경 변수로 준 값이 기본값 대신 ConfigService로 읽힌다', async () => {
    const ref = await boot({
      ...REQUIRED_ENV,
      PORT: '4321',
      CHUNKING_MODE: 'rule',
      LOG_RETENTION_DAYS: '30',
    });
    const config = ref.get<ConfigService<AppConfig, true>>(ConfigService);

    expect(config.get('PORT', { infer: true })).toBe(4321);
    expect(config.get('CHUNKING_MODE', { infer: true })).toBe('rule');
    expect(config.get('LOG_RETENTION_DAYS', { infer: true })).toBe(30);
  });

  it('T-MOD-5 CommonModule을 import하지 않은 모듈도 ConfigService를 주입받는다(전역)', async () => {
    const ref = await boot({ ...REQUIRED_ENV, PORT: '4321' }, true);
    const consumer = ref.get(ConsumerService, { strict: false });

    expect(consumer.config).toBeInstanceOf(ConfigService);
    expect(consumer.config.get('PORT', { infer: true })).toBe(4321);
  });

  it('T-MOD-2 필수 키가 빠지면 기동에 실패하고 이유에 값이 없다', async () => {
    const env: Record<string, string> = { ...REQUIRED_ENV };
    delete env.RAG_EVENTS_TOKEN;

    const error: unknown = await boot(env).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('RAG_EVENTS_TOKEN');
    expect(message).not.toContain('rag-api-token-SENTINEL');
    expect(message).not.toContain('mongodb://localhost:27017/minerva');
  });

  it('T-MOD-3 제약 위반이면 기동에 실패한다', async () => {
    const error: unknown = await boot({ ...REQUIRED_ENV, PORT: '70000-SENTINEL' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('PORT');
    expect(message).not.toContain('SENTINEL');
  });
});
