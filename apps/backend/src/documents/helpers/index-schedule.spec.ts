import { CronTime } from 'cron';
import { toIsoUtc } from '../../common';
import { createIndexCronTime, INDEX_TIME_ZONE, nextIndexTime } from './index-schedule';

// ★ cron 표현식 해석 규칙 자체는 cron 패키지의 것이라 다시 검증하지 않는다.
// 여기서는 cron을 감싼 두 함수(시간대 고정, "언제나 after보다 뒤", 오지 않는 일정은 null)만 본다.

/** 다음 예약 시각을 ISO 문자열로 돌려준다. 오지 않는 일정이면 null이다. */
function nextIso(expression: string, after: string): string | null {
  const next = nextIndexTime(createIndexCronTime(expression), new Date(after));
  return next === null ? null : next.toISOString();
}

describe('REQ-BE-1.10.1', () => {
  it('T-CRON-1 createIndexCronTime이 Asia/Seoul 시간대의 CronTime을 만든다', () => {
    const cronTime = createIndexCronTime('0 0 * * *');
    expect(INDEX_TIME_ZONE).toBe('Asia/Seoul');
    expect(cronTime).toBeInstanceOf(CronTime);
    expect(cronTime.timeZone).toBe('Asia/Seoul');
  });

  it('T-CRON-2 기본 일정은 KST 자정이고, after가 정확히 일정 시각이면 다음 날이다(엄격히 뒤)', () => {
    // KST 2026-10-09 12:00 → KST 10-10 00:00
    expect(nextIso('0 0 * * *', '2026-10-09T03:00:00Z')).toBe('2026-10-09T15:00:00.000Z');
    // ★ after가 정확히 일정 시각이면 같은 시각이 아니라 다음 날이다
    expect(nextIso('0 0 * * *', '2026-10-09T15:00:00Z')).toBe('2026-10-10T15:00:00.000Z');
  });

  it('T-CRON-3 다른 일정은 그 일정의 다음 KST 시각이다', () => {
    // KST 06:30 = UTC 21:30(전날). KST 2026-10-09 12:00 이후 첫 06:30은 KST 10-10 06:30
    expect(nextIso('30 6 * * *', '2026-10-09T03:00:00Z')).toBe('2026-10-09T21:30:00.000Z');
  });

  it('T-CRON-4 오지 않는 일정은 예외 없이 null이다', () => {
    expect(() => createIndexCronTime('0 0 31 2 *')).not.toThrow();
    expect(nextIso('0 0 31 2 *', '2026-10-09T03:00:00Z')).toBeNull();
  });
});

describe('REQ-BE-1.3.9', () => {
  it('T-CRON-5 KST 경계: 자정 직전은 그 자정, 자정을 막 지났으면 다음 날 자정이다', () => {
    expect(nextIso('0 0 * * *', '2026-10-09T14:59:59Z')).toBe('2026-10-09T15:00:00.000Z');
    expect(nextIso('0 0 * * *', '2026-10-09T15:00:00.001Z')).toBe('2026-10-10T15:00:00.000Z');
  });

  it('T-CRON-5b 결과는 Date이고 toIsoUtc 형식(밀리초 없이 Z로 끝나는 UTC)이다', () => {
    const next = nextIndexTime(createIndexCronTime('0 0 * * *'), new Date('2026-10-09T03:00:00Z'));
    expect(next).toBeInstanceOf(Date);
    // ★ 실제 toIsoUtc를 거친 값이 밀리초 없는 'YYYY-MM-DDTHH:mm:ssZ'다
    expect(next === null ? null : toIsoUtc(next)).toBe('2026-10-09T15:00:00Z');
  });
});
