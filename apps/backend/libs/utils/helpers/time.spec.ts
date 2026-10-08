import { kstDayRange, toIsoUtc } from './time';

describe('REQ-BE-8.4.1', () => {
  describe('T-TIME-1 toIsoUtc는 Z로 끝나는 UTC 문자열 [A]', () => {
    it('KST 시각을 UTC로 바꾸고 밀리초를 버린다', () => {
      expect(toIsoUtc(new Date('2026-10-04T14:05:31.789+09:00'))).toBe('2026-10-04T05:05:31Z');
    });

    it('UTC 자정을 그대로 표기한다', () => {
      expect(toIsoUtc(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('2026-01-01T00:00:00Z');
    });

    it('결과가 YYYY-MM-DDTHH:mm:ssZ 형식이다', () => {
      expect(toIsoUtc(new Date('2026-10-04T14:05:31.789+09:00'))).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    });

    it('다시 Date로 읽으면 초 단위로 내림한 시각과 같다', () => {
      const d = new Date('2026-10-04T14:05:31.789+09:00');
      expect(new Date(toIsoUtc(d)).getTime()).toBe(Math.floor(d.getTime() / 1000) * 1000);
    });
  });

  describe('T-TIME-2 kstDayRange는 KST 하루를 UTC [start, end)로 바꾼다', () => {
    it('2026-10-04는 UTC 10-03 15시부터 10-04 15시까지다', () => {
      const { start, end } = kstDayRange('2026-10-04');
      expect(start.toISOString()).toBe('2026-10-03T15:00:00.000Z');
      expect(end.toISOString()).toBe('2026-10-04T15:00:00.000Z');
      expect(end.getTime() - start.getTime()).toBe(86_400_000);
    });

    it('해·달 경계를 처리한다', () => {
      expect(kstDayRange('2026-01-01').start.toISOString()).toBe('2025-12-31T15:00:00.000Z');
      expect(kstDayRange('2026-12-31').end.toISOString()).toBe('2026-12-31T15:00:00.000Z');
    });

    it('윤일을 받는다', () => {
      expect(() => kstDayRange('2024-02-29')).not.toThrow();
    });

    it('반환 값이 Date 인스턴스다', () => {
      const { start, end } = kstDayRange('2026-10-04');
      expect(start).toBeInstanceOf(Date);
      expect(end).toBeInstanceOf(Date);
    });
  });

  describe('T-TIME-3 날짜 형식이 아니면 RangeError', () => {
    const invalid = [
      '2026-1-4',
      '20261004',
      '2026/10/04',
      '2026-10-04T00:00:00',
      '',
      ' 2026-10-04',
      '2026-10-04 ',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-02-29',
      '2026-04-31',
      'abcd-ef-gh',
    ];

    it.each(invalid)('%j 는 거부하고 메시지에 입력이 없다', (input) => {
      expect(() => kstDayRange(input)).toThrow(RangeError);
      try {
        kstDayRange(input);
      } catch (e) {
        expect((e as Error).name).toBe('RangeError');
        if (input !== '') {
          expect((e as Error).message).not.toContain(input);
        }
      }
    });

    it('문자열이 아닌 입력도 거부한다', () => {
      expect(() => kstDayRange(undefined as any)).toThrow(RangeError);
      expect(() => kstDayRange(20261004 as any)).toThrow(RangeError);
    });
  });
});
