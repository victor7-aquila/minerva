import { Inject, Injectable, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { AppLoggerModule } from './logger.module';

let moduleRef: TestingModule | undefined;

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
});

/** AppLoggerModule을 import하지 않고 PinoLogger를 주입받는 소비자다. */
@Injectable()
class ConsumerService {
  constructor(@Inject(PinoLogger) readonly logger: PinoLogger) {}
}

// ★ AppLoggerModule을 import하지 않는다. 전역(@Global + exports)이어야만 주입된다
@Module({ providers: [ConsumerService] })
class ConsumerModule {}

describe('REQ-BE-8.2.1', () => {
  it('T-MOD-4 전역 로거를 제공한다', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppLoggerModule] }).compile();
    expect(await moduleRef.resolve(PinoLogger)).toBeInstanceOf(PinoLogger);
  });

  it('T-MOD-6 AppLoggerModule을 import하지 않은 모듈도 PinoLogger를 주입받는다(전역)', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppLoggerModule, ConsumerModule],
    }).compile();
    const consumer = moduleRef.get(ConsumerService, { strict: false });

    expect(consumer.logger).toBeInstanceOf(PinoLogger);
  });
});
