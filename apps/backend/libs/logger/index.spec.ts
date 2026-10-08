import * as barrel from './index';
import { AppLoggerModule, REDACTED_LOG_PATHS } from './index';

describe('REQ-BE-8.2.1', () => {
  it('T-SURF 배럴의 값 export 이름이 공개 표면 목록과 정확히 같다', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'AppLoggerModule',
        'REDACTED_LOG_PATHS',
        'createLoggerParams',
        'createPinoHttpOptions',
        'scrubForbiddenKeys',
      ].sort(),
    );
  });

  it('AppLoggerModule이 클래스다', () => {
    expect(typeof AppLoggerModule).toBe('function');
  });

  it('REDACTED_LOG_PATHS가 배열이고 req.body를 담는다', () => {
    expect(Array.isArray(REDACTED_LOG_PATHS)).toBe(true);
    expect(REDACTED_LOG_PATHS).toContain('req.body');
  });
});
