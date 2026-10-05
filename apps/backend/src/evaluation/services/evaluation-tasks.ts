import { Inject, Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EvaluationTaskName } from '../interfaces/evaluation.types';

/** 평가 백그라운드 작업을 돌린다. */
@Injectable()
export class EvaluationTasks implements BeforeApplicationShutdown {
  private readonly running = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {
    this.logger.setContext('EvaluationTasks');
  }

  /** 종료 중인가를 돌려준다. */
  get stopping(): boolean {
    return this.shuttingDown;
  }

  /** 작업을 다음 차례에 시작한다. 실패는 로그로만 남긴다. */
  run(task: EvaluationTaskName, goldenSetId: string | null, work: () => Promise<void>): void {
    if (this.shuttingDown) return;
    // ★ 응답이 나간 뒤(다음 이벤트 루프 차례)에 시작한다
    const chain: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => work())
      .catch((error: unknown) => {
        this.logFailure(task, goldenSetId, error);
      })
      .finally(() => {
        this.running.delete(chain);
      });
    this.running.add(chain);
  }

  /** 작업 실패를 로그로 남긴다. */
  logFailure(task: EvaluationTaskName, goldenSetId: string | null, error: unknown): void {
    // ★ 오류 메시지·스택은 남기지 않는다. 이름만 남긴다
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    this.logger.warn({ task, goldenSetId, errorName }, 'evaluation.task_failed');
  }

  /** 진행 중인 작업이 모두 끝날 때까지 기다린다. */
  async drain(): Promise<void> {
    // ★ 기다리는 동안 새로 들어온 작업도 기다린다
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  /** 새 작업을 막고 진행 중인 작업을 기다린다. */
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.drain();
  }
}
