import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MongoClient } from 'mongodb';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../../common';
import { MONGO_CLIENT } from '../interfaces/storage.tokens';

/** MongoDB 연결 실패다. ★ 연결 문자열·호스트를 담지 않는다. */
export class MongoConnectError extends Error {
  constructor() {
    super('MongoDB에 연결할 수 없습니다');
    this.name = 'MongoConnectError';
  }
}

/** MONGODB_URI로 연결하고 ping이 성공한 MongoClient를 만든다. 실패하면 로그를 남기고 MongoConnectError를 던진다. */
export async function connectMongo(
  config: ConfigService<AppConfig, true>,
  logger: PinoLogger,
): Promise<MongoClient> {
  logger.setContext('StorageModule');
  // ★ 생성자 옵션을 주지 않는다. 드라이버는 생성자 옵션이 URI 옵션을 덮으므로 시간 제한은 URI로 준다
  const client = new MongoClient(config.get('MONGODB_URI', { infer: true }));
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return client;
  } catch (error) {
    // ★ 허용 필드는 errorName뿐. 연결 문자열·오류 메시지(호스트 포함)를 넣지 않는다
    logger.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'storage.mongo_connect_failed',
    );
    await client.close().catch(() => undefined);
    // ★ 원래 오류(메시지에 호스트·포트)를 던지지 않고 cause도 붙이지 않는다
    throw new MongoConnectError();
  }
}

/** 앱이 끝날 때 MongoDB 연결을 닫는다. */
@Injectable()
export class MongoClientCloser implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  /** 연결을 닫는다. */
  async onApplicationShutdown(): Promise<void> {
    // ★ onModuleDestroy가 아니다. 다른 모듈의 종료 훅이 DB를 쓸 수 있어 가장 늦은 훅에서 닫는다
    await this.client.close();
  }
}
