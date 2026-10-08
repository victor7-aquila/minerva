import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
import { RagUnavailableError } from '../../common';
import type { AppConfig } from '../../common';
import { RagClient, RagRequestError } from '../../rag';
import type { RagChunking, RagIndexJob, RagIndexState, RagJobStage } from '../../rag';
import { INDEX_JOB_STATE_CHANGED } from '../interfaces/indexing.events';
import type {
  IndexJobStateChangedEvent,
  JobFailureInfo,
  JobResultInfo,
} from '../interfaces/indexing.events';
import type {
  IndexRequestInput,
  IndexRequestOutcome,
  RagEventNotification,
} from '../interfaces/indexing.types';
import { IndexingCrudService } from './indexing-crud.service';

/** reconcile이 getIndexJob을 동시에 부르는 문서 수다. */
const RECONCILE_CONCURRENCY = 4;
/** 실패 사유를 받지 못했을 때 넣는 코드다. */
const UNREACHABLE_FAILURE_CODE = 'RAG_UNREACHABLE';
/** 실패 사유를 받지 못했을 때 넣는 설명이다. */
const UNREACHABLE_FAILURE_MESSAGE = 'RAG Server에서 실패 사유를 받지 못했습니다';

/** 로그 operation 값이다. */
type RequestOperation =
  'requestIndex' | 'updateMetadata' | 'deleteChunks' | 'getIndexJob' | 'getIndexStates';

/** 대체 실패 사유를 만든다. ★ 호출마다 새 객체다 */
function unreachableFailure(): JobFailureInfo {
  return {
    code: UNREACHABLE_FAILURE_CODE,
    message: UNREACHABLE_FAILURE_MESSAGE,
    headingPath: null,
    placeholderId: null,
  };
}

/** RAG Server 호출 실패(rag가 변환한 오류)인지 본다. */
function isRagFailure(error: unknown): error is RagUnavailableError | RagRequestError {
  return error instanceof RagUnavailableError || error instanceof RagRequestError;
}

/** 오류 객체의 name 문자열을 돌려준다. 없으면 UnknownError다. ★ instanceof를 쓰지 않는다 */
function errorNameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return 'UnknownError';
}

/** 작업 조회 결과에서 결과 정보를 새 객체로 옮긴다. */
function toResultInfo(result: NonNullable<RagIndexJob['result']>): JobResultInfo {
  return { chunkCount: result.chunkCount, fallbackUsed: result.fallbackUsed };
}

/** 작업 조회 결과에서 실패 사유를 새 객체로 옮긴다. */
function toFailureInfo(failure: NonNullable<RagIndexJob['failure']>): JobFailureInfo {
  return {
    code: failure.code,
    message: failure.message,
    headingPath: failure.headingPath === null ? null : [...failure.headingPath],
    placeholderId: failure.placeholderId,
  };
}

/** 상태 맞추기 하나가 지켜보는 문서와, 묶음 조회 뒤 알림이 반영된 문서다. */
interface ReconcileWatch {
  docIds: ReadonlySet<string>;
  notified: Set<string>;
}

/** 색인 연동 서비스다. */
@Injectable()
export class IndexingService implements OnModuleInit {
  private readonly chunking: RagChunking;
  /** 문서별 알림 처리 사슬의 꼬리다. ★ 끝나면 지운다 */
  private readonly chains = new Map<string, Promise<void>>();
  /** 진행 중인 상태 맞추기의 감시다. ★ reconcile이 끝나면(던져도) 지운다 — 문서 수만큼 자라지 않는다 */
  private readonly reconcileWatches = new Set<ReconcileWatch>();

  constructor(
    @Inject(RagClient) private readonly rag: RagClient,
    @Inject(IndexingCrudService) private readonly cursors: IndexingCrudService,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('IndexingService');
    this.chunking = config.get('CHUNKING_MODE', { infer: true });
  }

  /** 알림 순번 인덱스를 준비한다. */
  async onModuleInit(): Promise<void> {
    await this.cursors.ensureIndexes();
  }

