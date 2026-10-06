import { Inject, Injectable } from '@nestjs/common';
import type { Collection, Db, Filter } from 'mongodb';
import type { ProcessingState, SearchState } from '../../common';
import { MONGO_DB } from '../../storage';
import { DOCUMENT_VERSIONS_COLLECTION, DOCUMENTS_COLLECTION } from '../interfaces/documents.types';
import type {
  DocumentRecord,
  DocumentVersionRecord,
  EditionRow,
  ListSortSpec,
  ListStateFilter,
} from '../interfaces/documents.types';

/** 조회 결과에서 _id를 뺀다. */
const PROJECTION = { projection: { _id: 0 } } as const;

/** 정규식 특수문자를 글자 그대로 쓰도록 이스케이프한다. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 목록 MongoDB 조건이다. */
export interface ListCriteria {
  searchStates?: SearchState[];
  processingStates?: ProcessingState[];
  name?: string;
  hasEdition?: boolean;
  uploadedFrom?: Date;
  uploadedTo?: Date;
  /** 있으면 최신판만 보기 조건을 붙인다. 이름별 가장 늦은 검색 가능 판 날짜 쌍이다 */
  latestEditions?: ReadonlyArray<{ name: string; editionDate: string }>;
}
/** 문서 갱신 조건이다. */
export type DocumentFilter = Filter<DocumentRecord>;
/** 문서 갱신에 쓸 수 있는 필드다. ★ 점 경로는 pendingRag 두 개뿐이다 */
export type DocumentUpdate = Partial<Omit<DocumentRecord, 'docId' | 'pendingRag'>> & {
  'pendingRag.deleteChunks'?: boolean;
  'pendingRag.metadata'?: boolean;
};
/** 버전 갱신에 쓸 수 있는 필드다. */
export type VersionUpdate = Partial<Omit<DocumentVersionRecord, 'docId' | 'version'>>;
/** 버전 갱신 조건으로 쓸 수 있는 필드다. 점 경로는 writtenCondition이 펼친 값이다. */
export type VersionCondition = Partial<
  Record<
    | 'jobId'
    | 'result'
    | 'failure'
    | 'result.chunkCount'
    | 'result.fallbackUsed'
    | 'failure.code'
    | 'failure.message'
    | 'failure.placeholderId',
    unknown
  >
>;

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

  /** 목록 조건에 맞는 문서 수를 센다. state가 있으면 그 값으로 좁힌다. */
  countList(criteria: ListCriteria, state?: ListStateFilter): Promise<number> {
    return this.documents.countDocuments(this.listFilter(criteria, state));
  }

  /** 목록 조건에 맞는 문서의 한 쪽을 DB에서 정렬·자르기해 읽는다. */
  async findListPage(
    criteria: ListCriteria,
    sort: ListSortSpec,
    skip: number,
    limit: number,
    state?: ListStateFilter,
  ): Promise<DocumentRecord[]> {
    if (limit <= 0) return [];
    return this.documents
      .find(this.listFilter(criteria, state), PROJECTION)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  /** 목록 거르기 조건을 만든다. */
  private listFilter(criteria: ListCriteria, state?: ListStateFilter): Filter<DocumentRecord> {
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
    const extra: Array<Record<string, unknown>> = [];
    if (criteria.latestEditions !== undefined) {
      const pairs = criteria.latestEditions.map((pair) => ({
        name: pair.name,
        'edition.editionDate': pair.editionDate,
      }));
      // ★ 판이 없는 문서는 남기고, 판이 있으면 검색 가능한 최신 판 날짜인 것만 남긴다
      extra.push({
        $or:
          pairs.length === 0
            ? [{ edition: null }]
            : [{ edition: null }, { searchState: 'searchable', $or: pairs }],
      });
    }
    if (state !== undefined) extra.push({ ...state });
    // ★ 점 경로 조건은 Filter 타입에 맞지 않아 Record로 만든 뒤 한 번만 단언한다
    return (extra.length === 0 ? filter : { $and: [filter, ...extra] }) as Filter<DocumentRecord>;
  }

  /** 판 칸·최신판 계산용으로 판이 있는 검색 가능 문서를 필요한 필드만 읽는다. */
  async findEditionRows(names?: readonly string[]): Promise<EditionRow[]> {
    if (names !== undefined && names.length === 0) return [];
    const filter: Record<string, unknown> = {
      deleted: false,
      searchState: 'searchable',
      edition: { $ne: null },
    };
    if (names !== undefined) filter.name = { $in: [...names] };
    return this.documents
      .find(filter as Filter<DocumentRecord>, {
        projection: { _id: 0, docId: 1, name: 1, edition: 1, searchState: 1, deleted: 1 },
      })
      .toArray() as Promise<EditionRow[]>;
  }

  /** 삭제되지 않은 문서의 이름을 이름순으로 읽는다. prefix로 시작하고 after보다 큰 이름만이다. */
  async findNamesSorted(prefix: string, after: string | null, limit: number): Promise<string[]> {
    const name: Record<string, unknown> = {};
    if (prefix !== '') name.$regex = `^${escapeRegExp(prefix)}`;
    if (after !== null) name.$gt = after;
    const filter: Record<string, unknown> = { deleted: false };
    if (Object.keys(name).length > 0) filter.name = name;
    const rows = await this.documents
      .find(filter as Filter<DocumentRecord>, { projection: { _id: 0, name: 1 } })
      .sort({ name: 1 })
      .limit(limit)
      .toArray();
    return rows.map((row) => row.name);
  }

  /** 문서마다 지정한 버전의 실패 사유만 읽는다. */
  async findLatestFailures(
    targets: ReadonlyArray<{ docId: string; version: string }>,
  ): Promise<Array<Pick<DocumentVersionRecord, 'docId' | 'version' | 'failure'>>> {
    if (targets.length === 0) return [];
    return this.versions
      .find(
        { $or: targets.map((target) => ({ docId: target.docId, version: target.version })) },
        { projection: { _id: 0, docId: 1, version: 1, failure: 1 } },
      )
      .toArray() as Promise<Array<Pick<DocumentVersionRecord, 'docId' | 'version' | 'failure'>>>;
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
  async updateDocument(filter: DocumentFilter, set: DocumentUpdate): Promise<boolean> {
    // ★ set의 점 경로 키(pendingRag.*)는 드라이버 타입에 없어 한 번만 단언한다
    const result = await this.documents.updateOne(filter, { $set: set } as never);
    return result.matchedCount === 1;
  }

  /** 버전을 갱신하고 맞았는지 돌려준다. expect가 있으면 그 필드 값이 지금 같을 때만 갱신한다. */
  async updateVersion(
    docId: string,
    version: string,
    set: VersionUpdate,
    expect?: VersionCondition,
  ): Promise<boolean> {
    // ★ expect의 점 경로 키는 드라이버 타입에 없어 한 번만 단언한다
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

  /** 문서 레코드를 지운다. ★ 만드는 도중 실패한 업로드를 되돌릴 때만 쓴다(삭제한 문서는 REQ-BE-1.8.6대로 지우지 않는다) */
  async deleteDocumentRecord(docId: string): Promise<void> {
    await this.documents.deleteMany({ docId });
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
