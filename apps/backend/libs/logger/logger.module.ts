import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { createLoggerParams } from './helpers/logger-options';

/** 로거 모듈이다. 금지 키를 지우는 nestjs-pino 로거를 전역으로 제공한다. */
@Global()
@Module({
  imports: [LoggerModule.forRoot(createLoggerParams())],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
