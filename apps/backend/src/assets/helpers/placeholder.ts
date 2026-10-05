import type { AssetKind } from '../interfaces/assets.types';

/** 자리표시 ID 형식이다 (루트 IF-1). */
export const PLACEHOLDER_ID_PATTERN = /^[a-z0-9]+$/;

/**
 * 복원 정규식이다. 1·2번 그룹은 자리표시, 3번 그룹은 깨뜨린 문자열이다.
 * ★ g 정규식이므로 exec 루프로 쓰지 않고 replace·matchAll로만 쓴다
 */
const RESTORE_PATTERN =
  /\[\[minerva:(table|image):([a-z0-9]+) \| [^\n]*?\]\]|\[\[\u200B(\u200B*)minerva:/g;

/** 자리표시 문자열을 만든다. */
export function formatPlaceholder(
  kind: AssetKind,
  placeholderId: string,
  description: string,
): string {
  return `[[minerva:${kind}:${placeholderId} | ${description}]]`;
}

/** 자리표시 모양 문자열이 자리표시로 읽히지 않게 깨뜨린다. */
export function breakPlaceholderLike(text: string): string {
  return text.replace(/\[\[(\u200B*)minerva:/g, '[[\u200B$1minerva:');
}

/** 깨뜨린 문자열을 되돌린다. */
export function unbreakPlaceholderLike(text: string): string {
  return text.replace(/\[\[\u200B(\u200B*)minerva:/g, '[[$1minerva:');
}

/** 설명 끝의 `]`와 공백을 모두 뗀다. */
function trimTrailingBrackets(value: string): string {
  let current = value.trim();
  while (current.endsWith(']')) {
    current = current.replace(/\]+$/, '').trim();
  }
  return current;
}

/** 설명 원문을 IF-1 조건에 맞게 정리한다. 정리 결과에 글자·숫자가 없으면 fallback을 쓴다. */
export function sanitizeDescription(raw: string, fallback: string): string {
  const flattened = raw
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\]\]/g, ' ')
    .replace(/\s+/g, ' ');
  // ★ 끝이 `]`이면 `…]]]`에서 앞쪽 `]]`에서 자리표시가 끝난 것으로 읽힌다
  const cleaned = breakPlaceholderLike(trimTrailingBrackets(flattened));
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : fallback;
}

/** 이미지 대체 텍스트로 넣을 문장을 이스케이프한다. */
export function escapeImageAlt(text: string): string {
  // ★ `\`를 먼저 바꿔야 뒤에서 넣는 `\[`·`\]`의 `\`가 다시 바뀌지 않는다
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r\n|\r|\n/g, ' ');
}

/** 이미지 엔드포인트 경로를 만든다. */
export function imageUrlOf(docId: string, version: string, placeholderId: string): string {
  return `/v1/documents/${encodeURIComponent(docId)}/versions/${encodeURIComponent(version)}/assets/${encodeURIComponent(placeholderId)}`;
}

/** 복원에 쓰는 표·이미지 하나다. */
export interface RestoreSource {
  kind: AssetKind;
  tableMarkdown: string | null;
  /** 문장. hint가 없으면 description을 넣어 준다 */
  text: string;
  /** 짝이 있는 이미지면 주소, 아니면 null */
  imageUrl: string | null;
}

/** 본문에 든 자리표시 ID를 처음 나온 순서로 중복 없이 돌려준다. */
export function placeholderIdsIn(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(RESTORE_PATTERN)) {
    if (match[2] !== undefined) ids.add(match[2]);
  }
  return [...ids];
}

/** 본문의 자리표시를 원래 표·이미지로 바꾸고 깨뜨린 문자열을 되돌린다. */
export function restoreText(text: string, sources: ReadonlyMap<string, RestoreSource>): string {
  // ★ 한 번의 replace로 처리해야 바꿔 넣은 표·캡션 안의 글자를 다시 건드리지 않는다
  return text.replace(
    RESTORE_PATTERN,
    (match: string, kind?: string, id?: string, zeros?: string) => {
      if (kind === undefined || id === undefined) return `[[${zeros ?? ''}minerva:`;
      const source = sources.get(id);
      if (source === undefined || source.kind !== kind) return match;
      if (source.kind === 'table') return source.tableMarkdown ?? match;
      if (source.imageUrl === null) return source.text;
      return `![${escapeImageAlt(source.text)}](${source.imageUrl})`;
    },
  );
}
