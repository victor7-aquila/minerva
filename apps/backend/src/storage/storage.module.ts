import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Db, MongoClient } from 'mongodb';
import { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../common';
import { LocalFileStore } from './services/local-file-store';
import { MongoClientCloser, connectMongo } from './services/mongo-connection';
import { FILE_STORE, MONGO_CLIENT, MONGO_DB } from './interfaces/storage.tokens';

/** 저장소 모듈이다. MongoDB 연결과 로컬 파일 저장소를 제공한다. */
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      // ★ ConfigService는 CommonModule(@Global), PinoLogger는 AppLoggerModule(@Global)이 준다. storage는 둘 다 import하지 않는다
      inject: [ConfigService, PinoLogger],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        logger: PinoLogger,
      ): Promise<MongoClient> => connectMongo(config, logger),
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT],
      useFactory: (client: MongoClient): Db => client.db(),
    },
    { provide: FILE_STORE, useClass: LocalFileStore },
    MongoClientCloser,
  ],
  exports: [MONGO_DB, FILE_STORE],
})
export class StorageModule {}
