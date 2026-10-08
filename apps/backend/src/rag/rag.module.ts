import { Module } from '@nestjs/common';
import { RagClient } from './services/rag-client';

/** RAG Server 클라이언트 모듈이다. */
@Module({
  providers: [RagClient],
  exports: [RagClient],
})
export class RagModule {}
