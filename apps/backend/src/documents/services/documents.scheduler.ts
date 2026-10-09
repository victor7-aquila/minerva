import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PinoLogger } from 'nestjs-pino';
import type { AppConfig, ProcessingState } from '../../common';
import { IndexingService } from '../../indexing';
import { DocumentLifecycle } from './document-lifecycle.service';
import { IN_PROGRESS_STATES } from '../helpers/document-state';
import { createIndexCronTime, INDEX_TIME_ZONE, nextIndexTime } from '../helpers/index-schedule';
import { DocumentClock } from './document-clock';
import { DocumentTasks } from './document-tasks';
import { DocumentsCrudService } from './documents-crud.service';
import type { DocumentRecord } from '../interfaces/documents.types';

/** 상태 맞추기 주기 작업 이름이다. */
export const RECONCILE_INTERVAL_NAME = 'documents.reconcile';
/** RAG Server 재요청 주기 작업 이름이다. */
export const RAG_RETRY_INTERVAL_NAME = 'documents.rag_retry';

/** 예약 색인 크론 작업 이름이다. */
export const INDEX_SCHEDULE_JOB_NAME = 'documents.scheduled_index';

/** 재요청을 동시에 보내는 문서 수다. */
const RETRY_CONCURRENCY = 4;
/** 처리 중인 처리 상태들이다. */
const IN_PROGRESS: readonly ProcessingState[] = [...IN_PROGRESS_STATES];

/** 기동 처리가 이어 갈 버전 하나다. */
interface ResumeTarget {
  docId: string;
  version: string;
}

/** 기동 처리와 주기 작업을 돌린다. */
@Injectable()
export class DocumentsScheduler implements OnApplicationBootstrap {
  private readonly reconcileMs: number;
  private readonly retryMs: number;
  private reconciling = false;
  private retrying = false;
  private scheduledIndexing = false;
  private readonly indexCron: string;

  constructor(
    @Inject(DocumentsCrudService) private readonly repo: DocumentsCrudService,
    @Inject(DocumentLifecycle) private readonly lifecycle: DocumentLifecycle,
    @Inject(DocumentTasks) private readonly tasks: DocumentTasks,
    @Inject(DocumentClock) private readonly clock: DocumentClock,
    @Inject(IndexingService) private readonly indexing: IndexingService,
    @Inject(SchedulerRegistry) private readonly registry: SchedulerRegistry,
    @Inject(EventEmitterReadinessWatcher) private readonly ready: EventEmitterReadinessWatcher,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('DocumentsScheduler');
    this.reconcileMs = config.get('RECONCILE_INTERVAL_MS', { infer: true });
    this.retryMs = config.get('RAG_RETRY_INTERVAL_MS', { infer: true });
    this.indexCron = config.get('INDEX_SCHEDULE_CRON', { infer: true });
  }

  /** 예약 색인을 한 번 돌린다. 앞 실행이 끝나지 않았으면 바로 끝난다. */
  async runScheduledIndex(): Promise<void> {
    if (this.scheduledIndexing) return;
    this.scheduledIndexing = true;
    try {
      const { requested, unreachable } = await this.lifecycle.runScheduledIndex();
      this.logger.info({ requested, unreachable }, 'documents.index_scheduled');
    } finally {
      this.scheduledIndexing = false;
    }
  }

  /** 예약 색인 크론 작업을 등록하고 시작한다. 오지 않는 일정이면 등록하지 않고 경고만 남긴다. */
  private registerScheduledIndex(): void {
    // ★ job.start()도 오지 않는 일정이면 예외를 던진다 — 먼저 다음 시각을 확인한다
    if (nextIndexTime(createIndexCronTime(this.indexCron), this.clock.wallNow()) === null) {
      // 표현식 값과 cron의 오류 메시지는 담지 않는다
      this.logger.warn({ key: 'INDEX_SCHEDULE_CRON' }, 'documents.index_schedule_unavailable');
      return;
    }
    const job = CronJob.from({
      cronTime: this.indexCron,
      // ★ 겹침은 runScheduledIndex의 표시가 막는다
      onTick: () => {
        this.tasks.run('scheduled_index', null, () => this.runScheduledIndex());
      },
      timeZone: INDEX_TIME_ZONE,
      start: false,
    });
    this.registry.addCronJob(INDEX_SCHEDULE_JOB_NAME, job);
    job.start();
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
    this.registerScheduledIndex();
    // ★ 여기서 기다리지 않는다 — waitUntilReady는 이 훅 뒤에 풀린다 (D19)
    this.tasks.run('resume', null, async () => {
      await this.ready.waitUntilReady();
      await this.resume();
    });
  }

  /**
   * 작업 하나를 돌리고 실패하면 로그만 남긴다. 실패했으면 거짓이다.
   * ★ 문서 하나의 실패가 나머지 문서의 기동 처리를 막지 않게 한다
   */
  private async isolate(docId: string | null, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      this.logger.warn(
        {
          task: 'resume',
          docId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'documents.task_failed',
      );
      return false;
    }
  }

