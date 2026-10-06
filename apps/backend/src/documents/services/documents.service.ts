import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { AssetsService } from '../../assets';
import type { UploadedImage } from '../../assets';
import {
  DocumentLockedError,
  DocumentNotFoundError,
  InvalidRequestError,
  parseKstDayRange,
  RagUnavailableError,
} from '../../common';
import type { AppConfig, DomainError, ProcessingState } from '../../common';
import { toPage } from '../../../libs/utils';
import type { Page } from '../../../libs/utils';
import { IndexingService } from '../../indexing';
import { LogsService } from '../../logs';
import { RagClient, RagRequestError } from '../../rag';
import { DocumentClock } from './document-clock';
import { DocumentLifecycle } from './document-lifecycle.service';
import { EDITABLE_STATES, isLocked, nextVersion, previousVersion } from '../helpers/document-state';
import {
  bucketWindows,
  latestEditionPairs,
  listSortSpec,
  siblingEditions,
  stateBucketOrder,
  toChunkView,
  toDetail,
  toRefView,
  toSummary,
} from '../helpers/document-views';
import type {
  DocumentNamesQueryDto,
  EditDocumentDto,
  ListDocumentsQueryDto,
  ReplacementCheckQueryDto,
} from '../interfaces/documents.dto';
import { DocumentsCrudService } from './documents-crud.service';
import type { DocumentUpdate, ListCriteria } from './documents-crud.service';
import type {
  ChunkView,
  DocumentDetailView,
  DocumentRecord,
  DocumentRefData,
  DocumentRefView,
  DocumentSortColumn,
  DocumentSummaryView,
  DocumentVersionRecord,
  EditionValue,
  EvaluationTarget,
  ListStateFilter,
  OriginalView,
  UploadedDocumentView,
} from '../interfaces/documents.types';
import { classifyUpload, matchMeta } from '../helpers/upload-files';
import type {
  NewDocumentInput,
  UploadFile,
  UploadMetaInput,
  UploadSizeLimits,
} from '../helpers/upload-files';

/** 이름 목록을 읽는 묶음 크기다. */
const NAMES_BATCH = 100;
/** 다른 편집이 먼저 반영됐을 때의 안내 문장이다. */
const CONCURRENT_EDIT_MESSAGE = '다른 변경이 먼저 반영되었습니다. 다시 불러온 뒤 고쳐 주세요';

/** 코드 포인트 순으로 두 문자열을 비교한다. */
function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** 두 판 정보가 같은가를 본다. 둘 다 없으면 같다. */
function sameEdition(a: EditionValue | null, b: EditionValue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.label === b.label && a.editionDate === b.editionDate;
}