  /** 색인을 요청하고 결과를 돌려준다. RAG Server 실패는 unreachable로 돌려준다. */
  async requestIndex(input: IndexRequestInput): Promise<IndexRequestOutcome> {
    let accepted;
    try {
      accepted = await this.rag.submitIndexJob({
        docId: input.docId,
        version: input.version,
        markdown: input.indexingMarkdown,
        // ★ 입력 배열을 그대로 넘기지 않고 복사한다
        assets: input.hints.map((h) => ({ placeholderId: h.placeholderId, text: h.text })),
        name: input.name,
        edition:
          input.edition === null
            ? null
            : { label: input.edition.label, editionDate: input.edition.editionDate },
        chunking: this.chunking, // ★ 항상 설정 값
        force: input.force, // ★ 항상 입력 값
      });
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('requestIndex', input.docId, error.code);
      return { kind: 'unreachable' };
    }
    // ★ 계약 밖 값이 올 수 있다 (rag-wire는 검사하지 않는다)
    const outcome: string = accepted.outcome;
    if (outcome === 'queued' || outcome === 'joined') {
      return { kind: 'accepted', jobId: accepted.jobId };
    }
    if (outcome === 'reused') return { kind: 'reused', jobId: accepted.jobId };
    this.logRequestFailed('requestIndex', input.docId, 'INVALID_RESPONSE');
    return { kind: 'unreachable' };
  }

  /** 작업 상태 알림을 순번으로 거르고 IF-BE-1 이벤트로 넘긴다. ★ 알림 컨트롤러 전용 */
  handleNotification(notification: RagEventNotification): Promise<void> {
    return this.serializeByDoc(notification.docId, () => this.applyNotification(notification));
  }

  /** 문서들의 색인 상태를 조회해 문서마다 최신 작업의 이벤트를 발행한다. RAG Server 실패는 이벤트 없이 끝난다. */
  async reconcile(docIds: readonly string[]): Promise<void> {
    const unique = [...new Set(docIds)];
    let events = 0;
    if (unique.length > 0) {
      // ★ 묶음 조회 직전에 등록한다(동기) — 조회 중에 반영된 알림도 다시 조회 쪽으로 간다
      const watch: ReconcileWatch = { docIds: new Set(unique), notified: new Set() };
      this.reconcileWatches.add(watch);
      try {
        const states = await this.loadStates(unique);
        if (states !== null) {
          const wanted = new Set(unique);
          // ★ 요청하지 않은 문서와 작업이 없는 문서는 버린다
          const targets = states.filter((s) => wanted.has(s.docId) && s.latestJobId !== null);
          for (let start = 0; start < targets.length; start += RECONCILE_CONCURRENCY) {
            // ★ 문서 사이는 묶음 안에서 동시에, 같은 문서는 알림과 같은 사슬에서 차례로 돈다
            const settled = await Promise.allSettled(
              targets
                .slice(start, start + RECONCILE_CONCURRENCY)
                .map((s) => this.serializeByDoc(s.docId, () => this.reconcileOne(s, watch))),
            );
            for (const outcome of settled) {
              // ★ 같은 묶음 앞 문서의 발행을 마친 뒤에 던진다
              if (outcome.status === 'rejected') throw outcome.reason;
              if (outcome.value) events += 1;
            }
          }
        }
      } finally {
        this.reconcileWatches.delete(watch);
      }
    }
    this.logger.info({ docs: unique.length, events }, 'indexing.reconciled');
  }

  /** 직렬 구간 안에서 문서 하나의 이벤트를 발행한다. 발행했으면 참이다. */
  private async reconcileOne(batchState: RagIndexState, watch: ReconcileWatch): Promise<boolean> {
    const docId = batchState.docId;
    let state: RagIndexState | undefined = batchState;
    // ★ 묶음 조회 뒤 이 문서에 알림이 반영됐을 때만 다시 조회한다 — 낡은 스냅샷을 쓰지 않으면서 RAG 왕복은 보통 묶음 1번이다
    if (watch.notified.has(docId)) {
      const fresh = await this.loadStates([docId]);
      state = fresh?.find((s) => s.docId === docId);
    }
    if (state === undefined) return false;
    const event = await this.reconcileEvent(state);
    if (event === null) return false;
    await this.dispatch(event);
    return true;
  }

