import { kstDayRange } from './time';
import { InvalidRequestError } from '../interfaces/domain-errors';

/** KST 날짜 문자열 하루를 UTC 시각 범위로 바꾼다. 날짜가 틀리면 InvalidRequestError를 던진다. */
export function parseKstDayRange(day: string): { start: Date; end: Date } {
  try {
    return kstDayRange(day);
  } catch (error) {
    // ★ time의 kstDayRange는 도메인 오류를 모른다. 날짜 오류(RangeError)만 HTTP 400(INVALID_REQUEST)이 되도록 바꾼다
    if (error instanceof RangeError) {
      // ★ 오류 메시지에 입력값을 넣지 않는다
      throw new InvalidRequestError('날짜는 YYYY-MM-DD 형식이어야 합니다');
    }
    throw error;
  }
}
