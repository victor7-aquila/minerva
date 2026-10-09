import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import { Global, Module } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Db } from 'mongodb';
import { LoggerModule } from 'nestjs-pino';
import { AppModule } from '../../src/api';
// ★ DocumentsScheduler는 배럴에 없는 내부 파일이다. 테스트 전용 예외로 직접 import한다(runScheduledIndex 용)
import { DocumentsScheduler } from '../../src/documents/services/documents.scheduler';
import { CommonModule, createLoggerParams } from '../../src/common';
import type { AppConfig } from '../../src/common';
// ★ 배럴에 없는 내부 파일이다. 테스트 전용 예외로 직접 import한다
import { validateConfig } from '../../src/common/helpers/validate-config';
import { MONGO_DB } from '../../src/storage';
import { buildFullTestEnv } from './test-env';

/** 실제 AppModule을 올린 e2e 앱이다. */
export interface AppHarness {
  app: INestApplication;
  port: number;
  db: Db;
  close(): Promise<void>;
}

/**
 * CommonModule 대신 쓸 모듈을 만든다. 설정과 로거를 함께 전역으로 준다.
 * 실제 validateConfig·createLoggerParams를 쓰되 .env·process.env를 읽지 않고 로그를 stream으로 보낸다.
 */
export function createAppTestCommonModule(
  env: Record<string, string>,
  stream: Writable,
): Type<unknown> {
  @Global()
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        // ★ 개발자 PC의 apps/backend/.env와 process.env를 읽지 않는다
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => validateConfig(env)],
      }),
      LoggerModule.forRoot(createLoggerParams(stream)),
    ],
    exports: [ConfigModule, LoggerModule],
  })
  class AppTestCommonModule {}
  return AppTestCommonModule;
}

/** AppModule에 테스트 전용 컨트롤러를 더해 띄우고 127.0.0.1 빈 포트에서 듣는다. */
export async function bootAppHarness(options: {
  /** buildFullTestEnv에 덮어쓸 값이다 */
  env: Partial<Record<keyof AppConfig, string>>;
  stream: Writable;
  controllers?: Type<unknown>[];
}): Promise<AppHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideModule(CommonModule)
    .useModule(createAppTestCommonModule(buildFullTestEnv(options.env), options.stream))
    .compile();
  const app = moduleRef.createNestApplication();
  try {
    // ★ listen이 init(logs 인덱스 준비)을 함께 한다
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const db = app.get<Db>(MONGO_DB);
    return {
      app,
      port,
      db,
      close: async () => {
        await app.close();
      },
    };
  } catch (error) {
    // ★ 기동 중 실패해도 듣는 서버를 남기지 않는다(Jest 열린 핸들 방지)
    await app.close();
    throw error;
  }
}

/** 예약 색인을 한 번 돌린다(일정을 기다리지 않는다). 앞 실행이 끝나지 않았으면 바로 끝난다. */
export async function runScheduledIndex(harness: AppHarness): Promise<void> {
  await harness.app.get(DocumentsScheduler).runScheduledIndex();
}
