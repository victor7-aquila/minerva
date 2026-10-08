import * as path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BACKEND_ROOT, validateConfig } from './helpers/validate-config';

/** 공통 모듈이다. 설정을 전역으로 제공한다. */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 상대 경로 기준과 같은 apps/backend의 .env를 읽는다. 실제 환경 변수가 우선한다
      envFilePath: path.join(BACKEND_ROOT, '.env'),
      // ★ validate 옵션을 쓰지 않는다. validate는 import 시점에 실행돼 처리되지 않은 Promise 거부가 생긴다.
      //   load 팩토리는 DI 초기화 때 실행된다
      load: [() => validateConfig(process.env)],
    }),
  ],
  exports: [ConfigModule],
})
export class CommonModule {}
