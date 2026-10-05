import { Inject, Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import { MONGO_DB } from '../../storage';
import { RAG_EVENT_CURSORS_COLLECTION } from '../interfaces/indexing.types';
import type { RagEventCursorRecord } from '../interfaces/indexing.types';

/** 중복 키 오류 코드다. */
const DUPLICATE_KEY = 11000;

/** 조회 결과에서 _id를 뺀다. */
const PROJECTION = { projection: { _id: 0 } } as const;

/** 고유 키 충돌 오류인지 본다. ★ instanceof MongoServerError를 쓰지 않는다 (Jest 교차 realm, 가짜 Db) */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/** 알림 순번 저장소다. */
@Injectable()
export class IndexingCrudService {
  private readonly cursors: Collection<RagEventCursorRecord>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.cursors = db.collection<RagEventCursorRecord>(RAG_EVENT_CURSORS_COLLECTION);
  }

  /** 인덱스를 맞춘다. */
  async ensureIndexes(): Promise<void> {
    await this.cursors.createIndex(
      { docId: 1 },
      { unique: true, name: 'rag_event_cursors_doc_id' },
    );
  }

  /** 문서의 마지막 반영 순번을 읽는다. 없으면 null이다. */
  async getLastSequence(docId: string): Promise<number | null> {
    const found = await this.cursors.findOne({ docId }, PROJECTION);
    return found === null ? null : found.lastSequence;
  }

  /** 순번이 마지막 반영 순번보다 크면 올리고 참을 돌려준다. 아니면 거짓이다. */
  async advance(docId: string, sequence: number): Promise<boolean> {
    // ① 있는 문서를 조건부로 올린다
    if (await this.raise(docId, sequence)) return true;
    // ② 없으면 만든다
    try {
      // ★ 새 객체를 넘긴다. 드라이버가 _id를 붙인다
      await this.cursors.insertOne({ docId, lastSequence: sequence });
      return true;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    // ③ ★ 동시에 다른 알림이 먼저 만들었다. 문서가 생겼으므로 조건부 갱신 한 번으로 결정된다
    return this.raise(docId, sequence);
  }

  /** lastSequence < sequence인 문서를 sequence로 올린다. 올렸으면 참이다. */
  private async raise(docId: string, sequence: number): Promise<boolean> {
    const result = await this.cursors.updateOne(
      { docId, lastSequence: { $lt: sequence } },
      { $set: { lastSequence: sequence } },
    );
    return result.matchedCount === 1;
  }
}
