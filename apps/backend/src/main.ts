import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './api';
import type { AppConfig } from './common';

/** 앱을 만들고 PORT에서 듣는다. */
async function bootstrap(): Promise<void> {
  // ★ bufferLogs: 로거가 붙기 전 기동 로그를 모았다가 pino로 내보낸다
  // ★ abortOnError: false — 기본값은 기동 실패 때 process.abort()로 끝난다. 오류를 다시 던져 종료 코드 1로 끝낸다
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  app.useLogger(app.get(Logger));
  // ★ SIGTERM·SIGINT에도 onApplicationShutdown(MongoDB 연결 닫기 등)이 돌게 한다
  app.enableShutdownHooks();
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}

bootstrap().catch((error: unknown) => {
  // ★ 기동 실패. 다시 던져 종료 코드 1로 끝낸다
  process.exitCode = 1;
  throw error;
});
