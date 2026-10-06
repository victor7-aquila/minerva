import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
import { AssetsService } from '../../assets';
import type { ProcessingState, SearchState } from '../../common';
import { INDEX_JOB_STATE_CHANGED, IndexingService } from '../../indexing';
import type { IndexJobStateChangedEvent } from '../../indexing';
import { LogsService } from '../../logs';
import { DocumentTasks } from './document-tasks';
import {
  canApplyEvent,
  LOCKED_STATES,
  newerSearchableVersion,
  targetStateOf,
} from '../helpers/document-state';
import { DocumentsCrudService } from './documents-crud.service';
import type { DocumentUpdate, VersionCondition, VersionUpdate } from './documents-crud.service';
import {
  RAG_UNREACHABLE_FAILURE,
  REPLACED_FAILURE,
  UNKNOWN_FAILURE,
} from '../interfaces/documents.types';
import type { DocumentRecord, VersionFailure } from '../interfaces/documents.types';

/** 이벤트 반영을 다시 시도하는 최대 횟수다. */
const MAX_ATTEMPTS = 3;

/** 하위 객체를 점 경로의 단순 값으로 펼친다. 배열은 뺀다. */
function flattenWritten(set: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const cond: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) {
    const path = `${prefix}${key}`;
    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === 'object') {
      Object.assign(cond, flattenWritten(value as Record<string, unknown>, `${path}.`));
    } else {
      cond[path] = value ?? null;
    }
  }
  return cond;
}

/**
 * 내가 쓴 값이 지금도 그대로인지 확인하는 조건을 만든다.
 * ★ 하위 객체는 키 순서에 흔들리지 않게 점 경로의 단순 값으로 펼친다(배열은 비교에서 뺀다)
 */
function writtenCondition(set: VersionUpdate): VersionCondition {
  // ★ 점 경로 키는 VersionCondition 범위의 값만 만든다 — VersionUpdate의 필드만 펼치기 때문이다
  return flattenWritten({ ...set }, '') as VersionCondition;
}

/** 처리 중인 버전의 키를 만든다. */
function activeKey(docId: string, version: string): string {
  return `${docId}\u0000${version}`;
}

/** 문서 처리 수명주기(상태 전이·처리 파이프라인·이벤트 반영·교체·정리)를 맡는다. */
@Injectable()
export class DocumentLifecycle {
  /** 청크 삭제 요청이 진행 중인 문서다. ★ 같은 문서의 요청이 겹쳐 나가지 않게 한다 */
  private readonly deleting = new Set<string>();
  /** 이름·판 정보 요청이 진행 중인 문서다. */
  private readonly syncing = new Set<string>();
  /** 진행 중에 새 요청이 들어와 한 번 더 돌아야 하는 문서다(청크 삭제). */
  private readonly deletingDirty = new Set<string>();
  /** 진행 중에 새 요청이 들어와 한 번 더 돌아야 하는 문서다(이름·판 정보). */
  private readonly syncingDirty = new Set<string>();
  /**
   * 이 프로세스에서 처리 중인 버전이다. 키는 `${docId}\u0000${version}`이다.
   * ★ 기동 처리와 요청 처리가 같은 버전을 두 번 돌리지 않게 한다
   */
  private readonly active = new Set<string>();

  constructor(
    @Inject(DocumentsCrudService) private readonly repo: DocumentsCrudService,
    @Inject(AssetsService) private readonly assets: AssetsService,
    @Inject(IndexingService) private readonly indexing: IndexingService,
    @Inject(LogsService) private readonly logs: LogsService,
    @Inject(DocumentTasks) private readonly tasks: DocumentTasks,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('DocumentLifecycle');
  }

  /** 처리 상태 변경을 문서 기록과 로그로 남긴다. */
  async recordStateChange(
    before: DocumentRecord,
    to: ProcessingState,
    reasonCode?: string,
    searchState?: SearchState,
  ): Promise<void> {
    if (before.processingState === to) return;
    await this.logs.record({
      kind: 'processing_state',
      docId: before.docId,
      name: before.name,
      editionLabel: before.edition?.label ?? null,
      outcome: to === 'failed' ? 'failure' : 'success',
      detail:
        to === 'failed'
          ? { fromState: before.processingState, toState: to, reasonCode }
          : { fromState: before.processingState, toState: to },
    });
    this.logger.info(
      {
        docId: before.docId,
        version: before.latestVersion,
        from: before.processingState,
        to,
        searchState: searchState ?? before.searchState,
      },
      'documents.state_changed',
    );
  }

