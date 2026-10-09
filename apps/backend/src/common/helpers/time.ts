/** KST는 UTC+9이며 일광 절약 시간이 없다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 하루의 밀리초다. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** YYYY-MM-DD 형식이다. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date를 UTC ISO 8601 문자열로 바꾼다. */
export function toIsoUtc(at: Date): string {
  // ★ API.md 「공통 규약」 예시(2026-10-04T05:05:31Z)와 같게 밀리초를 버린다
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** KST 날짜 문자열(YYYY-MM-DD) 하루를 UTC 시각 범위 [start, end)로 바꾼다. */
// ★ 형식·달력이 틀리면 RangeError를 던진다. 도메인 오류(InvalidRequestError)로 바꾸는 일은 호출하는 쪽(같은 모듈의 parseKstDayRange)이 한다
export function kstDayRange(day: string): { start: Date; end: Date } {
  // ★ 오류 메시지에 입력값을 넣지 않는다
  const invalid = (): RangeError => new RangeError('날짜는 YYYY-MM-DD 형식이어야 합니다');
  const matched = typeof day === 'string' ? DAY_PATTERN.exec(day) : null;
  if (matched === null) throw invalid();

  const y = Number(matched[1]);
  const m = Number(matched[2]);
  const dd = Number(matched[3]);
  // ★ Date.UTC는 0~99년을 1900년대로 바꾸므로 setUTCFullYear로 만든다
  const midnight = new Date(0);
  midnight.setUTCFullYear(y, m - 1, dd);
  // 2026-02-30, 2026-13-01처럼 넘치는 값은 날짜가 밀리므로 걸러낸다
  if (
    midnight.getUTCFullYear() !== y ||
    midnight.getUTCMonth() !== m - 1 ||
    midnight.getUTCDate() !== dd
  ) {
    throw invalid();
  }

  const start = new Date(midnight.getTime() - KST_OFFSET_MS);
  const end = new Date(start.getTime() + DAY_MS);
  return { start, end };
}
