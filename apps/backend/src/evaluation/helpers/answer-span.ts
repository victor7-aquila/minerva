/**
 * 자리표시 하나다 (루트 IF-1: `[[minerva:{kind}:{placeholder_id} | {description}]]`).
 * ★ assets helpers/placeholder.ts의 자리표시 형식과 같아야 한다. evaluation은 assets를 import할 수 없어 따로 둔다
 * ★ 캡처 그룹을 두지 않는다 — split 결과에 섞인다
 */
const PLACEHOLDER = /\[\[minerva:(?:table|image):[a-z0-9]+ \| [^\n]*?\]\]/;
/** 공백 문자(유니코드 공백, 줄바꿈 포함)다. */
const WHITESPACE = /\s+/g;

/** 공백 문자를 모두 지운다. */
export function stripWhitespace(text: string): string {
  return text.replace(WHITESPACE, '');
}

/** 정답 구간이 색인용 MD의 자리표시 사이 구역 하나 안에 있는지 본다. 공백 차이는 무시한다. */
export function containsAnswerSpan(indexingMarkdown: string, answerSpan: string): boolean {
  const needle = stripWhitespace(answerSpan);
  if (needle === '') return false;
  // ★ 자리표시 자리는 구간이 넘을 수 없는 경계다. 설명 글자는 어느 구역에도 남지 않는다
  return indexingMarkdown.split(PLACEHOLDER).some((zone) => stripWhitespace(zone).includes(needle));
}