  /** 마지막 버전이 version이고 처리 상태가 from 중 하나일 때만 처리 상태를 바꾼다. */
  async transition(
    docId: string,
    version: string,
    from: readonly ProcessingState[],
    to: ProcessingState,
    failure?: VersionFailure,
  ): Promise<boolean> {
    const doc = await this.repo.findDocument(docId);
    if (
      doc === null ||
      doc.deleted ||
      doc.searchState === 'replaced' ||
      doc.latestVersion !== version ||
      !from.includes(doc.processingState)
    ) {
      return false;
    }
    // ★ 상태보다 먼저 사유를 쓰고 쓰기 전 값을 보관한다 — 갱신이 어긋나면 되돌린다
    const before = failure ? await this.repo.findVersion(docId, version) : null;
    if (failure) await this.repo.updateVersion(docId, version, { failure: { ...failure } });
    const ok = await this.repo.updateDocument(
      {
        docId,
        deleted: false,
        searchState: doc.searchState,
        latestVersion: version,
        processingState: doc.processingState,
      },
      { processingState: to },
    );
    if (!ok) {
      if (failure) {
        // ★ 내가 쓴 사유가 그대로일 때만 되돌린다 — 먼저 성공한 쪽의 값을 지우지 않는다
        await this.repo.updateVersion(
          docId,
          version,
          { failure: before?.failure ?? null },
          writtenCondition({ failure }),
        );
      }
      return false;
    }
    await this.recordStateChange(doc, to, failure?.code);
    return true;
  }

  /** 처리를 멈춰야 하면 그 이유를, 아니면 null을 돌려준다. */
  async stopReason(
    docId: string,
    version: string,
  ): Promise<'shutdown' | 'deleted' | 'replaced' | 'superseded' | null> {
    if (this.tasks.stopping) return 'shutdown';
    const doc = await this.repo.findDocument(docId);
    if (doc === null || doc.deleted) return 'deleted';
    if (doc.searchState === 'replaced') return 'replaced';
    if (doc.latestVersion !== version) return 'superseded';
    return null;
  }

  /** 처리를 멈췄음을 로그로 남긴다. */
  private async logStopped(docId: string, version: string): Promise<void> {
    const reason = (await this.stopReason(docId, version)) ?? 'state_changed';
    this.logger.info({ docId, version, reason }, 'documents.processing_stopped');
  }

  /** 새 버전을 쓴 뒤 그사이 삭제·교체가 남긴 것을 맞춘다. ★ 실패는 삼킨다 — 호출자의 결과·오류가 우선이다 */
  async recheckAfterVersionWrite(docId: string): Promise<void> {
    try {
      const cur = await this.repo.findDocument(docId);
      if (cur === null) return;
      if (cur.deleted) {
        // ★ 그사이 데이터 삭제가 끝났으면 방금 쓴 표·이미지·버전이 남는다. 다시 지우게 한다 (REQ-BE-1.8.5)
        await this.repo.updateDocument({ docId, deleted: true }, { purged: false });
        this.scheduleChunkDeletion(docId);
        return;
      }
      if (cur.searchState === 'replaced' && cur.processingState === 'failed') {
        // ★ 선점 직후 교체되면 교체가 쓴 사유가 빈 버전 레코드에 덮였다 (REQ-BE-1.2.8)
        // ★ 다시 읽은 문서의 마지막 버전에 쓴다 — 롤백 뒤에는 되돌아간 버전이다
        await this.repo.updateVersion(
          docId,
          cur.latestVersion,
          { failure: { ...REPLACED_FAILURE } },
          { failure: null },
        );
      }
    } catch {
      // ★ 삼킨다 — 삭제는 주기 재요청이, 사유는 조회 때 null로 보일 뿐이다
    }
  }