/** 문서 엔드포인트 동작과 다른 모듈용 조회를 맡는다. */
@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly limits: UploadSizeLimits;

  constructor(
    @Inject(DocumentsCrudService) private readonly repo: DocumentsCrudService,
    @Inject(DocumentLifecycle) private readonly lifecycle: DocumentLifecycle,
    @Inject(DocumentClock) private readonly clock: DocumentClock,
    @Inject(AssetsService) private readonly assets: AssetsService,
    @Inject(IndexingService) private readonly indexing: IndexingService,
    @Inject(LogsService) private readonly logs: LogsService,
    @Inject(RagClient) private readonly rag: RagClient,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('DocumentsService');
    this.limits = {
      maxMdBytes: config.get('UPLOAD_MAX_MD_BYTES', { infer: true }),
      maxImageBytes: config.get('UPLOAD_MAX_IMAGE_BYTES', { infer: true }),
    };
  }

  /** 인덱스를 준비한다. */
  async onModuleInit(): Promise<void> {
    await this.repo.ensureIndexes();
  }

  // ── 공통 헬퍼 ──

  /** 삭제되지 않은 문서를 읽는다. 없으면 DocumentNotFoundError다. */
  private async activeDocument(docId: string): Promise<DocumentRecord> {
    const doc = await this.repo.findDocument(docId);
    if (doc === null || doc.deleted) throw new DocumentNotFoundError();
    return doc;
  }

  /** 바꿀 수 없는 문서면 DocumentLockedError를 던진다. */
  private assertEditable(doc: DocumentRecord): void {
    if (isLocked(doc)) throw new DocumentLockedError();
  }

  /** 조건부 갱신이 어긋났을 때 던질 오류를 정한다. */
  private async lockedOrNotFound(docId: string): Promise<DomainError> {
    const current = await this.repo.findDocument(docId);
    if (current === null || current.deleted) return new DocumentNotFoundError();
    if (isLocked(current)) return new DocumentLockedError();
    // ★ 처리 상태는 그대로인데 어긋났다면 그사이 다른 편집이 반영된 것이다 (D5)
    return new DocumentLockedError(CONCURRENT_EDIT_MESSAGE);
  }

  /** 새 버전 번호를 선점한다. 조건부 갱신 하나로 처리 상태와 마지막 버전을 바꾼다. */
  private async claimNewVersion(
    doc: DocumentRecord,
    to: ProcessingState,
    extraSet: DocumentUpdate,
  ): Promise<string> {
    const next = nextVersion(doc.latestVersion);
    const ok = await this.repo.updateDocument(
      {
        docId: doc.docId,
        deleted: false,
        searchState: { $ne: 'replaced' },
        processingState: { $in: [...EDITABLE_STATES] },
        latestVersion: doc.latestVersion,
        updatedAt: doc.updatedAt,
      },
      { processingState: to, latestVersion: next, ...extraSet },
    );
    if (!ok) throw await this.lockedOrNotFound(doc.docId);
    return next;
  }

  /** 선점을 되돌린다. 되돌리기 자체가 실패해도 호출자의 원래 오류가 우선이다. */
  private async rollbackClaim(
    doc: DocumentRecord,
    next: string,
    claimed: ProcessingState,
  ): Promise<void> {
    try {
      const reverted = await this.repo.updateDocument(
        { docId: doc.docId, latestVersion: next, processingState: claimed },
        {
          processingState: doc.processingState,
          latestVersion: doc.latestVersion,
          updatedAt: doc.updatedAt,
          name: doc.name,
          edition: doc.edition,
          editionEnteredAt: doc.editionEnteredAt,
          'pendingRag.metadata': doc.pendingRag.metadata,
        },
      );
      if (!reverted) {
        // ★ 그사이 교체되면 처리 상태가 failed로 바뀌어 위 조건이 맞지 않는다. 마지막 버전만 되돌린다 — 처리·검색 상태는 교체 규칙대로 둔다
        await this.repo.updateDocument(
          { docId: doc.docId, latestVersion: next, searchState: 'replaced' },
          { latestVersion: doc.latestVersion },
        );
      }
    } catch {
      // ★ 삼킨다 — 기동 처리가 마지막 버전 레코드 없는 문서를 이전 버전으로 되돌린다
    }
  }

  // ── 업로드 ──

  /** 문서들을 올린다. */
  async upload(
    files: readonly UploadFile[] | undefined,
    meta: readonly UploadMetaInput[],
  ): Promise<{ documents: UploadedDocumentView[] }> {
    // ★ 여기까지 아무것도 쓰지 않는다 (REQ-BE-1.1.2·1.1.6·1.1.10)
    const classified = classifyUpload(files, this.limits, 'upload');
    const inputs = matchMeta(classified.markdowns, meta);

    const docIds: string[] = [];
    const created: Array<{ view: UploadedDocumentView; input: NewDocumentInput }> = [];
    try {
      for (const input of inputs) {
        const docId = randomUUID();
        // ★ 첫 쓰기 전에 넣는다 — 실패하면 이 문서의 쓰기도 되돌린다
        docIds.push(docId);
        created.push({ view: await this.createOne(docId, input, classified.images), input });
      }
      // ★ 업로드 기록은 모든 문서를 만든 뒤에 남긴다 — 실패한 요청의 기록이 남지 않게 한다
      // 기록을 남긴 뒤 다른 기록에서 실패하면 이미 남은 기록은 지우지 않는다(logs에 삭제 경로가 없다)
      for (const { view, input } of created) await this.recordUpload(view.doc_id, input);
    } catch (error) {
      await this.discardAll(docIds);
      throw error;
    }
    // ★ 모두 성공한 뒤에만 처리를 시작한다. 응답 뒤에 돈다 (REQ-BE-1.1.9)
    for (const docId of docIds) {
      this.lifecycle.startProcessing(docId, '1', { startAt: 'hints', force: false });
    }
    return { documents: created.map((c) => c.view) };
  }

  /** 올린 MD 하나로 문서를 만든다. 표·이미지, 버전, 문서 레코드를 쓴다. */
  private async createOne(
    docId: string,
    input: NewDocumentInput,
    images: readonly UploadedImage[],
  ): Promise<UploadedDocumentView> {
    const prepared = await this.assets.prepareVersion(docId, '1', input.markdown, images);
    await this.repo.insertVersion({
      docId,
      version: '1',
      origin: 'upload',
      fileName: input.fileName,
      originalMarkdown: input.markdown,
      indexingMarkdown: prepared.indexingMarkdown,
      jobId: null,
      result: null,
      failure: null,
    });
    const now = this.clock.now();
    await this.repo.insertDocument({
      docId,
      name: input.name,
      edition: input.edition,
      editionEnteredAt: now,
      searchState: 'not_searchable',
      processingState: 'uploaded',
      latestVersion: '1',
      searchableVersion: null,
      deleted: false,
      pendingRag: { deleteChunks: false, metadata: false },
      purged: false,
      uploadedAt: now,
      updatedAt: now,
    });
    return {
      doc_id: docId,
      name: input.name,
      file_name: input.fileName,
      unmatched_images: prepared.unmatchedImages,
    };
  }

  /** 업로드 기록을 남긴다. */
  private async recordUpload(docId: string, input: NewDocumentInput): Promise<void> {
    await this.logs.record({
      kind: 'upload',
      docId,
      name: input.name,
      editionLabel: input.edition?.label ?? null,
      outcome: 'success',
    });
  }

  /** 만드는 도중 실패한 업로드의 문서들을 모두 지운다. */
  private async discardAll(docIds: readonly string[]): Promise<void> {
    for (const docId of docIds) await this.discardOne(docId);
  }

  /** 문서 하나의 표·이미지, 버전, 문서 레코드를 지운다. 단계마다 따로 시도한다. */
  private async discardOne(docId: string): Promise<void> {
    const steps = [
      () => this.assets.deleteDocument(docId),
      () => this.repo.deleteVersions(docId),
      () => this.repo.deleteDocumentRecord(docId),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch {
        // ★ 삼킨다 — 하나가 실패해도 나머지를 지우고 원래 오류를 던진다
      }
    }
  }

  // ── 목록·조회 ──

  /** 문서 목록을 페이지로 준다. */
  async list(query: ListDocumentsQueryDto): Promise<Page<DocumentSummaryView>> {
    const criteria: ListCriteria = {
      searchStates: query.search_state,
      processingStates: query.processing_state,
      name: query.name?.trim(),
      hasEdition: query.has_edition,
      uploadedFrom: query.uploaded_from ? parseKstDayRange(query.uploaded_from).start : undefined,
      uploadedTo: query.uploaded_to ? parseKstDayRange(query.uploaded_to).end : undefined,
    };
    if (query.latest_only === true) {
      criteria.latestEditions = latestEditionPairs(await this.repo.findEditionRows());
    }
    const pageSize = query.page_size ?? 20;
    const skip = ((query.page ?? 1) - 1) * pageSize;
    const column: DocumentSortColumn = query.sort ?? 'updated_at';
    const order = query.order ?? 'desc';
    // ★ 거르기·정렬·쪽 자르기는 DB가 한다 — 전체를 읽어 메모리에서 자르지 않는다
    const { docs: pageDocs, total } =
      column === 'search_state' || column === 'processing_state'
        ? await this.pageByState(criteria, column, order, skip, pageSize)
        : {
            docs: await this.repo.findListPage(
              criteria,
              listSortSpec(column, order),
              skip,
              pageSize,
            ),
            total: await this.repo.countList(criteria),
          };

    const indexingIds = pageDocs
      .filter((d) => d.processingState === 'indexing')
      .map((d) => d.docId);
    const stages = indexingIds.length > 0 ? await this.indexing.getStages(indexingIds) : new Map();
    // ★ 실패 사유는 페이지의 실패 문서가 가리키는 마지막 버전의 것만 읽는다
    const failedVersions = await this.repo.findLatestFailures(
      pageDocs
        .filter((d) => d.processingState === 'failed')
        .map((d) => ({ docId: d.docId, version: d.latestVersion })),
    );
    const failureMessages = new Map(
      failedVersions.map((v) => [v.docId, v.failure?.message ?? null]),
    );
    const editionRows = await this.repo.findEditionRows([...new Set(pageDocs.map((d) => d.name))]);

    const items = pageDocs.map((doc) =>
      toSummary(doc, {
        siblings: siblingEditions(doc, editionRows),
        stage: stages.get(doc.docId) ?? null,
        failureMessage: failureMessages.get(doc.docId) ?? null,
      }),
    );
    return toPage(items, total, query);
  }

  /** 상태 열 정렬로 한 쪽을 읽는다. 값 순서대로 값별 구간을 이어 붙인다. */
  private async pageByState(
    criteria: ListCriteria,
    column: 'search_state' | 'processing_state',
    order: 'asc' | 'desc',
    skip: number,
    limit: number,
  ): Promise<{ docs: DocumentRecord[]; total: number }> {
    const filters: ListStateFilter[] =
      column === 'search_state'
        ? stateBucketOrder(column, order).map((searchState) => ({ searchState }))
        : stateBucketOrder(column, order).map((processingState) => ({ processingState }));
    const counts = await Promise.all(filters.map((state) => this.repo.countList(criteria, state)));
    const docs: DocumentRecord[] = [];
    for (const window of bucketWindows(counts, skip, limit)) {
      // ★ 값 안의 순서는 방향과 무관하게 수정 시각 최근순 → 문서 ID 오름차순이다
      docs.push(
        ...(await this.repo.findListPage(
          criteria,
          { updatedAt: -1, docId: 1 },
          window.skip,
          window.limit,
          filters[window.index],
        )),
      );
    }
    return { docs, total: counts.reduce((sum, count) => sum + count, 0) };
  }

  /** 문서 이름 목록을 준다. */
  async names(query: DocumentNamesQueryDto): Promise<{ items: string[] }> {
    const limit = query.limit ?? 20;
    const prefix = query.prefix ?? '';
    const items: string[] = [];
    let after: string | null = null;
    while (items.length < limit) {
      const batch: string[] = await this.repo.findNamesSorted(prefix, after, NAMES_BATCH);
      for (const name of batch) {
        if (items.length >= limit) break;
        // ★ 이름순이라 같은 이름은 이어져 나온다
        if (items[items.length - 1] !== name) items.push(name);
      }
      if (batch.length < NAMES_BATCH) break;
      after = batch[batch.length - 1];
    }
    return { items };
  }

  /** 같은 판이 되는 문서들을 준다. */
  async replacementCheck(
    query: ReplacementCheckQueryDto,
  ): Promise<{ replaces: DocumentRefView[] }> {
    const same = await this.repo.findSameEdition(
      query.name.trim(),
      query.edition_label?.trim() ?? null,
      query.exclude_doc_id ?? null,
    );
    const sorted = [...same].sort(
      (a, b) =>
        a.uploadedAt.getTime() - b.uploadedAt.getTime() || compareCodePoints(a.docId, b.docId),
    );
    return { replaces: sorted.map(toRefView) };
  }

  /** 문서 하나의 정보를 준다. */
  async getDetail(docId: string): Promise<DocumentDetailView> {
    const doc = await this.activeDocument(docId);
    const { record, version } = await this.versionForView(doc);
    const stage =
      doc.processingState === 'indexing'
        ? ((await this.indexing.getStages([docId])).get(docId) ?? null)
        : null;
    const siblings = siblingEditions(doc, await this.repo.findEditionRows([doc.name]));
    const assets = await this.assets.listViews(docId, version);
    return toDetail(doc, record, { siblings, stage, assets });
  }

  /** 마지막 원본 MD와 이미지 주소를 준다. */
  async getOriginal(docId: string): Promise<OriginalView> {
    const doc = await this.activeDocument(docId);
    const { record, version } = await this.versionForView(doc);
    return {
      markdown: record.originalMarkdown,
      images: await this.assets.imageUrls(docId, version),
    };
  }

  /** 조회에 쓸 버전 레코드를 준다. 선점 뒤 레코드를 쓰기 전이면 직전 버전이다. */
  private async versionForView(
    doc: DocumentRecord,
  ): Promise<{ record: DocumentVersionRecord; version: string }> {
    const latest = await this.repo.findVersion(doc.docId, doc.latestVersion);
    if (latest !== null) return { record: latest, version: doc.latestVersion };
    // ★ 새 버전을 만드는 중이거나 그 롤백이 끝나지 못했다 — 없거나 삭제된 문서가 아니므로 404가 아니다 (REQ-BE-1.4.1, AP-12)
    const prev = previousVersion(doc.latestVersion);
    const record = prev === null ? null : await this.repo.findVersion(doc.docId, prev);
    if (prev === null || record === null) throw new DocumentNotFoundError();
    return { record, version: prev };
  }

  /** 지금 검색에 쓰이는 청크를 준다. */
  async getChunks(docId: string): Promise<{ items: ChunkView[] }> {
    const doc = await this.activeDocument(docId);
    if (doc.searchState !== 'searchable') return { items: [] };
    let chunks;
    try {
      chunks = await this.rag.getDocumentChunks(docId);
    } catch (error) {
      // ★ 4xx·5xx는 도메인 오류가 아니라 그대로 두면 500이다 (D15)
      if (error instanceof RagRequestError) throw new RagUnavailableError();
      throw error;
    }
    const version = chunks.version;
    if (version === null) return { items: [] };
    const sorted = [...chunks.items].sort((a, b) => a.order - b.order);
    const items = await Promise.all(
      sorted.map(async (chunk) =>
        toChunkView(chunk, await this.assets.restore(docId, version, chunk.text)),
      ),
    );
    return { items };
  }

  // ── 편집·새 버전 ──

  /** 이름·판 정보·요약·캡션을 고친다. */
  async edit(docId: string, body: EditDocumentDto): Promise<DocumentDetailView> {
    const doc = await this.activeDocument(docId);
    this.assertEditable(doc);

    const newName = body.name?.trim();
    const nameChanged = newName !== undefined && newName !== doc.name;
    let newEdition: EditionValue | null = doc.edition;
    if (body.edition === null) newEdition = null;
    else if (body.edition !== undefined) {
      newEdition = { label: body.edition.label.trim(), editionDate: body.edition.edition_date };
    }
    const editionChanged = body.edition !== undefined && !sameEdition(newEdition, doc.edition);
    const labelChanged =
      body.edition !== undefined && (newEdition?.label ?? null) !== (doc.edition?.label ?? null);

    let hintChanges = new Map<string, string>();
    if (body.assets && body.assets.length > 0) {
      const views = await this.assets.listViews(docId, doc.latestVersion);
      const known = new Map(views.map((v) => [v.placeholderId, v.text]));
      const unknown = body.assets.map((a) => a.placeholder_id).filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new InvalidRequestError(
          `없는 표·이미지의 요약·캡션은 바꿀 수 없습니다: ${unknown.join(', ')}`,
        );
      }
      hintChanges = new Map(
        body.assets
          .filter((a) => known.get(a.placeholder_id) !== a.text)
          .map((a) => [a.placeholder_id, a.text]),
      );
    }

    // ★ 바뀐 것이 없으면 기록·갱신 없이 지금 문서를 준다 (D16)
    if (!nameChanged && !editionChanged && hintChanges.size === 0) return this.getDetail(docId);

    const now = this.clock.now();
    const set: DocumentUpdate = { updatedAt: now };
    if (nameChanged) set.name = newName;
    if (editionChanged) set.edition = newEdition;
    if (nameChanged || labelChanged) set.editionEnteredAt = now; // REQ-BE-1.2.4
    const metadataNeeded = (nameChanged || editionChanged) && doc.searchableVersion !== null;
    if (metadataNeeded) set['pendingRag.metadata'] = true;

    const changedFields: Array<'name' | 'edition' | 'hints'> = [];
    if (nameChanged) changedFields.push('name');
    if (editionChanged) changedFields.push('edition');
    if (hintChanges.size > 0) changedFields.push('hints');
    const editLog = {
      kind: 'edit' as const,
      docId,
      name: nameChanged ? (newName as string) : doc.name,
      editionLabel: newEdition?.label ?? null,
      outcome: 'success' as const,
      detail: { changedFields },
    };

    if (hintChanges.size > 0) {
      const next = await this.claimNewVersion(doc, 'queued', set);
      try {
        const prev = await this.repo.findVersion(docId, doc.latestVersion);
        if (prev === null) throw new Error('version record missing');
        await this.assets.inheritVersion(docId, doc.latestVersion, next, hintChanges);
        await this.repo.replaceVersion({
          docId,
          version: next,
          origin: 'hints',
          fileName: prev.fileName,
          originalMarkdown: prev.originalMarkdown,
          indexingMarkdown: prev.indexingMarkdown,
          jobId: null,
          result: null,
          failure: null,
        });
      } catch (error) {
        await this.rollbackClaim(doc, next, 'queued');
        await this.lifecycle.recheckAfterVersionWrite(docId);
        throw error;
      }
      // ★ 새 버전을 쓰는 사이 삭제·교체됐으면 맞춘다
      await this.lifecycle.recheckAfterVersionWrite(docId);
      await this.logs.record(editLog);
      await this.lifecycle.recordStateChange(doc, 'queued');
      this.lifecycle.startProcessing(docId, next, { startAt: 'index', force: false });
    } else {
      const ok = await this.repo.updateDocument(
        {
          docId,
          deleted: false,
          searchState: { $ne: 'replaced' },
          processingState: { $in: [...EDITABLE_STATES] },
          updatedAt: doc.updatedAt,
        },
        set,
      );
      if (!ok) throw await this.lockedOrNotFound(docId);
      await this.logs.record(editLog);
    }

    // ★ 이름·판 표기가 바뀌면 같은 판 문서와의 교체를 다시 본다 (REQ-BE-1.5.3)
    if ((nameChanged || labelChanged) && doc.searchState === 'searchable') {
      await this.lifecycle.replaceOlderSiblings(docId);
    }
    if (metadataNeeded) this.lifecycle.scheduleMetadataSync(docId);
    return this.getDetail(docId);
  }

  /** 문서 내용을 다시 올려 새 버전을 만든다. */
  async uploadContents(
    docId: string,
    files: readonly UploadFile[] | undefined,
  ): Promise<UploadedDocumentView> {
    const doc = await this.activeDocument(docId);
    this.assertEditable(doc);
    const classified = classifyUpload(files, this.limits, 'content');
    const md = classified.markdowns[0];

    const next = await this.claimNewVersion(doc, 'uploaded', { updatedAt: this.clock.now() });
    let unmatched: string[];
    try {
      const prepared = await this.assets.prepareVersion(
        docId,
        next,
        md.markdown,
        classified.images,
      );
      unmatched = prepared.unmatchedImages;
      await this.repo.replaceVersion({
        docId,
        version: next,
        origin: 'content',
        fileName: md.fileName,
        originalMarkdown: md.markdown,
        indexingMarkdown: prepared.indexingMarkdown,
        jobId: null,
        result: null,
        failure: null,
      });
    } catch (error) {
      await this.rollbackClaim(doc, next, 'uploaded');
      await this.lifecycle.recheckAfterVersionWrite(docId);
      throw error;
    }
    // ★ 새 버전을 쓰는 사이 삭제·교체됐으면 맞춘다
    await this.lifecycle.recheckAfterVersionWrite(docId);
    await this.logs.record({
      kind: 'content_upload',
      docId,
      name: doc.name,
      editionLabel: doc.edition?.label ?? null,
      outcome: 'success',
    });
    await this.lifecycle.recordStateChange(doc, 'uploaded');
    // ★ 검색 상태·searchableVersion은 건드리지 않는다 — 이전 버전이 계속 검색된다 (REQ-BE-1.6.2)
    this.lifecycle.startProcessing(docId, next, { startAt: 'hints', force: false });
    return {
      doc_id: docId,
      name: doc.name,
      file_name: md.fileName,
      unmatched_images: unmatched,
    };
  }

  /** 같은 내용의 새 버전으로 강제 재색인한다. */
  async reindex(docId: string): Promise<void> {
    const doc = await this.activeDocument(docId);
    this.assertEditable(doc);
    // ★ updatedAt을 바꾸지 않는다 — 내용 변경·편집이 아니다
    const next = await this.claimNewVersion(doc, 'queued', {});
    let count: number;
    try {
      const prev = await this.repo.findVersion(docId, doc.latestVersion);
      if (prev === null) throw new Error('version record missing');
      await this.assets.inheritVersion(docId, doc.latestVersion, next, new Map());
      await this.repo.replaceVersion({
        docId,
        version: next,
        origin: 'reindex',
        fileName: prev.fileName,
        originalMarkdown: prev.originalMarkdown,
        indexingMarkdown: prev.indexingMarkdown,
        jobId: null,
        result: null,
        failure: null,
      });
      count = await this.assets.markTemporaryForRegeneration(docId, next);
    } catch (error) {
      await this.rollbackClaim(doc, next, 'queued');
      await this.lifecycle.recheckAfterVersionWrite(docId);
      throw error;
    }
    // ★ 새 버전을 쓰는 사이 삭제·교체됐으면 맞춘다
    await this.lifecycle.recheckAfterVersionWrite(docId);

    if (count > 0) {
      // ★ 임시 설명이 있으면 다시 만든다. 기록에는 최종 상태만 남긴다 (D6)
      const ok = await this.repo.updateDocument(
        {
          docId,
          deleted: false,
          searchState: { $ne: 'replaced' },
          latestVersion: next,
          processingState: 'queued',
        },
        { processingState: 'captioning' },
      );
      if (!ok) return;
      await this.lifecycle.recordStateChange(doc, 'captioning');
      this.lifecycle.startProcessing(docId, next, { startAt: 'hints', force: true });
      return;
    }
    await this.lifecycle.recordStateChange(doc, 'queued');
    this.lifecycle.startProcessing(docId, next, { startAt: 'index', force: true });
  }

  /** 문서를 삭제됨으로 표시하고 정리를 시작한다. */
  async remove(docId: string): Promise<void> {
    const doc = await this.activeDocument(docId);
    const ok = await this.repo.updateDocument(
      { docId, deleted: false },
      { deleted: true, 'pendingRag.deleteChunks': true },
    );
    if (!ok) throw new DocumentNotFoundError();
    await this.logs.record({
      kind: 'delete',
      docId,
      name: doc.name,
      editionLabel: doc.edition?.label ?? null,
      outcome: 'success',
    });
    // ★ RAG Server 응답을 기다리지 않는다 (REQ-BE-1.8.1)
    this.lifecycle.scheduleChunkDeletion(docId);
  }

  // ── 다른 모듈용 조회 ──

  /** 이름들의 삭제됨·교체됨이 아닌 문서 ID를 준다. */
  async resolveNames(names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const docs = await this.repo.findVisibleByNames([...new Set(names)]);
    return [...docs]
      .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
      .map((d) => d.docId);
  }

  /** 받은 ID 중 삭제됨·교체됨이 아닌 것을 준다. */
  async visibleDocIds(docIds: readonly string[]): Promise<Set<string>> {
    if (docIds.length === 0) return new Set();
    const docs = await this.repo.findVisibleByIds([...new Set(docIds)]);
    return new Set(docs.map((d) => d.docId));
  }

  /** 문서의 이름·판을 준다. 삭제된 문서도 준다. */
  async getRef(docId: string): Promise<DocumentRefData | null> {
    const doc = await this.repo.findDocument(docId);
    if (doc === null) return null;
    return {
      docId: doc.docId,
      name: doc.name,
      edition: doc.edition
        ? { label: doc.edition.label, editionDate: doc.edition.editionDate }
        : null,
      deleted: doc.deleted,
    };
  }

  /** 평가에 쓸 문서 정보를 준다. */
  async getEvaluationTarget(docId: string): Promise<EvaluationTarget | null> {
    // ★ 문서를 한 번만 읽는다 — 읽기 두 번 사이에 상태가 달라지지 않게 한다
    const doc = await this.repo.findDocument(docId);
    if (doc === null) return null;
    const searchable = doc.searchableVersion
      ? await this.repo.findVersion(docId, doc.searchableVersion)
      : null;
    return {
      docId: doc.docId,
      name: doc.name,
      edition: doc.edition
        ? { label: doc.edition.label, editionDate: doc.edition.editionDate }
        : null,
      deleted: doc.deleted,
      searchState: doc.searchState,
      searchableIndexingMarkdown: searchable?.indexingMarkdown ?? null,
    };
  }
}
