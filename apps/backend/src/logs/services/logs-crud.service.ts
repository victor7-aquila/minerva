import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Collection, Db, Filter, Sort } from 'mongodb';
import { parseKstDayRange } from '../../common';
import type { AppConfig } from '../../common';
import { MONGO_DB } from '../../storage';
import type { ListLogsQueryDto } from '../interfaces/list-logs-query.dto';
import { LOGS_COLLECTION } from '../interfaces/logs.types';
import type { LogRecord, LogSortColumn } from '../interfaces/logs.types';

/** 하루의 초다. */
const DAY_SECONDS = 86_400;
/** TTL 인덱스 키다. */
const TTL_KEY = { occurredAt: 1 } as const;
/** MongoDB NamespaceNotFound 오류 코드다. */
const NAMESPACE_NOT_FOUND = 26;

/** 키가 정확히 { occurredAt: 1 }인지 본다. 드라이버가 숫자 타입을 바꿀 수 있어 Number로 맞춘다. */
function isTtlKey(key: Record<string, unknown>): boolean {
  const names = Object.keys(key);
  return names.length === 1 && names[0] === 'occurredAt' && Number(key.occurredAt) === 1;
}

/** NamespaceNotFound 오류인지 code 필드로 판별한다. ★ instanceof를 쓰지 않는다 */
function isMissingNamespace(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === NAMESPACE_NOT_FOUND
  );
}

/** 요청 조건으로 거르기 조건을 만든다. 조건은 모두 함께 만족해야 한다. */
function buildFilter(query: ListLogsQueryDto): Filter<LogRecord> {
  const filter: Filter<LogRecord> = {};
  if (query.kind !== undefined) filter.kind = { $in: query.kind };
  if (query.outcome !== undefined) filter.outcome = query.outcome;
  // ★ 없는 날짜면 parseKstDayRange가 던지는 InvalidRequestError를 잡지 않고 올린다
  const range: { $gte?: Date; $lt?: Date } = {};
  if (query.from !== undefined) range.$gte = parseKstDayRange(query.from).start;
  if (query.to !== undefined) range.$lt = parseKstDayRange(query.to).end;
  if (range.$gte !== undefined || range.$lt !== undefined) filter.occurredAt = range;
  if (query.name !== undefined) filter.name = query.name;
  if (query.doc_id !== undefined) filter.docId = query.doc_id;
  return filter;
}

/** 정렬 열로 정렬 조건을 만든다. 같은 값은 시각·삽입 순서로 순서를 고정한다. */
function buildSort(column: LogSortColumn, dir: 1 | -1): Sort {
  switch (column) {
    case 'kind':
      return { kind: dir, occurredAt: -1, _id: -1 };
    case 'outcome':
      return { outcome: dir, occurredAt: -1, _id: -1 };
    case 'occurred_at':
      return { occurredAt: dir, _id: dir };
  }
}

/** logs 컬렉션의 MongoDB 접근을 전담한다. */
@Injectable()
export class LogsCrudService {
  private readonly logs: Collection<LogRecord>;
  private readonly retentionDays: number;

  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    // ★ collection()은 생성자에서 한 번만 부른다
    this.logs = db.collection<LogRecord>(LOGS_COLLECTION);
    this.retentionDays = config.get('LOG_RETENTION_DAYS', { infer: true });
  }

  /** 기록 하나를 저장한다. */
  async insert(record: LogRecord): Promise<void> {
    await this.logs.insertOne(record);
  }

  /** 요청 조건에 맞는 기록의 한 페이지와 전체 건수를 돌려준다. */
  async findPage(query: ListLogsQueryDto): Promise<{ items: LogRecord[]; total: number }> {
    const filter = buildFilter(query);
    const page = query.page ?? 1;
    const size = query.page_size ?? 20;
    const dir = query.order === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      this.logs
        .find(filter)
        .sort(buildSort(query.sort ?? 'occurred_at', dir))
        .skip((page - 1) * size)
        .limit(size)
        .toArray(),
      this.logs.countDocuments(filter),
    ]);
    return { items, total };
  }

  /** 주어진 문서 ID 중 삭제 기록이 있는 문서 ID 집합을 돌려준다. */
  async findDeletedDocIds(docIds: string[]): Promise<Set<string>> {
    if (docIds.length === 0) return new Set();
    const deleted = await this.logs.distinct('docId', { kind: 'delete', docId: { $in: docIds } });
    return new Set(deleted);
  }

  /** logs 컬렉션의 고유 인덱스와 TTL 인덱스를 설정한 보관 일수에 맞춘다. */
  async ensureIndexes(): Promise<void> {
    const logs = this.db.collection(LOGS_COLLECTION);
    const seconds = this.retentionDays * DAY_SECONDS;

    // ★ 컬렉션이 없으면 이 호출이 만든다
    await logs.createIndex({ logId: 1 }, { name: 'logId_unique', unique: true });

    let indexes: Awaited<ReturnType<ReturnType<typeof logs.listIndexes>['toArray']>> = [];
    try {
      indexes = await logs.listIndexes().toArray();
    } catch (error) {
      if (!isMissingNamespace(error)) throw error;
    }

    const ttl = indexes.find((index) => isTtlKey(index.key));
    if (ttl === undefined) {
      await logs.createIndex(TTL_KEY, { name: 'occurredAt_ttl', expireAfterSeconds: seconds });
    } else if (ttl.expireAfterSeconds !== seconds) {
      await this.db.command({
        collMod: LOGS_COLLECTION,
        index: { keyPattern: TTL_KEY, expireAfterSeconds: seconds },
      });
    }
    // ★ 오류는 잡지 않는다. 보관 기간을 못 맞추면 기동이 실패한다
  }
}