  /**
   * 버전 처리를 백그라운드로 시작한다. 같은 버전이 이미 처리 중이면 아무것도 하지 않는다.
   * ★ 중복으로 건너뛴 경우는 로그를 남기지 않는다 — 처리 중인 쪽이 결과를 남긴다
   */
  startProcessing(
    docId: string,
    version: string,
    opts: { startAt: 'hints' | 'index'; force: boolean },
  ): void {
    // ★ 종료 중이면 tasks.run이 작업을 받지 않아 키가 풀리지 않는다 — 키를 잡지 않고 끝낸다
    if (this.tasks.stopping) return;
    const key = activeKey(docId, version);
    if (this.active.has(key)) return;
    // ★ 호출 즉시(동기로) 잡는다 — setImmediate로 작업이 시작되기 전의 틈도 막는다
    this.active.add(key);
    this.tasks.run(opts.startAt === 'hints' ? 'process' : 'index', docId, async () => {
      try {
        await this.processVersion(docId, version, opts);
      } finally {
        this.active.delete(key);
      }
    });
  }

  /** 기동 처리용이다. 처리 중이 아니고 아직 작업 ID가 없는 색인 대기 버전이면 색인을 요청한다. 요청했으면 참이다. */
  async requestIndexIfIdle(docId: string, version: string, force: boolean): Promise<boolean> {
    const key = activeKey(docId, version);
    if (this.active.has(key)) return false;
    this.active.add(key);
    try {
      const doc = await this.repo.findDocument(docId);
      const ver = await this.repo.findVersion(docId, version);
      // ★ 분류 뒤 요청 처리가 먼저 끝냈으면(작업 ID가 생겼거나 상태가 바뀌었으면) 다시 보내지 않는다
      if (
        doc === null ||
        ver === null ||
        ver.jobId !== null ||
        doc.latestVersion !== version ||
        doc.processingState !== 'queued'
      ) {
        return false;
      }
      await this.requestIndexFor(docId, version, force);
      return true;
    } finally {
      this.active.delete(key);
    }
  }

  /** 버전 하나를 표·이미지 처리부터 또는 색인 요청부터 처리한다. */
  async processVersion(
    docId: string,
    version: string,
    opts: { startAt: 'hints' | 'index'; force: boolean },
  ): Promise<void> {
    if (opts.startAt === 'hints') {
      // ★ REQ-BE-1.9.2: 처리 상태는 captioning이 된 뒤에 표·이미지를 처리한다
      if (!(await this.transition(docId, version, ['uploaded', 'captioning'], 'captioning'))) {
        await this.logStopped(docId, version);
        return;
      }
      const doc = await this.repo.findDocument(docId);
      if (doc === null) return;
      const result = await this.assets.generateHints(docId, version, {
        name: doc.name,
        editionLabel: doc.edition?.label ?? null,
        shouldContinue: async () => (await this.stopReason(docId, version)) === null,
      });
      if (result.stopped) {
        await this.logStopped(docId, version);
        return;
      }
    }
    await this.requestIndexFor(docId, version, opts.force);
  }

  /** 색인 대기로 바꾸고 색인을 요청해 결과를 반영한다. */
  async requestIndexFor(docId: string, version: string, force: boolean): Promise<void> {
    if (this.tasks.stopping) {
      await this.logStopped(docId, version);
      return;
    }
    // ★ 색인 요청보다 먼저 queued를 쓴다 — 기동 처리가 작업 ID 없는 색인 대기를 찾는다
    if (!(await this.transition(docId, version, ['captioning', 'queued'], 'queued'))) {
      await this.logStopped(docId, version);
      return;
    }
    const doc = await this.repo.findDocument(docId);
    const ver = await this.repo.findVersion(docId, version);
    // ★ 오류 메시지에 문서 내용을 넣지 않는다
    if (doc === null || ver === null || ver.indexingMarkdown === null) {
      throw new Error('version record missing');
    }
    const hints = await this.assets.hintsFor(docId, version);
    const outcome = await this.indexing.requestIndex({
      docId,
      version,
      indexingMarkdown: ver.indexingMarkdown,
      hints,
      name: doc.name,
      edition: doc.edition
        ? { label: doc.edition.label, editionDate: doc.edition.editionDate }
        : null,
      force,
    });

    if (outcome.kind === 'accepted') {
      await this.repo.updateVersion(docId, version, { jobId: outcome.jobId });
    } else if (outcome.kind === 'reused') {
      // ★ 같은 내용의 이전 버전 결과를 복사한다 (D9)
      const searchable = doc.searchableVersion
        ? await this.repo.findVersion(docId, doc.searchableVersion)
        : null;
      const result = searchable?.result ? { ...searchable.result } : null;
      // ★ 처리 상태가 아직 queued일 때만 반영한다 (REQ-BE-1.9.4). 어긋나면 되돌린다
      const cur = await this.repo.findDocument(docId);
      if (
        cur !== null &&
        !cur.deleted &&
        cur.searchState !== 'replaced' &&
        cur.latestVersion === version &&
        cur.processingState === 'queued'
      ) {
        const written = { jobId: outcome.jobId, result, failure: null };
        await this.repo.updateVersion(docId, version, written);
        if (!(await this.transition(docId, version, ['queued'], 'completed'))) {
          // ★ 내가 쓴 값이 그대로일 때만 되돌린다
          await this.repo.updateVersion(
            docId,
            version,
            { jobId: ver.jobId, result: ver.result, failure: ver.failure },
            writtenCondition(written),
          );
        }
      }
    } else {
      await this.transition(docId, version, ['queued'], 'failed', RAG_UNREACHABLE_FAILURE);
      return;
    }

    // ★ 색인 요청 도중 삭제·교체됐으면 청크 삭제를 다시 요청한다 (D22)
    const after = await this.repo.findDocument(docId);
    if (after === null || after.deleted || after.searchState === 'replaced') {
      await this.repo.updateDocument({ docId }, { 'pendingRag.deleteChunks': true });
      this.scheduleChunkDeletion(docId);
    }
  }

