import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { IndexingService } from '../services/indexing.service';
import { RagEventDto, toNotification } from '../interfaces/rag-event.dto';
import { RagEventsTokenGuard } from '../guards/rag-events-token.guard';

/** RAG Server 작업 상태 알림을 받는다(API.md POST /v1/internal/rag-events). */
@Controller('v1/internal/rag-events')
@UseGuards(RagEventsTokenGuard)
export class RagEventsController {
  constructor(@Inject(IndexingService) private readonly indexing: IndexingService) {}

  /** 알림을 받아 반영하고 204로 응답한다. */
  @Post()
  @HttpCode(204)
  async receive(@Body() body: RagEventDto): Promise<void> {
    await this.indexing.handleNotification(toNotification(body));
  }
}
