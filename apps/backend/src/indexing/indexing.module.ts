import { Module } from '@nestjs/common';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import { IndexingService } from './services/indexing.service';
import { IndexingCrudService } from './services/indexing-crud.service';
import { RagEventsController } from './controllers/rag-events.controller';

/** 색인 연동 모듈이다. */
@Module({
  // ★ EventEmitterModule.forRoot()는 AppModule이 한 번 가져온다. 여기서 부르지 않는다
  imports: [StorageModule, RagModule],
  controllers: [RagEventsController],
  providers: [IndexingService, IndexingCrudService],
  exports: [IndexingService],
})
export class IndexingModule {}