  /** 문서들 중 running 작업의 단계를 문서별로 돌려준다. RAG Server 실패면 빈 값이다. */
  async getStages(docIds: readonly string[]): Promise<ReadonlyMap<string, RagJobStage>> {
    const stages = new Map<string, RagJobStage>();
    const unique = [...new Set(docIds)];
    if (unique.length === 0) return stages;
    const states = await this.loadStates(unique);
    if (states === null) return stages;
    const wanted = new Set(unique);
    for (const state of states) {
      if (
        wanted.has(state.docId) &&
        state.latestJobState === 'running' &&
        state.latestJobStage !== null
      ) {
        stages.set(state.docId, state.latestJobStage);
      }
    }
    return stages;
  }

  /** RAG Server에 이름·판 정보 변경을 요청한다. 실패하면 예외 없이 거짓이다. */
  async updateMetadata(
    docId: string,
    name: string,
    edition: IndexRequestInput['edition'],
  ): Promise<boolean> {
    try {
      await this.rag.updateMetadata(
        docId,
        name,
        edition === null ? null : { label: edition.label, editionDate: edition.editionDate },
      );
      return true;
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('updateMetadata', docId, error.code);
      return false;
    }
  }

  /** RAG Server에 문서의 청크 삭제를 요청한다. 실패하면 예외 없이 거짓이다. */
  async deleteChunks(docId: string): Promise<boolean> {
    try {
      await this.rag.deleteDocument(docId);
      return true;
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('deleteChunks', docId, error.code);
      return false;
    }
  }

