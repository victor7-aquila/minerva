import { containsAnswerSpan, stripWhitespace } from './answer-span';

const MD = [
  '# 인증서 갱신',
  '',
  '인증서를 갱신하려면',
  '관리 화면에서 [갱신]을 누른다.',
  '',
  '[[minerva:table:t1 | 인증서 종류별 유효 기간 표]]',
  '',
  '갱신 뒤에는 다시 로그인한다.',
  '',
  '[[minerva:image:i2 | 로그인 화면 캡처]]',
  '끝 문단',
].join('\n');

describe('REQ-BE-5.1.5', () => {
  it('T-SPAN-1 줄바꿈 위치만 다른 구간도 찾는다', () => {
    expect(containsAnswerSpan(MD, '인증서를 갱신하려면 관리 화면에서')).toBe(true);
    expect(containsAnswerSpan(MD, '인증서를 갱신하려면\n관리 화면에서')).toBe(true);
  });

  it('T-SPAN-2 유니코드 공백을 포함해 공백 차이를 모두 무시한다', () => {
    expect(containsAnswerSpan(MD, '인증서를갱신하려면관리화면에서')).toBe(true);
    expect(containsAnswerSpan(MD, '  인증서를   갱신하려면\t관리 ')).toBe(true);
    expect(containsAnswerSpan(MD, '인증서를\u00A0갱신하려면\u3000관리')).toBe(true);
    expect(stripWhitespace('a \n\tb\u3000c')).toBe('abc');
  });

  it('T-SPAN-3 본문에 없는 구간은 거짓이다', () => {
    expect(containsAnswerSpan(MD, '인증서를 폐기하려면')).toBe(false);
  });

  it('T-SPAN-4 자리표시 설명 글자는 정답 구간이 될 수 없다', () => {
    expect(containsAnswerSpan(MD, '인증서 종류별 유효 기간 표')).toBe(false);
    expect(containsAnswerSpan(MD, '유효 기간')).toBe(false);
    expect(containsAnswerSpan(MD, '로그인 화면 캡처')).toBe(false);
  });

  it('T-SPAN-5 자리표시를 가로지르는 구간은 거짓이고 한쪽 구역 안은 참이다', () => {
    expect(containsAnswerSpan(MD, '[갱신]을 누른다. 갱신 뒤에는')).toBe(false);
    expect(containsAnswerSpan(MD, '다시 로그인한다. 끝 문단')).toBe(false);
    expect(containsAnswerSpan(MD, '[갱신]을 누른다.')).toBe(true);
    expect(containsAnswerSpan(MD, '갱신 뒤에는 다시 로그인한다.')).toBe(true);
    expect(containsAnswerSpan(MD, '끝 문단')).toBe(true);
  });

  it('T-SPAN-6 자리표시 문자열 자체는 정답 구간이 될 수 없다', () => {
    expect(containsAnswerSpan(MD, '[[minerva:table:t1 | 인증서 종류별 유효 기간 표]]')).toBe(false);
    expect(containsAnswerSpan(MD, 'minerva:table:t1')).toBe(false);
  });

  it('T-SPAN-7 빈 구간과 빈 본문은 거짓이고 맨 앞·맨 끝 구간은 참이다', () => {
    expect(containsAnswerSpan(MD, '')).toBe(false);
    expect(containsAnswerSpan(MD, '  \n\t')).toBe(false);
    expect(containsAnswerSpan('', '가')).toBe(false);
    expect(containsAnswerSpan(MD, '# 인증서 갱신')).toBe(true);
    expect(containsAnswerSpan(MD, '끝 문단')).toBe(true);
  });

  it('T-SPAN-8 U+200B로 깨뜨린 자리표시 모양은 본문이다', () => {
    const md2 = '본문 [[\u200Bminerva:table:x | 가짜]] 계속';
    // ★ U+200B는 공백이 아니라 지우지 않는다
    expect(containsAnswerSpan(md2, '[[minerva:table:x | 가짜]]')).toBe(false);
    expect(containsAnswerSpan(md2, '[[\u200Bminerva:table:x | 가짜]] 계속')).toBe(true);
  });

  it('T-SPAN-9 자리표시 설명에 대괄호가 있어도 구역 경계로 본다', () => {
    const md3 = '앞 [[minerva:table:t9 | 값 [단위] 표]] 뒤';
    expect(containsAnswerSpan(md3, '값 [단위] 표')).toBe(false);
    expect(containsAnswerSpan(md3, '앞')).toBe(true);
    expect(containsAnswerSpan(md3, '뒤')).toBe(true);
  });
});