  /** IF-BE-1 색인 작업 상태 이벤트를 반영한다. */
  @OnEvent(INDEX_JOB_STATE_CHANGED, { suppressErrors: false })
  async onJobStateChanged(event: IndexJobStateChangedEvent): Promise<void> {
    // ★ 이 메서드 안에서 IndexingService.handleNotification을 부르지 않는다(같은 문서 사슬 교착).
    //   RAG Server 호출도 기다리지 않는다
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (await this.applyEventOnce(event)) return;
    }
    // ★ 시도를 다 쓰면 로그를 남긴다 — 다음 상태 맞추기가 맞춘다 (REQ-BE-1.9.5)
    this.logger.warn(
      { docId: event.docId, version: event.version, jobState: event.jobState },
      'documents.event_dropped',
    );
  }

  /** 이벤트를 한 번 반영해 본다. 끝났으면(반영했거나 반영할 것이 없으면) 참, 조건이 어긋났으면 거짓이다. */
  private async applyEventOnce(event: IndexJobStateChangedEvent): Promise<boolean> {
    const doc = await this.repo.findDocument(event.docId);
    if (doc === null || doc.deleted || doc.searchState === 'replaced') return true;
    if (event.version !== doc.latestVersion) return true;
    const target = targetStateOf(event.jobState);
    if (target === null) return true;

    const ver = await this.repo.findVersion(event.docId, event.version);
    const failureCode = doc.processingState === 'failed' ? (ver?.failure?.code ?? null) : null;
    const changeState = canApplyEvent(doc.processingState, failureCode, target);
    const searchable = newerSearchableVersion(doc.searchableVersion, event.searchableVersion);
    if (!changeState && searchable === null) return true;

    const stateChanged = changeState && target !== doc.processingState;
    const set: DocumentUpdate = {};
    if (stateChanged) set.processingState = target;
    if (searchable !== null) {
      set.searchableVersion = searchable;
      set.searchState = 'searchable';
    }

    // ★ 버전 레코드를 먼저 쓰고 쓰기 전 값(ver)을 보관한다. 상태 갱신 뒤 멈춰도 result·failure가
    //   비지 않는다. 갱신이 어긋나 포기하면 보관한 값으로 되돌린다.
    //   처리 상태가 그대로여도 failed 이벤트면 실패 사유를 갱신한다 (REQ-BE-1.9.5, RAG_UNREACHABLE 대체)
    let versionSet: VersionUpdate | null = null;
    if (changeState && target === 'completed') {
      versionSet = { result: event.result ? { ...event.result } : null, failure: null };
    } else if (changeState && target === 'failed') {
      versionSet = {
        failure: event.failure
          ? {
              ...event.failure,
              headingPath: event.failure.headingPath ? [...event.failure.headingPath] : null,
            }
          : { ...UNKNOWN_FAILURE },
      };
    }
    if (Object.keys(set).length === 0 && versionSet === null) return true;
    if (versionSet !== null) await this.repo.updateVersion(event.docId, event.version, versionSet);
    if (Object.keys(set).length === 0) return true;

    const ok = await this.repo.updateDocument(
      {
        docId: event.docId,
        deleted: false,
        searchState: doc.searchState,
        latestVersion: doc.latestVersion,
        processingState: doc.processingState,
      },
      set,
    );
    if (!ok) {
      if (versionSet !== null) {
        // ★ 내가 쓴 값이 그대로일 때만 되돌린다 — 먼저 성공한 쪽의 failure를 지우지 않는다
        await this.repo.updateVersion(
          event.docId,
          event.version,
          { result: ver?.result ?? null, failure: ver?.failure ?? null },
          writtenCondition(versionSet),
        );
      }
      return false;
    }

    const newSearchState: SearchState = searchable !== null ? 'searchable' : doc.searchState;
    if (stateChanged) {
      await this.recordStateChange(
        doc,
        target,
        target === 'failed' ? (event.failure?.code ?? 'UNKNOWN') : undefined,
        newSearchState,
      );
    } else {
      this.logger.info(
        {
          docId: doc.docId,
          version: doc.latestVersion,
          from: doc.processingState,
          to: doc.processingState,
          searchState: newSearchState,
        },
        'documents.state_changed',
      );
    }
    // ★ 새로 검색 가능해졌으면 같은 판의 먼저 들어온 문서를 교체한다 (REQ-BE-1.9.7, REQ-BE-1.2.5)
    if (doc.searchState === 'not_searchable' && searchable !== null) {
      await this.replaceOlderSiblings(event.docId);
    }
    return true;
  }

  /** 남을 문서보다 판에 먼저 들어온 같은 판 문서를 모두 교체됨으로 바꾼다. */
  async replaceOlderSiblings(survivorId: string): Promise<void> {
    const survivor = await this.repo.findDocument(survivorId);
    // ★ 교체는 남을 문서가 검색 가능일 때만 일어난다 (REQ-BE-1.2.5)
    if (survivor === null || survivor.deleted || survivor.searchState !== 'searchable') return;
    const same = await this.repo.findSameEdition(
      survivor.name,
      survivor.edition?.label ?? null,
      survivorId,
    );
    const older = same.filter(
      (c) => c.editionEnteredAt.getTime() < survivor.editionEnteredAt.getTime(),
    );
    for (const candidate of older) {
      await this.replaceOne(candidate.docId, survivor);
    }
  }

  /** 문서 하나를 교체됨으로 바꾼다. 조건이 어긋나면 다시 읽어 최대 3번 시도한다. */
  private async replaceOne(candidateId: string, survivor: DocumentRecord): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const cur = await this.repo.findDocument(candidateId);
      if (cur === null || cur.deleted || cur.searchState === 'replaced') return;
      if (
        cur.name !== survivor.name ||
        (cur.edition?.label ?? null) !== (survivor.edition?.label ?? null) ||
        cur.editionEnteredAt.getTime() >= survivor.editionEnteredAt.getTime()
      ) {
        return;
      }
      const processing = LOCKED_STATES.has(cur.processingState);
      if (processing) {
        await this.repo.updateVersion(cur.docId, cur.latestVersion, {
          failure: { ...REPLACED_FAILURE },
        });
      }
      const ok = await this.repo.updateDocument(
        {
          docId: cur.docId,
          deleted: false,
          searchState: cur.searchState,
          processingState: cur.processingState,
          name: cur.name,
          editionEnteredAt: cur.editionEnteredAt,
        },
        {
          searchState: 'replaced',
          'pendingRag.deleteChunks': true,
          'pendingRag.metadata': false,
          ...(processing ? { processingState: 'failed' } : {}),
        },
      );
      if (!ok) continue;
      await this.logs.record({
        kind: 'replace',
        docId: cur.docId,
        name: cur.name,
        editionLabel: cur.edition?.label ?? null,
        outcome: 'success',
        detail: { replacedByDocId: survivor.docId },
      });
      this.logger.info({ docId: cur.docId, replacedBy: survivor.docId }, 'documents.replaced');
      // ★ 진행 중이던 처리는 실패로 바꾼다 (REQ-BE-1.2.8)
      if (processing) await this.recordStateChange(cur, 'failed', 'REPLACED', 'replaced');
      this.scheduleChunkDeletion(cur.docId);
      return;
    }
  }

  /** 청크 삭제를 백그라운드로 요청한다. */
  scheduleChunkDeletion(docId: string): void {
    this.tasks.run('delete_chunks', docId, () => this.syncChunkDeletion(docId));
  }

  /** 표시가 남은 청크 삭제를 요청하고, 성공하면 표시를 지우고 삭제된 문서의 데이터를 지운다. */
  async syncChunkDeletion(docId: string): Promise<void> {
    // ★ 진행 중에 새 요청이 오면 건너뛰되 dirty를 세워 진행이 끝난 뒤 한 번 더 돈다 (D22)
    if (this.deleting.has(docId)) {
      this.deletingDirty.add(docId);
      return;
    }
    this.deleting.add(docId);
    try {
      let rerun = false;
      do {
        this.deletingDirty.delete(docId);
        await this.syncChunkDeletionOnce(docId, rerun);
        rerun = true;
      } while (this.deletingDirty.has(docId));
    } finally {
      this.deleting.delete(docId);
      this.deletingDirty.delete(docId);
    }
  }

  /** 청크 삭제 요청을 한 번 보낸다. rerun이면 표시를 다시 켠 뒤 보낸다. */
  private async syncChunkDeletionOnce(docId: string, rerun: boolean): Promise<void> {
    // ★ dirty 재실행은 진행 중이던 삭제의 성공이 표시를 지웠어도 의도(D22)를 되살린다.
    //   삭제는 멱등이라 중복 호출이 안전하고, 재실행이 실패해도 표시가 남아 주기 작업이 잇는다
    if (rerun) await this.repo.updateDocument({ docId }, { 'pendingRag.deleteChunks': true });
    const doc = await this.repo.findDocument(docId);
    if (doc === null) return;
    if (!doc.pendingRag.deleteChunks) {
      if (doc.deleted && !doc.purged) await this.purge(docId);
      return;
    }
    // ★ 거짓이면 표시가 남아 주기 작업이 다시 부른다 (REQ-BE-1.8.4)
    if (!(await this.indexing.deleteChunks(docId))) return;
    await this.repo.updateDocument(
      { docId, 'pendingRag.deleteChunks': true },
      { 'pendingRag.deleteChunks': false },
    );
    if (doc.deleted) await this.purge(docId);
  }

  /** 삭제된 문서의 표·이미지와 버전을 지운다. */
  async purge(docId: string): Promise<void> {
    // ★ 청크 삭제가 성공한 뒤에만 부른다 (REQ-BE-1.8.5). 셋 다 멱등이다
    await this.assets.deleteDocument(docId);
    await this.repo.deleteVersions(docId);
    await this.repo.updateDocument(
      { docId, deleted: true },
      { purged: true, 'pendingRag.metadata': false },
    );
  }

  /** 이름·판 정보 변경을 백그라운드로 요청한다. */
  scheduleMetadataSync(docId: string): void {
    this.tasks.run('metadata', docId, () => this.syncMetadata(docId));
  }

  /** 표시가 남은 이름·판 정보 변경을 요청하고, 성공하면 표시를 지운다. */
  async syncMetadata(docId: string): Promise<void> {
    // ★ 진행 중에 새 요청이 오면 dirty를 세워 진행이 끝난 뒤 한 번 더 돈다
    if (this.syncing.has(docId)) {
      this.syncingDirty.add(docId);
      return;
    }
    this.syncing.add(docId);
    try {
      do {
        this.syncingDirty.delete(docId);
        await this.syncMetadataOnce(docId);
      } while (this.syncingDirty.has(docId));
    } finally {
      this.syncing.delete(docId);
      this.syncingDirty.delete(docId);
    }
  }

  /** 이름·판 정보 요청을 한 번 보낸다. */
  private async syncMetadataOnce(docId: string): Promise<void> {
    const doc = await this.repo.findDocument(docId);
    if (doc === null || !doc.pendingRag.metadata) return;
    // 삭제됨·교체됨 문서는 보내지 않고 표시만 지운다 (D21)
    if (doc.deleted || doc.searchState === 'replaced') {
      await this.repo.updateDocument({ docId }, { 'pendingRag.metadata': false });
      return;
    }
    const ok = await this.indexing.updateMetadata(
      docId,
      doc.name,
      doc.edition ? { label: doc.edition.label, editionDate: doc.edition.editionDate } : null,
    );
    if (!ok) return;
    // ★ 그사이 다른 편집이 있었으면 표시를 남겨 다음 주기가 새 값을 보낸다 (D7)
    await this.repo.updateDocument(
      { docId, 'pendingRag.metadata': true, updatedAt: doc.updatedAt },
      { 'pendingRag.metadata': false },
    );
  }
}
