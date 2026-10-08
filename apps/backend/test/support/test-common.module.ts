import type { Writable } from 'node:stream';
import { Global, Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../../src/common';

/** 테스트에서 storage 등 하위 모듈에 줄 설정 값이다. */
export type TestConfigValues = Partial<AppConfig>;

/** .env·process.env와 무관하게 ConfigService·PinoLogger를 전역으로 주는 테스트 모듈을 만든다. */
export function createTestCommonModule(values: TestConfigValues, stream: Writable): Type<unknown> {
  @Global()
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        // ★ 개발자 PC의 apps/backend/.env를 읽지 않는다
        ignoreEnvFile: true,
        // ★ ConfigService.get이 process.env로 내려가지 않는다
        skipProcessEnv: true,
        load: [() => ({ ...values })],
      }),
      LoggerModule.forRoot({ pinoHttp: [{ level: 'trace' }, stream] }),
    ],
    exports: [ConfigModule, LoggerModule],
  })
  class TestCommonModule {}
  return TestCommonModule;
}
