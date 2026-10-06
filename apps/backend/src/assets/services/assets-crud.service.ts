import { Inject, Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';
import { MONGO_DB } from '../../storage';
import { ASSETS_COLLECTION } from '../interfaces/assets.types';
import type { AssetRecord } from '../interfaces/assets.types';

/** 조회 결과에서 _id를 뺀다. */
const PROJECTION = { projection: { _id: 0 } } as const;

/** assets 컬렉션을 읽고 쓴다. ★ assets 모듈 내부 전용 */
@Injectable()
export class AssetsCrudService {
  private readonly assets: Collection<AssetRecord>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.assets = db.collection<AssetRecord>(ASSETS_COLLECTION);
  }

  /** 인덱스를 맞춘다. */
  async ensureIndexes(): Promise<void> {
    await this.assets.createIndex(
      { docId: 1, version: 1, placeholderId: 1 },
      { unique: true, name: 'assets_doc_version_placeholder' },
    );
  }

  /** 버전의 레코드를 통째로 바꾼다. */
  async replaceVersion(docId: string, version: string, records: AssetRecord[]): Promise<void> {
    await this.assets.deleteMany({ docId, version });
    if (records.length > 0) {
      // ★ 복사본을 넘긴다. 드라이버가 _id를 원본 객체에 붙인다
      await this.assets.insertMany(records.map((record) => ({ ...record })));
    }
  }

  /** 버전의 레코드를 order 순으로 읽는다. */
  findByVersion(docId: string, version: string): Promise<AssetRecord[]> {
    return this.assets.find({ docId, version }, PROJECTION).sort({ order: 1 }).toArray();
  }

  /** 요약·캡션이 대기 중인 레코드를 order 순으로 읽는다. */
  findPending(docId: string, version: string): Promise<AssetRecord[]> {
    return (
      this.assets
        // ★ tableId: null은 필드가 없는 옛 레코드도 맞춘다. 표 안 이미지는 요약·캡션 대상이 아니다
        .find({ docId, version, hintStatus: 'pending', tableId: null }, PROJECTION)
        .sort({ order: 1 })
        .toArray()
    );
  }

  /** 레코드 하나를 읽는다. */
  findOne(docId: string, version: string, placeholderId: string): Promise<AssetRecord | null> {
    return this.assets.findOne({ docId, version, placeholderId }, PROJECTION);
  }

  /** 복원에 쓸 레코드를 order 순으로 읽는다. ID 자신과 그 표 안 이미지를 함께 준다. */
  async findForRestore(
    docId: string,
    version: string,
    ids: readonly string[],
  ): Promise<AssetRecord[]> {
    if (ids.length === 0) return [];
    return this.assets
      .find(
        {
          docId,
          version,
          $or: [{ placeholderId: { $in: [...ids] } }, { tableId: { $in: [...ids] } }],
        },
        PROJECTION,
      )
      .sort({ order: 1 })
      .toArray();
  }

  /** 요약·캡션을 저장한다. */
  async saveHint(
    docId: string,
    version: string,
    placeholderId: string,
    hint: string,
    isTemporary: boolean,
  ): Promise<void> {
    await this.assets.updateOne(
      { docId, version, placeholderId },
      { $set: { hint, isTemporary, hintStatus: 'done' } },
    );
  }

  /** 임시 설명 레코드를 다시 대기로 돌린다. */
  async markTemporaryPending(docId: string, version: string): Promise<number> {
    const result = await this.assets.updateMany(
      {
        docId,
        version,
        isTemporary: true,
        tableId: null,
        $or: [{ kind: 'table' }, { fileKey: { $ne: null } }],
      },
      { $set: { hintStatus: 'pending' } },
    );
    return result.matchedCount;
  }

  /** 문서의 모든 레코드를 지운다. */
  async deleteByDoc(docId: string): Promise<void> {
    await this.assets.deleteMany({ docId });
  }
}
