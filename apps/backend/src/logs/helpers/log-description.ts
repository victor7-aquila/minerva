import type { ProcessingState } from '../../common';
import type { LogDetail, LogInput } from '../interfaces/logs.types';

/** 편집 필드 이름이다. */
type EditField = NonNullable<LogDetail['changedFields']>[number];

/** 처리 상태의 한국어 표시 이름이다. */
const STATE_LABELS: Readonly<Record<ProcessingState, string>> = {
  uploaded: '업로드됨',
  captioning: '요약·캡션 생성 중',
  queued: '색인 대기',
  indexing: '색인 중',
  completed: '완료',
  failed: '실패',
};

/** 편집 필드의 한국어 표시 이름이다. 표시 순서를 겸한다. */
const FIELD_LABELS: Readonly<Record<EditField, string>> = {
  name: '이름',
  edition: '판 정보',
  hints: '요약·캡션',
};

/** 표시 순서대로 나열한 편집 필드다. */
const FIELD_ORDER: readonly EditField[] = ['name', 'edition', 'hints'];

/** 사유 코드로 허용하는 형식이다. */
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 값이 없거나 맞지 않을 때 넣는 말이다. */
const UNKNOWN = '알 수 없음';

/** 앞말의 마지막 글자 받침 번호를 돌려준다. 한글 음절이 아니면 받침 없음(0)으로 본다. */
function finalConsonant(word: string): number {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return 0;
  return (code - 0xac00) % 28;
}

/** 앞말의 마지막 글자 받침으로 '로'/'으로'를 고른다. ㄹ 받침과 받침 없음은 '로'다. */
function withRo(word: string): string {
  const final = finalConsonant(word);
  return final === 0 || final === 8 ? `${word}로` : `${word}으로`;
}

/** 앞말의 마지막 글자 받침으로 '을'/'를'을 고른다. */
function withEul(word: string): string {
  return finalConsonant(word) === 0 ? `${word}를` : `${word}을`;
}

/** 0 이상의 안전한 정수면 문자열로, 아니면 '0'으로 바꾼다. */
function countText(value: number | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : '0';
}

/** 처리 상태의 표시 이름을 돌려준다. 모르는 값은 대체 말을 쓴다. */
function stateText(state: string | undefined): string {
  if (typeof state === 'string' && Object.hasOwn(STATE_LABELS, state)) {
    return STATE_LABELS[state as ProcessingState];
  }
  return UNKNOWN;
}

/** 사유 코드를 돌려준다. 형식에 맞지 않으면 대체 말을 쓴다. */
function reasonText(code: string | undefined): string {
  return typeof code === 'string' && REASON_CODE_PATTERN.test(code) ? code : UNKNOWN;
}

/** 편집 필드 표시 이름을 정해진 순서로 잇는다. 남는 것이 없으면 '항목'이다. */
function fieldsText(fields: LogDetail['changedFields']): string {
  const present = new Set<string>(Array.isArray(fields) ? fields : []);
  const labels = FIELD_ORDER.filter((field) => present.has(field)).map((f) => FIELD_LABELS[f]);
  return labels.length > 0 ? labels.join(', ') : '항목';
}

/** 기록 입력으로 한 줄 설명을 만든다. ★ 틀 문장과 LogDetail의 코드·개수·상태 이름만 쓴다 */
export function describeLog(input: Pick<LogInput, 'kind' | 'outcome' | 'detail'>): string {
  const ok = input.outcome === 'success';
  const detail = input.detail ?? {};
  switch (input.kind) {
    case 'upload':
      return ok ? '문서를 올렸습니다' : '문서를 올리지 못했습니다';
    case 'content_upload':
      return ok ? '내용을 다시 올렸습니다' : '내용을 다시 올리지 못했습니다';
    case 'captioning':
      return ok
        ? `요약·캡션 ${countText(detail.count)}개를 만들었습니다 (임시 설명 ${countText(detail.failedCount)}개)`
        : '요약·캡션을 만들지 못했습니다';
    case 'processing_state':
      return ok
        ? `처리 상태가 ${stateText(detail.fromState)}에서 ${withRo(stateText(detail.toState))} 바뀌었습니다`
        : `처리 상태가 ${stateText(detail.fromState)}에서 실패로 바뀌었습니다 (사유 ${reasonText(detail.reasonCode)})`;
    case 'edit':
      return ok
        ? `${withEul(fieldsText(detail.changedFields))} 고쳤습니다`
        : `${withEul(fieldsText(detail.changedFields))} 고치지 못했습니다`;
    case 'delete':
      return ok ? '문서를 삭제했습니다' : '문서 삭제를 마치지 못했습니다';
    case 'replace':
      return '같은 판의 다른 문서로 교체됐습니다';
  }
}
