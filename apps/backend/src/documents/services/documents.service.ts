import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { AssetsService } from '../../assets';
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
import { EDITABLE_STATES, isLocked, nextVersion } from '../helpers/document-state';
import {
  compareDocuments,
  isLatestOrNoEdition,
  latestEditionDates,
  siblingEditions,
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
import type {
  ChunkView,
  DocumentDetailView,
  DocumentRecord,
  DocumentRefData,
  DocumentRefView,
  DocumentSummaryView,
  EditionValue,
  EvaluationTarget,
  OriginalView,
  UploadedDocumentView,
} from '../interfaces/documents.types';
import { classifyUpload, matchMeta } from '../helpers/upload-files';
import type { UploadFile, UploadMetaInput, UploadSizeLimits } from '../helpers/upload-files';

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
    extraSet: Record<string, unknown>,
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
      await this.repo.updateDocument(
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

    const created: UploadedDocumentView[] = [];
    const docIds: string[] = [];
    for (const input of inputs) {
      const docId = randomUUID();
      const prepared = await this.assets.prepareVersion(
        docId,
        '1',
        input.markdown,
        classified.images,
      );
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
      await this.logs.record({
        kind: 'upload',
        docId,
        name: input.name,
        editionLabel: input.edition?.label ?? null,
        outcome: 'success',
      });
      docIds.push(docId);
      created.push({
        doc_id: docId,
        name: input.name,
        file_name: input.fileName,
        unmatched_images: prepared.unmatchedImages,
      });
    }
    // ★ 모두 만든 뒤에 처리를 시작한다 — 응답 뒤에 돈다 (REQ-BE-1.1.9)
    for (const docId of docIds) {
      this.lifecycle.startProcessing(docId, '1', { startAt: 'hints', force: false });
    }
    return { documents: created };
  }

  // ── 목록·조회 ──

  /** 문서 목록을 페이지로 준다. */
  async list(query: ListDocumentsQueryDto): Promise<Page<DocumentSummaryView>> {
    const candidates = await this.repo.findListCandidates({
      searchStates: query.search_state,
      processingStates: query.processing_state,
      name: query.name?.trim(),
      hasEdition: query.has_edition,
      uploadedFrom: query.uploaded_from ? parseKstDayRange(query.uploaded_from).start : undefined,
      uploadedTo: query.uploaded_to ? parseKstDayRange(query.uploaded_to).end : undefined,
    });
    const searchable = await this.repo.findSearchableWithEdition();

    let filtered = candidates;
    if (query.latest_only === true) {
      const latest = latestEditionDates(searchable);
      filtered = candidates.filter((doc) => isLatestOrNoEdition(doc, latest));
    }
    const sorted = [...filtered].sort(
      compareDocuments(query.sort ?? 'updated_at', query.order ?? 'desc'),
    );
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const pageDocs = sorted.slice((page - 1) * pageSize, page * pageSize);

    const indexingIds = pageDocs
      .filter((d) => d.processingState === 'indexing')
      .map((d) => d.docId);
    const stages = indexingIds.length > 0 ? await this.indexing.getStages(indexingIds) : new Map();
    const failedDocs = pageDocs.filter((d) => d.processingState === 'failed');
    const failedVersions = await this.repo.findVersionsOf(failedDocs.map((d) => d.docId));
    const latestOf = new Map(failedDocs.map((d) => [d.docId, d.latestVersion]));
    const failureMessages = new Map(
      failedVersions
        .filter((v) => latestOf.get(v.docId) === v.version)
        .map((v) => [v.docId, v.failure?.message ?? null]),
    );

    const items = pageDocs.map((doc) =>
      toSummary(doc, {
        siblings: siblingEditions(doc, searchable),
        stage: stages.get(doc.docId) ?? null,
        failureMessage: failureMessages.get(doc.docId) ?? null,
      }),
    );
    return toPage(items, sorted.length, query);
  }

  /** 문서 이름 목록을 준다. */
  async names(query: DocumentNamesQueryDto): Promise<{ items: string[] }> {
    const active = await this.repo.findActive();
    const prefix = query.prefix ?? '';
    const names = [...new Set(active.map((d) => d.name))]
      .filter((name) => name.startsWith(prefix))
      .sort(compareCodePoints);
    return { items: names.slice(0, query.limit ?? 20) };
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
    const ver = await this.repo.findVersion(docId, doc.latestVersion);
    // ★ 기동 처리가 고치기 전의 드문 경우다
    if (ver === null) throw new DocumentNotFoundError();
    const stage =
      doc.processingState === 'indexing'
        ? ((await this.indexing.getStages([docId])).get(docId) ?? null)
        : null;
    const siblings = siblingEditions(doc, await this.repo.findSearchableWithEdition(doc.name));
    const assets = await this.assets.listViews(docId, doc.latestVersion);
    return toDetail(doc, ver, { siblings, stage, assets });
  }

  /** 마지막 원본 MD와 이미지 주소를 준다. */
  async getOriginal(docId: string): Promise<OriginalView> {
    const doc = await this.activeDocument(docId);
    const ver = await this.repo.findVersion(docId, doc.latestVersion);
    if (ver === null) throw new DocumentNotFoundError();
    return {
      markdown: ver.originalMarkdown,
      images: await this.assets.imageUrls(docId, doc.latestVersion),
    };
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
    const set: Record<string, unknown> = { updatedAt: now };
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
        throw error;
      }
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
      throw error;
    }
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
      throw error;
    }

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
