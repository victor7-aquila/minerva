import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets';
import { IndexingModule } from '../indexing';
import { LogsModule } from '../logs';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import { DocumentClock } from './services/document-clock';
import { DocumentLifecycle } from './services/document-lifecycle.service';
import { DocumentTasks } from './services/document-tasks';
import { DocumentsController } from './controllers/documents.controller';
import { DocumentsCrudService } from './services/documents-crud.service';
import { DocumentsScheduler } from './services/documents.scheduler';
import { DocumentsService } from './services/documents.service';

/** 문서 모듈이다. */
@Module({
  // ★ EventEmitterModule·ScheduleModule.forRoot()는 AppModule이 한 번 가져온다. 여기서 부르지 않는다
  imports: [StorageModule, RagModule, LogsModule, AssetsModule, IndexingModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentLifecycle,
    DocumentsScheduler,
    DocumentsCrudService,
    DocumentTasks,
    DocumentClock,
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
