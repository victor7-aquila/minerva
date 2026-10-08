import { InvalidRequestError } from '../interfaces/domain-errors';
import { parseKstDayRange } from './parse-kst-day-range';

describe('REQ-BE-8.4.1', () => {
  describe('T-TIME-2 parseKstDayRange는 KST 하루를 UTC [start, end)로 바꾼다', () => {
    it('2026-10-04는 UTC 10-03 15시부터 10-04 15시까지다', () => {
      const { start, end } = parseKstDayRange('2026-10-04');
      expect(start.toISOString()).toBe('2026-10-03T15:00:00.000Z');
      expect(end.toISOString()).toBe('2026-10-04T15:00:00.000Z');
    });
  });

  describe('T-TIME-3 날짜 형식이 아니면 InvalidRequestError', () => {
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
      expect(() => parseKstDayRange(input)).toThrow(InvalidRequestError);
      try {
        parseKstDayRange(input);
      } catch (e) {
        expect((e as InvalidRequestError).code).toBe('INVALID_REQUEST');
        if (input !== '') {
          expect((e as Error).message).not.toContain(input);
        }
      }
    });

    it('문자열이 아닌 입력도 거부한다', () => {
      expect(() => parseKstDayRange(undefined as any)).toThrow(InvalidRequestError);
      expect(() => parseKstDayRange(20261004 as any)).toThrow(InvalidRequestError);
    });
  });
});
