import { Inject, Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import { MONGO_DB } from '../../storage';
import {
  EVALUATION_RECORDS_COLLECTION,
  GOLDEN_SETS_COLLECTION,
} from '../interfaces/evaluation.types';
import type {
  EvaluationRecord,
  GoldenSetRecord,
  RecordFinish,
} from '../interfaces/evaluation.types';

/** 조회에서 _id를 뺀다. */
const PROJECTION = { projection: { _id: 0 } } as const;

/** 평가 기록을 새 객체로 복사한다. 드라이버가 넘긴 객체에 _id를 붙이므로 원본을 넘기지 않는다. */
function copyRecord(record: EvaluationRecord): EvaluationRecord {
  return {
    recordId: record.recordId,
    goldenSetId: record.goldenSetId,
    outcome: record.outcome,
    n: record.n,
    base: record.base === null ? null : { ...record.base },
    expanded: record.expanded === null ? null : { ...record.expanded },
    errorMessage: record.errorMessage,
    startedAt: record.startedAt,
    evaluatedAt: record.evaluatedAt,
  };
}

/** MongoDB golden_sets·evaluation_records 접근 한 곳이다. */
@Injectable()
export class EvaluationCrudService {
  private readonly goldenSets: Collection<GoldenSetRecord>;
  private readonly records: Collection<EvaluationRecord>;

  constructor(@Inject(MONGO_DB) db: Db) {
    // ★ collection()은 생성자에서 한 번만 부른다
    this.goldenSets = db.collection<GoldenSetRecord>(GOLDEN_SETS_COLLECTION);
    this.records = db.collection<EvaluationRecord>(EVALUATION_RECORDS_COLLECTION);
  }

  /** 인덱스를 만든다. */
  async ensureIndexes(): Promise<void> {
    await this.goldenSets.createIndex(
      { goldenSetId: 1 },
      { unique: true, name: 'golden_sets_golden_set_id' },
    );
    await this.records.createIndex(
      { recordId: 1 },
      { unique: true, name: 'evaluation_records_record_id' },
    );
    await this.records.createIndex(
      { goldenSetId: 1, startedAt: -1 },
      { name: 'evaluation_records_golden_set_started' },
    );
    await this.records.createIndex({ outcome: 1 }, { name: 'evaluation_records_outcome' });
  }

  /** 골든셋을 넣는다. */
  async insertGoldenSet(record: GoldenSetRecord): Promise<void> {
    // ★ 필드를 골라 새 객체로 넘긴다
    await this.goldenSets.insertOne({
      goldenSetId: record.goldenSetId,
      query: record.query,
      docId: record.docId,
      answerSpan: record.answerSpan,
      editionOnly: record.editionOnly,
      createdAt: record.createdAt,
    });
  }

  /** 골든셋 하나를 찾는다. 없으면 null이다. */
  findGoldenSet(goldenSetId: string): Promise<GoldenSetRecord | null> {
    return this.goldenSets.findOne({ goldenSetId }, PROJECTION);
  }

  /** 골든셋 전체를 준다. */
  findAllGoldenSets(): Promise<GoldenSetRecord[]> {
    return this.goldenSets.find({}, PROJECTION).sort({ createdAt: -1 }).toArray();
  }

  /** 골든셋을 지운다. 지웠으면 true다. */
  async deleteGoldenSet(goldenSetId: string): Promise<boolean> {
    const result = await this.goldenSets.deleteMany({ goldenSetId });
    return result.deletedCount > 0;
  }

  /** 평가 기록 하나를 넣는다. */
  async insertRecord(record: EvaluationRecord): Promise<void> {
    await this.records.insertOne(copyRecord(record));
  }

  /** 평가 기록 여럿을 넣는다. 빈 배열이면 DB를 부르지 않는다. */
  async insertRecords(records: readonly EvaluationRecord[]): Promise<void> {
    // ★ 실제 드라이버는 빈 배열 insertMany에서 오류를 던진다
    if (records.length === 0) return;
    await this.records.insertMany(records.map(copyRecord));
  }

  /** 기록이 아직 평가 중으로 있는지 본다. */
  async isEvaluating(recordId: string): Promise<boolean> {
    const found = await this.records.findOne({ recordId, outcome: 'evaluating' }, PROJECTION);
    return found !== null;
  }

  /** 골든셋들의 기록을 시작 늦은 순으로 준다. 빈 배열이면 DB를 부르지 않는다. */
  findRecordsOf(goldenSetIds: readonly string[]): Promise<EvaluationRecord[]> {
    if (goldenSetIds.length === 0) return Promise.resolve([]);
    return this.records
      .find({ goldenSetId: { $in: [...goldenSetIds] } }, PROJECTION)
      .sort({ startedAt: -1 })
      .toArray();
  }

  /** 평가 중인 기록을 끝낸다. 평가 중이 아니거나 없으면 false다. */
  async finishRecord(recordId: string, finish: RecordFinish): Promise<boolean> {
    // ★ 조건부라 한 번만 바뀌고, 지운 기록을 되살리지 않는다
    const result = await this.records.updateOne(
      { recordId, outcome: 'evaluating' },
      {
        $set: {
          outcome: finish.outcome,
          n: finish.n,
          base: finish.base,
          expanded: finish.expanded,
          errorMessage: finish.errorMessage,
          evaluatedAt: finish.evaluatedAt,
        },
      },
    );
    return result.matchedCount > 0;
  }

  /** 골든셋의 기록을 모두 지우고 지운 건수를 준다. */
  async deleteRecordsOf(goldenSetId: string): Promise<number> {
    const result = await this.records.deleteMany({ goldenSetId });
    return result.deletedCount;
  }

  /** 평가 중인 기록을 모두 평가 실패로 바꾸고 바꾼 건수를 준다. */
  async failEvaluating(errorMessage: string, at: Date): Promise<number> {
    const result = await this.records.updateMany(
      { outcome: 'evaluating' },
      { $set: { outcome: 'error', errorMessage, evaluatedAt: at } },
    );
    return result.modifiedCount;
  }
}
