import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/** 백그라운드 작업 이름이다. 로그의 task 값이다. */
export type DocumentTaskName =
  'process' | 'index' | 'delete_chunks' | 'metadata' | 'resume' | 'reconcile' | 'rag_retry';

/** 문서 백그라운드 작업을 돌린다. */
@Injectable()
export class DocumentTasks implements BeforeApplicationShutdown {
  private readonly running = new Set<Promise<void>>();
  private shuttingDown = false;
  /** 종료 때 중단해 오래 기다리는 RAG 요청을 끊는다 */
  private readonly stopController = new AbortController();

  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {
    this.logger.setContext('DocumentTasks');
  }

  /** 종료 중인가를 돌려준다. */
  get stopping(): boolean {
    return this.shuttingDown;
  }

  /** 종료가 시작되면 중단되는 신호를 돌려준다. 청크 삭제·이름·판 정보 변경 요청에 넘긴다. */
  get stopSignal(): AbortSignal {
    return this.stopController.signal;
  }

  /** 작업을 다음 차례에 시작한다. 실패는 로그로만 남긴다. */
  run(task: DocumentTaskName, docId: string | null, work: () => Promise<void>): void {
    if (this.shuttingDown) return;
    // ★ 응답이 나간 뒤(다음 이벤트 루프 차례)에 시작한다
    const chain: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => work())
      .catch((error: unknown) => {
        // ★ 오류 메시지·스택은 남기지 않는다. 이름만 남긴다
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        this.logger.warn({ task, docId, errorName }, 'documents.task_failed');
      })
      .finally(() => {
        this.running.delete(chain);
      });
    this.running.add(chain);
  }

  /** 진행 중인 작업이 모두 끝날 때까지 기다린다. */
  async drain(): Promise<void> {
    // ★ 기다리는 동안 새로 들어온 작업도 기다린다
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  /** 새 작업을 막고, 오래 기다리는 RAG 요청을 끊은 뒤 진행 중인 작업을 기다린다. */
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    // ★ 기다리기 전에 끊는다. 아니면 RAG_WAIT_TIMEOUT_MS(기본 10분)까지 종료가 붙잡힌다
    this.stopController.abort();
    await this.drain();
  }
}
