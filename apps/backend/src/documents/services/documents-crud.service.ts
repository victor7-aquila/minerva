import { Inject, Injectable } from '@nestjs/common';
import type { Collection, Db, Filter } from 'mongodb';
import type { ProcessingState, SearchState } from '../../common';
import { MONGO_DB } from '../../storage';
import { DOCUMENT_VERSIONS_COLLECTION, DOCUMENTS_COLLECTION } from '../interfaces/documents.types';
import type { DocumentRecord, DocumentVersionRecord } from '../interfaces/documents.types';

/** 조회 결과에서 _id를 뺀다. */
const PROJECTION = { projection: { _id: 0 } } as const;

/** 목록 MongoDB 조건이다. */
export interface ListCriteria {
  searchStates?: SearchState[];
  processingStates?: ProcessingState[];
  name?: string;
  hasEdition?: boolean;
  uploadedFrom?: Date;
  uploadedTo?: Date;
}
/** 문서 갱신 조건이다. */
export type DocumentFilter = Filter<DocumentRecord>;

/** MongoDB documents·document_versions 접근 한 곳이다. */
@Injectable()
export class DocumentsCrudService {
  private readonly documents: Collection<DocumentRecord>;
  private readonly versions: Collection<DocumentVersionRecord>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.documents = db.collection<DocumentRecord>(DOCUMENTS_COLLECTION);
    this.versions = db.collection<DocumentVersionRecord>(DOCUMENT_VERSIONS_COLLECTION);
  }

  /** 인덱스를 만든다. */
  async ensureIndexes(): Promise<void> {
    await this.documents.createIndex({ docId: 1 }, { unique: true, name: 'documents_doc_id' });
    await this.documents.createIndex({ name: 1 }, { name: 'documents_name' });
    await this.versions.createIndex(
      { docId: 1, version: 1 },
      { unique: true, name: 'document_versions_doc_version' },
    );
  }

  /** 문서를 넣는다. */
  async insertDocument(record: DocumentRecord): Promise<void> {
    await this.documents.insertOne({
      docId: record.docId,
      name: record.name,
      edition: record.edition === null ? null : { ...record.edition },
      editionEnteredAt: record.editionEnteredAt,
      searchState: record.searchState,
      processingState: record.processingState,
      latestVersion: record.latestVersion,
      searchableVersion: record.searchableVersion,
      deleted: record.deleted,
      pendingRag: { ...record.pendingRag },
      purged: record.purged,
      uploadedAt: record.uploadedAt,
      updatedAt: record.updatedAt,
    });
  }

  /** 버전을 넣는다. */
  async insertVersion(record: DocumentVersionRecord): Promise<void> {
    await this.versions.insertOne(copyVersion(record));
  }

  /** 같은 번호의 버전을 지우고 새로 넣는다. */
  async replaceVersion(record: DocumentVersionRecord): Promise<void> {
    // ★ 앞선 실패가 남긴 같은 번호의 찌꺼기를 지운다 (D4)
    await this.versions.deleteMany({ docId: record.docId, version: record.version });
    await this.versions.insertOne(copyVersion(record));
  }

  /** 문서 하나를 읽는다. */
  findDocument(docId: string): Promise<DocumentRecord | null> {
    return this.documents.findOne({ docId }, PROJECTION);
  }

  /** 버전 하나를 읽는다. */
  findVersion(docId: string, version: string): Promise<DocumentVersionRecord | null> {
    return this.versions.findOne({ docId, version }, PROJECTION);
  }

  /** 여러 문서의 버전을 읽는다. */
  async findVersionsOf(docIds: readonly string[]): Promise<DocumentVersionRecord[]> {
    if (docIds.length === 0) return [];
    return this.versions.find({ docId: { $in: [...docIds] } }, PROJECTION).toArray();
  }

  /** 목록 후보를 읽는다. */
  findListCandidates(criteria: ListCriteria): Promise<DocumentRecord[]> {
    const filter: Record<string, unknown> = { deleted: false };
    if (criteria.searchStates) filter.searchState = { $in: [...criteria.searchStates] };
    if (criteria.processingStates) filter.processingState = { $in: [...criteria.processingStates] };
    if (criteria.name !== undefined) filter.name = criteria.name;
    if (criteria.hasEdition === true) filter.edition = { $ne: null };
    if (criteria.hasEdition === false) filter.edition = null;
    if (criteria.uploadedFrom !== undefined || criteria.uploadedTo !== undefined) {
      filter.uploadedAt = {
        ...(criteria.uploadedFrom !== undefined ? { $gte: criteria.uploadedFrom } : {}),
        ...(criteria.uploadedTo !== undefined ? { $lt: criteria.uploadedTo } : {}),
      };
    }
    return this.documents.find(filter as Filter<DocumentRecord>, PROJECTION).toArray();
  }

  /** 판이 있는 검색 가능 문서를 읽는다. */
  findSearchableWithEdition(name?: string): Promise<DocumentRecord[]> {
    const filter: Record<string, unknown> = {
      deleted: false,
      searchState: 'searchable',
      edition: { $ne: null },
    };
    if (name !== undefined) filter.name = name;
    return this.documents.find(filter as Filter<DocumentRecord>, PROJECTION).toArray();
  }

  /** 같은 판 문서를 읽는다. */
  findSameEdition(
    name: string,
    label: string | null,
    excludeDocId: string | null,
  ): Promise<DocumentRecord[]> {
    const filter: Record<string, unknown> = {
      deleted: false,
      searchState: { $ne: 'replaced' },
      name,
    };
    // ★ 점 경로 필터는 Filter 타입에 맞지 않아 Record로 만든 뒤 한 번만 단언한다
    if (label === null) filter.edition = null;
    else filter['edition.label'] = label;
    if (excludeDocId !== null) filter.docId = { $ne: excludeDocId };
    return this.documents.find(filter as Filter<DocumentRecord>, PROJECTION).toArray();
  }

  /** 삭제되지 않은 문서를 읽는다. */
  findActive(): Promise<DocumentRecord[]> {
    return this.documents.find({ deleted: false }, PROJECTION).toArray();
  }

  /** 처리 상태가 맞는 문서를 읽는다. */
  findInProcessingStates(states: readonly ProcessingState[]): Promise<DocumentRecord[]> {
    return this.documents
      .find(
        {
          deleted: false,
          searchState: { $ne: 'replaced' },
          processingState: { $in: [...states] },
        },
        PROJECTION,
      )
      .toArray();
  }

  /** 보이는 문서를 ID로 읽는다. */
  async findVisibleByIds(ids: readonly string[]): Promise<DocumentRecord[]> {
    if (ids.length === 0) return [];
    return this.documents
      .find(
        { docId: { $in: [...ids] }, deleted: false, searchState: { $ne: 'replaced' } },
        PROJECTION,
      )
      .toArray();
  }

  /** 보이는 문서를 이름으로 읽는다. */
  async findVisibleByNames(names: readonly string[]): Promise<DocumentRecord[]> {
    if (names.length === 0) return [];
    return this.documents
      .find(
        { name: { $in: [...names] }, deleted: false, searchState: { $ne: 'replaced' } },
        PROJECTION,
      )
      .toArray();
  }

  /** 다시 요청할 문서를 읽는다. */
  findRetryCandidates(): Promise<DocumentRecord[]> {
    const filter = {
      $or: [
        { 'pendingRag.deleteChunks': true },
        { 'pendingRag.metadata': true },
        { deleted: true, purged: false },
      ],
    };
    return this.documents.find(filter as Filter<DocumentRecord>, PROJECTION).toArray();
  }

  /** 조건에 맞는 문서를 갱신하고 맞았는지 돌려준다. */
  async updateDocument(filter: DocumentFilter, set: Record<string, unknown>): Promise<boolean> {
    // ★ set의 점 경로 키(pendingRag.*)는 타입에 없어 한 번만 단언한다
    const result = await this.documents.updateOne(filter, { $set: set } as never);
    return result.matchedCount === 1;
  }

  /** 버전을 갱신하고 맞았는지 돌려준다. expect가 있으면 그 필드 값이 지금 같을 때만 갱신한다. */
  async updateVersion(
    docId: string,
    version: string,
    set: Record<string, unknown>,
    expect?: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.versions.updateOne(
      { docId, version, ...expect } as never,
      { $set: set } as never,
    );
    return result.matchedCount === 1;
  }

  /** 문서의 버전을 모두 지운다. */
  async deleteVersions(docId: string): Promise<void> {
    await this.versions.deleteMany({ docId });
  }
}

/** 버전 레코드를 필드별로 옮긴 새 객체를 만든다. */
function copyVersion(record: DocumentVersionRecord): DocumentVersionRecord {
  return {
    docId: record.docId,
    version: record.version,
    origin: record.origin,
    fileName: record.fileName,
    originalMarkdown: record.originalMarkdown,
    indexingMarkdown: record.indexingMarkdown,
    jobId: record.jobId,
    result: record.result === null ? null : { ...record.result },
    failure:
      record.failure === null
        ? null
        : {
            ...record.failure,
            headingPath:
              record.failure.headingPath === null ? null : [...record.failure.headingPath],
          },
  };
}
