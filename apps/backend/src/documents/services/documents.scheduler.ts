import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import type { AppConfig, ProcessingState } from '../../common';
import { IndexingService } from '../../indexing';
import { DocumentLifecycle } from './document-lifecycle.service';
import { previousVersion } from '../helpers/document-state';
import { DocumentTasks } from './document-tasks';
import { DocumentsCrudService } from './documents-crud.service';
import type { DocumentRecord } from '../interfaces/documents.types';

/** 상태 맞추기 주기 작업 이름이다. */
export const RECONCILE_INTERVAL_NAME = 'documents.reconcile';
/** RAG Server 재요청 주기 작업 이름이다. */
export const RAG_RETRY_INTERVAL_NAME = 'documents.rag_retry';

/** 재요청을 동시에 보내는 문서 수다. */
const RETRY_CONCURRENCY = 4;
/** 처리 중인 처리 상태들이다. */
const IN_PROGRESS: readonly ProcessingState[] = ['uploaded', 'captioning', 'queued', 'indexing'];

/** 기동 처리와 주기 작업을 돌린다. */
@Injectable()
export class DocumentsScheduler implements OnApplicationBootstrap {
  private readonly reconcileMs: number;
  private readonly retryMs: number;
  private reconciling = false;
  private retrying = false;

  constructor(
    @Inject(DocumentsCrudService) private readonly repo: DocumentsCrudService,
    @Inject(DocumentLifecycle) private readonly lifecycle: DocumentLifecycle,
    @Inject(DocumentTasks) private readonly tasks: DocumentTasks,
    @Inject(IndexingService) private readonly indexing: IndexingService,
    @Inject(SchedulerRegistry) private readonly registry: SchedulerRegistry,
    @Inject(EventEmitterReadinessWatcher) private readonly ready: EventEmitterReadinessWatcher,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('DocumentsScheduler');
    this.reconcileMs = config.get('RECONCILE_INTERVAL_MS', { infer: true });
    this.retryMs = config.get('RAG_RETRY_INTERVAL_MS', { infer: true });
  }

  /** 주기 작업을 걸고 기동 처리를 백그라운드로 시작한다. */
  onApplicationBootstrap(): void {
    // ★ setInterval 콜백은 void를 돌려준다. 겹침은 run*의 표시가 막는다
    this.registry.addInterval(
      RECONCILE_INTERVAL_NAME,
      setInterval(() => {
        this.tasks.run('reconcile', null, async () => {
          await this.runReconcile();
        });
      }, this.reconcileMs),
    );
    this.registry.addInterval(
      RAG_RETRY_INTERVAL_NAME,
      setInterval(() => {
        this.tasks.run('rag_retry', null, () => this.runRagRetry());
      }, this.retryMs),
    );
    // ★ 여기서 기다리지 않는다 — waitUntilReady는 이 훅 뒤에 풀린다 (D19)
    this.tasks.run('resume', null, async () => {
      await this.ready.waitUntilReady();
      await this.resume();
    });
  }

  /** 기동 처리를 한다. */
  async resume(): Promise<void> {
    // 1~2. 처리 중인데 마지막 버전 레코드가 없는 문서를 이전 버전으로 되돌린다 (D4)
    let recovered = 0;
    for (const doc of await this.repo.findInProcessingStates(IN_PROGRESS)) {
      if ((await this.repo.findVersion(doc.docId, doc.latestVersion)) !== null) continue;
      const prev = previousVersion(doc.latestVersion);
      const prevRecord = prev === null ? null : await this.repo.findVersion(doc.docId, prev);
      if (prev === null || prevRecord === null) continue;
      const to: ProcessingState = prevRecord.result !== null ? 'completed' : 'failed';
      const ok = await this.repo.updateDocument(
        {
          docId: doc.docId,
          deleted: false,
          latestVersion: doc.latestVersion,
          processingState: doc.processingState,
        },
        { latestVersion: prev, processingState: to },
      );
      if (!ok) continue;
      await this.lifecycle.recordStateChange(
        { ...doc, latestVersion: prev },
        to,
        to === 'failed' ? (prevRecord.failure?.code ?? 'UNKNOWN') : undefined,
      );
      recovered += 1;
    }

    // 3. 되돌린 결과를 반영해 다시 읽는다
    const captioningDocs: Array<{ docId: string; version: string; force: boolean }> = [];
    const jobless: Array<{ docId: string; version: string; force: boolean }> = [];
    for (const doc of await this.repo.findInProcessingStates(IN_PROGRESS)) {
      const ver = await this.repo.findVersion(doc.docId, doc.latestVersion);
      if (ver === null) continue;
      const target = {
        docId: doc.docId,
        version: doc.latestVersion,
        force: ver.origin === 'reindex',
      };
      if (doc.processingState === 'uploaded' || doc.processingState === 'captioning') {
        captioningDocs.push(target);
      } else if (doc.processingState === 'queued' && ver.jobId === null) {
        jobless.push(target);
      }
    }

    // 4. 작업 ID 없는 색인 대기를 다시 요청한다 (REQ-BE-1.9.10)
    for (const item of jobless) {
      await this.lifecycle.requestIndexFor(item.docId, item.version, item.force);
    }
    // 5. 상태 맞추기 (REQ-BE-3.3.1)
    const reconciled = await this.runReconcile();
    this.logger.info(
      {
        captioning: captioningDocs.length,
        requeued: jobless.length,
        reconciled,
        recovered,
      },
      'documents.resume',
    );
    // 7. 표·이미지 처리를 잇는다 — assets가 pending만 요청한다 (REQ-BE-1.9.9)
    for (const item of captioningDocs) {
      this.lifecycle.startProcessing(item.docId, item.version, {
        startAt: 'hints',
        force: item.force,
      });
    }
  }

  /** 처리 중인 문서의 상태를 맞추고 넘긴 문서 수를 돌려준다. 실행 중이면 바로 0을 돌려준다. */
  async runReconcile(): Promise<number> {
    if (this.reconciling) return 0;
    this.reconciling = true;
    try {
      const docs = await this.repo.findInProcessingStates(['queued', 'indexing']);
      const ids = docs.map((d) => d.docId);
      await this.indexing.reconcile(ids);
      return ids.length;
    } finally {
      this.reconciling = false;
    }
  }

  /** 표시가 남은 RAG Server 요청을 다시 보낸다. 실행 중이면 바로 끝난다. */
  async runRagRetry(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const candidates = await this.repo.findRetryCandidates();
      // ★ 느린 RAG 응답 하나가 다른 문서를 막지 않도록 묶음 단위로 동시에 처리한다
      for (let start = 0; start < candidates.length; start += RETRY_CONCURRENCY) {
        await Promise.all(
          candidates.slice(start, start + RETRY_CONCURRENCY).map((doc) => this.retryOne(doc)),
        );
      }
    } finally {
      this.retrying = false;
    }
  }

  /** 문서 하나의 표시된 요청을 다시 보낸다. 실패는 그 문서만 건너뛴다. */
  private async retryOne(doc: DocumentRecord): Promise<void> {
    try {
      if (doc.pendingRag.deleteChunks) await this.lifecycle.syncChunkDeletion(doc.docId);
      else if (doc.deleted && !doc.purged) await this.lifecycle.purge(doc.docId);
      if (doc.pendingRag.metadata) await this.lifecycle.syncMetadata(doc.docId);
    } catch (error) {
      this.logger.warn(
        {
          task: 'rag_retry',
          docId: doc.docId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'documents.task_failed',
      );
    }
  }
}