  /** 기동 처리를 한다. */
  async resume(): Promise<void> {
    // 1. 처리 중인데 마지막 버전 레코드가 없는 문서를 이전 버전으로 되돌린다 (D4)
    const recovered = await this.recoverMissingVersions();

    // 2. 되돌린 결과를 반영해 표·이미지 처리를 이을 문서를 모은다
    // ★ 대기열을 비우거나 색인을 요청하지 않는다 (REQ-BE-1.10.8)
    const captioningDocs = await this.collectCaptioning();

    // 3. 상태 맞추기 (REQ-BE-3.3.1)
    let reconciled = 0;
    await this.isolate(null, async () => {
      reconciled = await this.runReconcile();
    });
    this.logger.info(
      {
        captioning: captioningDocs.length,
        reconciled,
        recovered,
      },
      'documents.resume',
    );
    // 4. 표·이미지 처리를 잇는다 — assets가 pending만 요청한다 (REQ-BE-1.9.9)
    for (const item of captioningDocs) {
      this.lifecycle.startProcessing(item.docId, item.version);
    }
  }

  /** 마지막 버전 레코드가 없는 처리 중 문서를 이전 버전으로 되돌리고 되돌린 문서 수를 돌려준다. */
  private async recoverMissingVersions(): Promise<number> {
    let recovered = 0;
    for (const doc of await this.repo.findInProcessingStates(IN_PROGRESS)) {
      await this.isolate(doc.docId, async () => {
        if (await this.recoverOne(doc)) recovered += 1;
      });
    }
    return recovered;
  }

  /** 문서 하나를 이전 버전으로 되돌린다. 되돌렸으면 참이다. */
  private async recoverOne(doc: DocumentRecord): Promise<boolean> {
    // ★ 이 프로세스에서 새 버전을 쓰는 중인 선점은 되돌리지 않는다 — 버전 레코드보다 표시를 먼저 본다.
    //   표시가 없는데 레코드도 없으면 다른 프로세스의 끊긴 선점이거나 롤백이 실패한 선점이다
    if (this.lifecycle.isClaiming(doc.docId, doc.latestVersion)) return false;
    if ((await this.repo.findVersion(doc.docId, doc.latestVersion)) !== null) return false;
    // 직전 버전 = latestVersion보다 작은 가장 큰 번호
    const latest = Number(doc.latestVersion);
    const earlier = (await this.repo.findVersionNumbers(doc.docId))
      .filter((version) => Number(version) < latest)
      .sort((a, b) => Number(b) - Number(a));
    const prev = earlier[0];
    if (prev === undefined) return false;
    const prevRecord = await this.repo.findVersion(doc.docId, prev);
    if (prevRecord === null) return false;
    // 복원 표 (documents MODULE.md 「기동 때 선점 되돌리기」)
    let to: ProcessingState;
    let queuedVersion: string | null = null;
    if (prevRecord.result !== null) {
      to = 'completed';
    } else if (prevRecord.failure !== null) {
      to = 'failed';
    } else {
      to = 'queued';
      // 작업 ID가 없으면 직전 버전이 대기열에 있던 것이다
      if (prevRecord.jobId === null) queuedVersion = prev;
    }
    // ★ 조회를 기다리는 사이 같은 버전을 다시 선점했을 수 있다 — 되돌리기 직전에(동기로) 한 번 더 본다
    if (this.lifecycle.isClaiming(doc.docId, doc.latestVersion)) return false;
    const ok = await this.repo.updateDocument(
      {
        docId: doc.docId,
        deleted: false,
        searchState: { $ne: 'replaced' },
        latestVersion: doc.latestVersion,
        processingState: doc.processingState,
      },
      { latestVersion: prev, processingState: to, queuedVersion },
    );
    if (!ok) return false;
    await this.lifecycle.recordStateChange(
      { ...doc, latestVersion: prev },
      to,
      to === 'failed' ? (prevRecord.failure?.code ?? 'UNKNOWN') : undefined,
    );
    return true;
  }

  /** 처리 중인 문서에서 표·이미지 처리를 이을 버전을 모은다. */
  private async collectCaptioning(): Promise<ResumeTarget[]> {
    const targets: ResumeTarget[] = [];
    for (const doc of await this.repo.findInProcessingStates(['uploaded', 'captioning'])) {
      await this.isolate(doc.docId, async () => {
        if ((await this.repo.findVersion(doc.docId, doc.latestVersion)) === null) return;
        targets.push({ docId: doc.docId, version: doc.latestVersion });
      });
    }
    return targets;
  }

  /** 처리 중인 문서의 상태를 맞추고 넘긴 문서 수를 돌려준다. 실행 중이면 바로 0을 돌려준다. */
  async runReconcile(): Promise<number> {
    if (this.reconciling) return 0;
    this.reconciling = true;
    try {
      // ★ 대기열 문서는 뺀다 — 색인을 요청한 적이 없다 (REQ-BE-3.3.1, REQ-BE-1.9.11)
      const docs = await this.repo.findReconcileTargets();
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
      // ★ 데이터 삭제도 청크 삭제 진행 표시 안에서 돈다 — recheck가 다시 돌기를 요청할 수 있게 한다 (REQ-BE-1.8.5)
      if (doc.pendingRag.deleteChunks || (doc.deleted && !doc.purged)) {
        await this.lifecycle.syncChunkDeletion(doc.docId);
      }
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
