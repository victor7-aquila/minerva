import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toIsoUtc, toPage } from '../../../libs/utils';
import type { Page } from '../../../libs/utils';
import type { ListLogsQueryDto } from '../interfaces/list-logs-query.dto';
import { describeLog } from '../helpers/log-description';
import type { LogEntry, LogInput, LogRecord } from '../interfaces/logs.types';
import { LogsCrudService } from './logs-crud.service';

/** 오류 객체의 name 문자열을 돌려준다. 없으면 UnknownError다. ★ instanceof를 쓰지 않는다 */
function errorNameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'UnknownError';
}

/** 저장한 기록을 응답 형식으로 바꾼다. */
function toLogEntry(record: LogRecord, documentDeleted: boolean): LogEntry {
  return {
    log_id: record.logId,
    occurred_at: toIsoUtc(record.occurredAt),
    kind: record.kind,
    document: {
      doc_id: record.docId,
      name: record.name,
      edition_label: record.editionLabel ?? null,
    },
    document_deleted: documentDeleted,
    outcome: record.outcome,
    description: record.description,
  };
}

/** 문서 기록을 남긴다. */
@Injectable()
export class LogsService implements OnModuleInit {
  constructor(
    @Inject(LogsCrudService) private readonly crud: LogsCrudService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('LogsService');
  }

  /** 문서 기록을 하나 남긴다. 저장이 실패해도 예외를 내지 않는다. */
  async record(input: LogInput): Promise<void> {
    try {
      // ★ 필드를 하나씩 옮긴다. detail이나 타입 밖의 키가 저장되지 않게 한다
      const doc: LogRecord = {
        logId: randomUUID(),
        occurredAt: new Date(),
        kind: input.kind,
        docId: input.docId,
        name: input.name,
        editionLabel: input.editionLabel,
        outcome: input.outcome,
        description: describeLog(input),
      };
      await this.crud.insert(doc);
    } catch (error) {
      // ★ 오류 메시지·문서 이름·판 표기·설명은 로그에 넣지 않는다
      this.logger.warn(
        { kind: input.kind, docId: input.docId, errorName: errorNameOf(error) },
        'logs.record_failed',
      );
    }
  }

  /** 기록을 거르고 정렬해 페이지로 준다. ★ logs 컨트롤러 전용 */
  async list(query: ListLogsQueryDto): Promise<Page<LogEntry>> {
    const { items, total } = await this.crud.findPage(query);
    const deleted = await this.crud.findDeletedDocIds([
      ...new Set(items.map((item) => item.docId)),
    ]);
    return toPage(
      items.map((record) => toLogEntry(record, deleted.has(record.docId))),
      total,
      query,
    );
  }

  /** 기동할 때 logs 컬렉션의 인덱스를 맞춘다. */
  async onModuleInit(): Promise<void> {
    await this.crud.ensureIndexes();
  }
}
