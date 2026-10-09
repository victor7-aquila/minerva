import { CronTime } from 'cron';

/** 예약 색인의 시간대다. */
export const INDEX_TIME_ZONE = 'Asia/Seoul';

/** 예약 색인 일정을 만든다. */
export function createIndexCronTime(expression: string): CronTime {
  return new CronTime(expression, INDEX_TIME_ZONE);
}

/** after보다 뒤에 일정이 처음 오는 시각을 준다. 오지 않는 일정이면 null이다. */
export function nextIndexTime(cronTime: CronTime, after: Date): Date | null {
  try {
    return cronTime.getNextDateFrom(after).toJSDate();
  } catch {
    // ★ 8년 안에 일정이 없으면 cron이 예외를 던진다 (REQ-BE-1.10.1, 오지 않는 일정)
    return null;
  }
}
