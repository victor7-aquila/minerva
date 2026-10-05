import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Page } from '../../../libs/utils';
import { ListLogsQueryDto } from '../interfaces/list-logs-query.dto';
import { LogsService } from '../services/logs.service';
import type { LogEntry } from '../interfaces/logs.types';

/** 문서 기록 조회 API다. */
@Controller('v1/logs')
export class LogsController {
  constructor(@Inject(LogsService) private readonly logs: LogsService) {}

  /** 기록을 페이지로 준다. */
  @Get()
  list(@Query() query: ListLogsQueryDto): Promise<Page<LogEntry>> {
    return this.logs.list(query);
  }
}
