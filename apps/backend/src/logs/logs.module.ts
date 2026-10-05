import { Module } from '@nestjs/common';
import { StorageModule } from '../storage';
import { LogsController } from './controllers/logs.controller';
import { LogsCrudService } from './services/logs-crud.service';
import { LogsService } from './services/logs.service';

/** 문서 기록 모듈이다. */
@Module({
  imports: [StorageModule],
  controllers: [LogsController],
  providers: [LogsService, LogsCrudService],
  exports: [LogsService],
})
export class LogsModule {}
