import { Injectable } from '@nestjs/common';

/** 평가 시각을 준다. 직전 값보다 언제나 늦다. */
@Injectable()
export class EvaluationClock {
  private last = 0;

  /** 직전에 준 시각보다 1ms 이상 늦은 지금 시각을 준다. */
  now(): Date {
    // ★ 같은 밀리초에 두 번 불려도 값이 겹치지 않아야 최근 기록 판정에 동점이 없다
    const at = Math.max(Date.now(), this.last + 1);
    this.last = at;
    return new Date(at);
  }
}