  /** 같은 문서의 작업을 차례로 돌린다. 다른 문서는 기다리지 않는다. */
  private serializeByDoc<T>(docId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(docId) ?? Promise.resolve();
    // ★ 앞 작업이 실패해도 다음 작업은 돈다
    const run = previous.then(
      () => task(),
      () => task(),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(docId, tail);
    // ★ 마지막 꼬리면 지운다 (Map이 문서 수만큼 자라지 않게)
    void tail.then(() => {
      if (this.chains.get(docId) === tail) this.chains.delete(docId);
    });
    return run;
  }

  /** 알림 하나를 순번 확인부터 이벤트 발행까지 처리한다. */
  private async applyNotification(n: RagEventNotification): Promise<void> {
    // 이미 반영한 순번 이하면 조회 없이 끝
    const last = await this.cursors.getLastSequence(n.docId);
    if (last !== null && n.sequence <= last) {
      this.logReceived(n, false);
      return;
    }

    // ★ 결과·실패 사유는 순번을 올리기 전에 준비한다
    let result: JobResultInfo | null = null;
    let failure: JobFailureInfo | null = null;
    if (n.jobState === 'succeeded') {
      result = await this.fetchResult(n);
      if (result === null) {
        // ★ 순번을 올리지 않는다 (상태 맞추기가 맞춘다)
        this.logReceived(n, false);
        return;
      }
    } else if (n.jobState === 'failed') {
      failure = await this.fetchFailure(n);
    }

    // 조건부 갱신. 동시에 더 큰 순번이 먼저 반영됐으면 거짓
    if (!(await this.cursors.advance(n.docId, n.sequence))) {
      this.logReceived(n, false);
      return;
    }

    // ★ 진행 중인 상태 맞추기가 이 문서를 보고 있으면 묶음 조회 뒤 반영됐음을 알린다
    for (const watch of this.reconcileWatches) {
      if (watch.docIds.has(n.docId)) watch.notified.add(n.docId);
    }

    await this.dispatch({
      docId: n.docId,
      version: n.version,
      jobId: n.jobId,
      jobState: n.jobState,
      searchableVersion: n.searchableVersion,
      result,
      failure,
      source: 'notification',
    });
    this.logReceived(n, true);
  }

  /** 성공 작업의 결과를 조회한다. 받지 못하면 null이다. */
  private async fetchResult(n: RagEventNotification): Promise<JobResultInfo | null> {
    try {
      const job = await this.rag.getIndexJob(n.jobId);
      if (job.result === null) {
        this.logRequestFailed('getIndexJob', n.docId, 'MISSING_RESULT');
        return null;
      }
      return toResultInfo(job.result);
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('getIndexJob', n.docId, error.code);
      return null;
    }
  }

  /** 실패 작업의 사유를 조회한다. 받지 못하면 대체 사유를 돌려준다. */
  private async fetchFailure(n: RagEventNotification): Promise<JobFailureInfo> {
    try {
      const job = await this.rag.getIndexJob(n.jobId);
      if (job.failure === null) {
        this.logRequestFailed('getIndexJob', n.docId, 'MISSING_FAILURE');
        return unreachableFailure();
      }
      return toFailureInfo(job.failure);
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('getIndexJob', n.docId, error.code);
      return unreachableFailure();
    }
  }

  /** 이벤트를 발행하고 받는 쪽 처리가 끝날 때까지 기다린다. 받는 쪽 실패는 로그만 남긴다. */
  private async dispatch(event: IndexJobStateChangedEvent): Promise<void> {
    try {
      // ★ emitAsync는 받는 쪽이 동기로 던져도 거부된 Promise를 돌려준다. try 안에서 await한다
      await this.events.emitAsync(INDEX_JOB_STATE_CHANGED, event);
    } catch (error) {
      this.logger.warn(
        {
          docId: event.docId,
          jobId: event.jobId,
          source: event.source,
          errorName: errorNameOf(error),
        },
        'indexing.event_dispatch_failed',
      );
    }
  }

  /** 색인 상태를 조회한다. RAG Server 실패면 null이다. */
  private async loadStates(docIds: readonly string[]): Promise<RagIndexState[] | null> {
    try {
      return await this.rag.getIndexStates(docIds);
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('getIndexStates', null, error.code);
      return null;
    }
  }

  /** 색인 상태 하나로 상태 맞추기 이벤트를 만든다. 넘어갈 문서면 null이다. */
  private async reconcileEvent(state: RagIndexState): Promise<IndexJobStateChangedEvent | null> {
    if (state.latestJobId === null || state.latestJobState === null) return null;
    let job: RagIndexJob;
    try {
      job = await this.rag.getIndexJob(state.latestJobId);
    } catch (error) {
      if (!isRagFailure(error)) throw error;
      this.logRequestFailed('getIndexJob', state.docId, error.code);
      return null;
    }
    const jobState = state.latestJobState;
    let result: JobResultInfo | null = null;
    let failure: JobFailureInfo | null = null;
    if (jobState === 'succeeded') {
      if (job.result === null) {
        this.logRequestFailed('getIndexJob', state.docId, 'MISSING_RESULT');
        return null;
      }
      result = toResultInfo(job.result);
    } else if (jobState === 'failed') {
      // ★ 알림 경로와 달리 대체 사유를 쓰지 않는다
      if (job.failure === null) {
        this.logRequestFailed('getIndexJob', state.docId, 'MISSING_FAILURE');
        return null;
      }
      failure = toFailureInfo(job.failure);
    }
    return {
      docId: state.docId,
      version: job.version,
      jobId: state.latestJobId,
      jobState,
      searchableVersion: state.searchableVersion,
      result,
      failure,
      source: 'reconcile',
    };
  }

  /** 색인 요청·조회 실패를 남긴다. ★ 오류 메시지·본문은 넣지 않는다 */
  private logRequestFailed(operation: RequestOperation, docId: string | null, code: string): void {
    this.logger.warn({ operation, docId, code }, 'indexing.request_failed');
  }

  /** 알림 처리 결과를 한 줄 남긴다. */
  private logReceived(n: RagEventNotification, applied: boolean): void {
    this.logger.info(
      {
        docId: n.docId,
        jobId: n.jobId,
        jobState: n.jobState,
        sequence: n.sequence,
        applied,
      },
      'indexing.event_received',
    );
  }
}
