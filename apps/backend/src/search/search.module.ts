import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets';
import { DocumentsModule } from '../documents';
import { RagModule } from '../rag';
import { SearchController } from './controllers/search.controller';
import { SearchService } from './services/search.service';

// ★ exports 없음 — 다른 모듈이 search를 쓰지 않는다
/** 검색 모듈이다. */
@Module({
  imports: [DocumentsModule, AssetsModule, RagModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
