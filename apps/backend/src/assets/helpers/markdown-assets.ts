import MarkdownIt from 'markdown-it';
import type { AssetKind, TextRange } from '../interfaces/assets.types';
import { fileNameOfPath } from './image-files';
import { breakPlaceholderLike, formatPlaceholder, sanitizeDescription } from './placeholder';

/** 원본 MD에서 찾은 표·이미지 하나다. start·end는 원문(markdown 인자) 기준 위치다. */
export interface ExtractedAsset {
  kind: AssetKind;
  placeholderId: string;
  order: number;
  /** 표 안 이미지는 자기 위치다. 위치를 모르면 그 표의 위치다 */
  start: number;
  end: number;
  tableMarkdown: string | null;
  imagePath: string | null;
  alt: string | null;
  description: string;
  /** 표 안 이미지면 그 표의 placeholderId, 아니면 null이다 */
  tableId: string | null;
  /** 표 안 이미지 경로 글자의 그 표 tableMarkdown 기준 위치다. 모르거나 경로가 표 밖이면 null이다 */
  pathInTable: TextRange | null;
}

/** 추출 결과다. assets는 표 바로 뒤에 그 표 안 이미지가 오는 순서다. */
export interface Extraction {
  assets: ExtractedAsset[];
  indexingMarkdown: string;
}

/** 규칙 함수가 토큰에 남기는 위치다. */
interface SourceMeta {
  srcStart: number;
  srcEnd: number;
}

/** 인라인 이미지의 링크 목적지 위치(인라인 내용 기준)를 더한 메모다. 참조형이면 둘 다 null이다. */
interface ImageMeta extends SourceMeta {
  destStart: number | null;
  destEnd: number | null;
}

/** GFM 표의 줄마다 내용 시작·끝 위치(정규화 기준)를 더한 메모다. 인덱스 0이 머리 행 줄이다. */
interface TableMeta extends SourceMeta {
  lineStarts: number[];
  lineEnds: number[];
}

/** 후보를 모으는 동안 쓰는 값이다. 위치는 정규화한 텍스트 기준이다. */
interface Candidate {
  kind: AssetKind;
  start: number;
  end: number;
  /** 설명 원문이다. 계산이 비싼 HTML 표는 받은 뒤에 계산하도록 함수로 둔다 */
  descriptionRaw: string | (() => string);
  imagePath: string | null;
  alt: string | null;
  /** 이미지 경로 글자 위치다. 모르면 null이다 */
  pathRange: TextRange | null;
  /** GFM 표가 칸에서 모은 이미지다. 표가 아니면 빈 배열이다 */
  nested: Candidate[];
}

/** 줄 대응 표다. 정규화한 텍스트와 원문의 줄 시작 위치를 갖는다. offset은 맨 앞 BOM 길이다. */
interface LineMap {
  normalized: string;
  normStarts: number[];
  origStarts: number[];
  hasCr: boolean;
  offset: number;
}

/** 인라인 내용 위치를 정규화 위치로 바꾼다. 못 바꾸면 null이다. */
type InlineMapper = (pos: number) => number | null;

/** 태그 하나다. 위치는 정규화 기준이다. */
interface HtmlTag {
  name: 'img' | 'table';
  closing: boolean;
  start: number;
  end: number;
  text: string;
}

/** 태그 속성 하나다. 위치는 태그 문자열 기준(값의 따옴표 안)이다. */
interface TagAttribute {
  value: string;
  valueStart: number;
  valueEnd: number;
}

/** 표 칸 하나다. positions[i]는 글자 i의 정규화 위치이고 길이는 content.length + 1이다. */
interface Cell {
  content: string;
  positions: number[];
}

/** 표(또는 최상위 이미지)와 그 안 이미지 후보다. */
interface Placed {
  candidate: Candidate;
  nested: Candidate[];
}

/** markdown-it 규칙 목록의 한 항목이다 (비공개 필드). */
interface RuleEntry<Fn> {
  name: string;
  fn: Fn;
  alt: string[];
}

/** markdown-it 인스턴스 타입이다. (모듈 방식에 따라 타입 이름이 달라 인스턴스에서 뽑는다) */
type Md = InstanceType<typeof MarkdownIt>;
type Token = ReturnType<Md['parse']>[number];
type InlineRule = Parameters<Md['inline']['ruler']['at']>[1];
type BlockRule = Parameters<Md['block']['ruler']['at']>[1];
type InlineState = Parameters<InlineRule>[0];

/** 규칙 목록에서 이름으로 규칙을 찾는다. ★ markdown-it 비공개 필드(__rules__)를 쓰므로 못 찾으면 로드 때 바로 오류를 낸다 */
function findRule<Fn>(ruler: unknown, name: string): RuleEntry<Fn> {
  const rules = (ruler as { __rules__?: Array<RuleEntry<Fn>> }).__rules__;
  const found = Array.isArray(rules) ? rules.find((rule) => rule.name === name) : undefined;
  if (found === undefined || typeof found.fn !== 'function' || !Array.isArray(found.alt)) {
    throw new Error(`markdown-it 규칙을 찾을 수 없습니다: ${name}`);
  }
  return found;
}

/** 인라인 규칙을 감싸 만든 토큰에 원문 위치(인라인 내용 기준)를 남긴다. */
function wrapInlineRule(md: Md, name: string): void {
  const rule = findRule<InlineRule>(md.inline.ruler, name);
  const original = rule.fn;
  const wrapped: InlineRule = (state, silent) => {
    const start = state.pos;
    const ok = original(state, silent);
    if (ok && !silent) {
      const token = state.tokens[state.tokens.length - 1];
      const meta: SourceMeta = { srcStart: start, srcEnd: state.pos };
      token.meta = { ...(token.meta as object | null), ...meta };
    }
    return ok;
  };
  // ★ alt를 넘기지 않으면 규칙이 대체 체인에서 빠진다
  md.inline.ruler.at(name, wrapped, { alt: rule.alt });
}

/** 인라인 이미지의 링크 목적지 위치를 구한다. 참조형이거나 못 구하면 null이다. */
function imageDestination(state: InlineState, start: number, end: number): TextRange | null {
  // ★ parseLinkLabel은 state.pos를 잠시 바꾸고 되돌린다. 원래 규칙이 끝난 뒤에 부른다
  const labelEnd = state.md.helpers.parseLinkLabel(state, start + 1, false);
  if (labelEnd < 0) return null;
  let pos = labelEnd + 1;
  if (state.src.charCodeAt(pos) !== 0x28 /* ( */) return null;
  pos += 1;
  while (pos < state.posMax && /[ \t\n]/.test(state.src[pos])) pos += 1;
  const res = state.md.helpers.parseLinkDestination(state.src, pos, state.posMax);
  // ★ 목적지 뒤에 이미지 끝이 더 있어야 인라인 형태다. 아니면 참조형이 `(`를 우연히 뒤따른 것이다
  if (!res.ok || res.pos <= pos || res.pos >= end) return null;
  return state.src.charCodeAt(pos) === 0x3c /* < */
    ? { start: pos + 1, end: res.pos - 1 }
    : { start: pos, end: res.pos };
}

/** image 규칙을 감싸 이미지 위치와 링크 목적지 위치를 남긴다. */
function wrapImageRule(md: Md): void {
  const rule = findRule<InlineRule>(md.inline.ruler, 'image');
  const original = rule.fn;
  const wrapped: InlineRule = (state, silent) => {
    const start = state.pos;
    const ok = original(state, silent);
    if (ok && !silent) {
      const token = state.tokens[state.tokens.length - 1];
      const dest = imageDestination(state, start, state.pos);
      const meta: ImageMeta = {
        srcStart: start,
        srcEnd: state.pos,
        destStart: dest?.start ?? null,
        destEnd: dest?.end ?? null,
      };
      token.meta = { ...(token.meta as object | null), ...meta };
    }
    return ok;
  };
  // ★ alt를 넘기지 않으면 규칙이 대체 체인에서 빠진다
  md.inline.ruler.at('image', wrapped, { alt: rule.alt });
}

/** 블록 규칙을 감싸 만든 첫 토큰에 원문 위치(정규화한 텍스트 기준)를 남긴다. */
function wrapBlockRule(md: Md, name: string, withLines: boolean): void {
  const rule = findRule<BlockRule>(md.block.ruler, name);
  const original = rule.fn;
  const wrapped: BlockRule = (state, startLine, endLine, silent) => {
    const at = state.tokens.length;
    const ok = original(state, startLine, endLine, silent);
    if (ok && !silent) {
      const meta: SourceMeta & Partial<TableMeta> = {
        srcStart: state.bMarks[startLine] + state.tShift[startLine],
        srcEnd: state.eMarks[state.line - 1],
      };
      if (withLines) {
        meta.lineStarts = [];
        meta.lineEnds = [];
        for (let line = startLine; line < state.line; line += 1) {
          meta.lineStarts.push(state.bMarks[line] + state.tShift[line]);
          meta.lineEnds.push(state.eMarks[line]);
        }
      }
      state.tokens[at].meta = meta;
    }
    return ok;
  };
  // ★ alt를 넘기지 않으면 표가 문단을 끊지 못한다
  md.block.ruler.at(name, wrapped, { alt: rule.alt });
}

/** 추출용 markdown-it 인스턴스를 만든다. */
function createParser(): Md {
  const md = new MarkdownIt({ html: true });
  // ★ 경로를 MD에 적힌 그대로 얻기 위해 퍼센트 인코딩과 스킴 검사를 끈다
  md.normalizeLink = (url) => url;
  md.validateLink = () => true;
  wrapImageRule(md);
  wrapInlineRule(md, 'html_inline');
  wrapBlockRule(md, 'table', true);
  wrapBlockRule(md, 'html_block', false);
  return md;
}

const parser = createParser();

/** 토큰의 위치 메모를 읽는다. 없으면 null이다. */
function metaOf(token: Token): SourceMeta | null {
  const meta = token.meta as Partial<SourceMeta> | null;
  if (meta === null || typeof meta?.srcStart !== 'number' || typeof meta.srcEnd !== 'number') {
    return null;
  }
  return { srcStart: meta.srcStart, srcEnd: meta.srcEnd };
}

/** 표 토큰의 줄 메모를 읽는다. 없으면 null이다. */
function tableMetaOf(token: Token): TableMeta | null {
  const meta = token.meta as Partial<TableMeta> | null;
  const base = metaOf(token);
  if (base === null || !Array.isArray(meta?.lineStarts) || !Array.isArray(meta.lineEnds)) {
    return null;
  }
  return { ...base, lineStarts: meta.lineStarts, lineEnds: meta.lineEnds };
}

/** 이미지 토큰의 링크 목적지 위치를 읽는다. 없으면 null이다. */
function destOf(token: Token): { start: number; end: number } | null {
  const meta = token.meta as Partial<ImageMeta> | null;
  if (typeof meta?.destStart !== 'number' || typeof meta.destEnd !== 'number') return null;
  return { start: meta.destStart, end: meta.destEnd };
}

/** 문자열에서 줄 시작 위치 목록을 만든다. */
function lineStarts(text: string, pattern: RegExp): number[] {
  const starts = [0];
  for (const match of text.matchAll(pattern)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/** 원문을 파서가 보는 텍스트로 바꾸고 줄 대응 표를 만든다. */
function buildLineMap(markdown: string): LineMap {
  // ★ 맨 앞 BOM은 떼고 파싱한다. 남기면 BOM 뒤 첫 블록(표·코드 펜스)의 판별이 어긋난다
  const offset = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = markdown.slice(offset);
  const normalized = body.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  return {
    normalized,
    normStarts: lineStarts(normalized, /\n/g),
    origStarts: lineStarts(body, /\r\n|\r|\n/g),
    hasCr: body.includes('\r'),
    offset,
  };
}

/** 정규화한 위치를 원문 위치로 바꾼다. */
function toOriginal(map: LineMap, pos: number): number {
  if (!map.hasCr) return pos + map.offset;
  let low = 0;
  let high = map.normStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (map.normStarts[mid] <= pos) low = mid;
    else high = mid - 1;
  }
  return map.origStarts[low] + (pos - map.normStarts[low]) + map.offset;
}

/** 정규화한 텍스트의 한 줄 내용을 돌려준다. */
function lineText(map: LineMap, line: number): string {
  const start = map.normStarts[line];
  if (start === undefined) return '';
  const next = map.normStarts[line + 1];
  return map.normalized.slice(start, next === undefined ? undefined : next - 1);
}

/** 줄 안에서 인라인 줄 내용이 시작하는 위치를 찾는다. 못 찾으면 null이다. */
function baseInLine(raw: string, content: string): number | null {
  if (raw.endsWith(content)) return raw.length - content.length;
  const trimmedEnd = raw.trimEnd();
  if (trimmedEnd.endsWith(content)) return trimmedEnd.length - content.length;
  const last = raw.lastIndexOf(content);
  if (last >= 0) return last;
  const stripped = content.trimStart();
  const lastStripped = raw.lastIndexOf(stripped);
  if (lastStripped >= 0) return lastStripped - (content.length - stripped.length);
  return null;
}

/** 문단 인라인 토큰의 위치 대응을 만든다. ★ 토큰마다 한 번만 만든다 — 줄 기준 위치를 줄당 한 번만 구한다 */
function paragraphMapper(map: LineMap, token: Token): InlineMapper {
  const first = token.map?.[0];
  if (first === undefined) return () => null;
  const contentLines = token.content.split('\n');
  const acc: number[] = [];
  let sum = 0;
  for (const content of contentLines) {
    acc.push(sum);
    sum += content.length + 1;
  }
  const bases: Array<number | null | undefined> = contentLines.map(() => undefined);
  return (pos) => {
    if (pos < 0) return null;
    // 위치가 속한 줄: acc[i] <= pos인 가장 큰 i (줄 끝 위치도 그 줄에 속한다)
    let low = 0;
    let high = contentLines.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (acc[mid] <= pos) low = mid;
      else high = mid - 1;
    }
    if (pos > acc[low] + contentLines[low].length) return null;
    let base = bases[low];
    if (base === undefined) {
      base = baseInLine(lineText(map, first + low), contentLines[low]);
      bases[low] = base;
    }
    if (base === null || map.normStarts[first + low] === undefined) return null;
    return map.normStarts[first + low] + base + (pos - acc[low]);
  };
}

/** 칸 안 위치 대응을 만든다. */
function cellMapper(cell: Cell | undefined, token: Token): InlineMapper {
  // ★ 칸을 맞출 수 없으면(내용이 다르면) 항상 null이다 — 짝 맞추기·저장은 그대로 하고 위치만 모른다
  if (cell === undefined || cell.content !== token.content) return () => null;
  return (pos) => (pos >= 0 && pos <= cell.content.length ? (cell.positions[pos] ?? null) : null);
}

/** 인라인 자식이 이미지 후보인가를 본다. */
function isImageChild(child: Token): boolean {
  return (
    child.type === 'image' || (child.type === 'html_inline' && IMG_TAG_HEAD.test(child.content))
  );
}

/** `<img` 태그로 시작하는가를 보는 정규식이다. */
const IMG_TAG_HEAD = /^<img(?=[\s/>]|$)/i;

/** 인라인 토큰에 이미지 자식이 있는가를 본다. */
function hasImageChild(token: Token): boolean {
  return (token.children ?? []).some(isImageChild);
}

/**
 * 태그 속성 부분이다. ★ 따옴표가 닫히지 않아도 끝까지 한 번에 소비해 다시 훑지 않는다
 * ★ 따옴표 밖의 `<`에서 멈춘다 — 닫히지 않은 `<img` 뒤에 오는 `<table>`이 그 태그에 삼켜지지 않게 한다(그 `<img`는 태그가 아니다)
 */
const ATTRS = `(?:[^<>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*`;
/** 주석, raw text 요소, img·table 태그를 차례로 찾는 정규식이다. ★ g 정규식이므로 matchAll로만 쓴다 */
const HTML_SCAN = new RegExp(
  [
    '<!--(?:[\\s\\S]*?-->|[\\s\\S]*$)',
    `<(script|style|textarea)(?=[\\s/>]|$)${ATTRS}(?:>|$)(?:[\\s\\S]*?<\\/\\1\\s*>|[\\s\\S]*$)`,
    `<(\\/?)(img|table)(?=[\\s/>]|$)${ATTRS}(>|$)`,
  ].join('|'),
  'gi',
);

/** text[from, to) 안의 img·table 태그를 차례로 모은다. 주석·raw text 안과 닫히지 않은 태그는 건너뛴다. */
function scanHtmlTags(text: string, from: number, to: number): HtmlTag[] {
  const found: HtmlTag[] = [];
  for (const match of text.slice(from, to).matchAll(HTML_SCAN)) {
    // 셋째 갈래이고 `>`로 끝난 것만 태그다
    if (match[3] === undefined || match[4] !== '>') continue;
    const name = match[3].toLowerCase();
    const closing = match[2] === '/';
    if (name === 'img' && closing) continue;
    found.push({
      name: name as 'img' | 'table',
      closing,
      start: from + match.index,
      end: from + match.index + match[0].length,
      text: match[0],
    });
  }
  return found;
}

/**
 * `html_block` 토큰들의 범위를 문서 순서대로 모은다.
 * ★ 코드 블록(펜스·들여쓰기)은 훑지 않고 짝도 끊지 않는다 — 칸 안 코드 블록 때문에 HTML 블록이 끊겨도
 *   닫는 </table>까지 표 하나다 (REQ-BE-2.1.1). 코드 블록 안의 </table>은 html_block이 아니라 짝이 아니다
 */
function htmlBlockRanges(tokens: Token[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const token of tokens) {
    if (token.type !== 'html_block') continue;
    const meta = metaOf(token);
    if (meta !== null) ranges.push({ start: meta.srcStart, end: meta.srcEnd });
  }
  return ranges;
}

/**
 * HTML 표의 여는 태그 시작 → 닫는 태그 끝을 짝짓는다.
 * ★ 문단·인라인 코드의 글(`<script>` 같은 낱말)이 짝을 깨지 않게 표 후보가 나오는 `html_block` 범위만 훑는다
 */
function htmlTablePairs(text: string, blocks: readonly TextRange[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (const block of blocks) {
    for (const tag of scanHtmlTags(text, block.start, block.end)) {
      if (tag.name !== 'table') continue;
      if (!tag.closing) {
        stack.push(tag.start);
        continue;
      }
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, tag.end);
    }
  }
  return pairs;
}

/** 속성 이름이다. */
const ATTR_NAME = /[^\s"'>/=]+/y;
/** 속성 이름 뒤의 `=`이다. */
const ATTR_EQUALS = /\s*=\s*/y;
/** 따옴표 없는 속성 값이다. */
const ATTR_UNQUOTED = /[^\s"'=<>`]+/y;

/** 태그 문자열의 속성을 읽는다. 같은 이름은 처음 것만 쓴다. */
function parseTagAttributes(tag: string): Map<string, TagAttribute> {
  const attrs = new Map<string, TagAttribute>();
  const head = /^<[^\s/>]*/.exec(tag);
  let pos = head === null ? 0 : head[0].length;
  while (pos < tag.length) {
    while (pos < tag.length && (/\s/.test(tag[pos]) || tag[pos] === '/')) pos += 1;
    if (pos >= tag.length || tag[pos] === '>') break;
    ATTR_NAME.lastIndex = pos;
    const name = ATTR_NAME.exec(tag);
    if (name === null) {
      pos += 1;
      continue;
    }
    pos += name[0].length;
    let attribute: TagAttribute = { value: '', valueStart: pos, valueEnd: pos };
    ATTR_EQUALS.lastIndex = pos;
    if (ATTR_EQUALS.exec(tag) !== null) {
      pos = ATTR_EQUALS.lastIndex;
      const quote = tag[pos];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, pos + 1);
        const valueEnd = close < 0 ? tag.length : close;
        attribute = {
          value: tag.slice(pos + 1, valueEnd),
          valueStart: pos + 1,
          valueEnd,
        };
        pos = close < 0 ? tag.length : close + 1;
      } else {
        ATTR_UNQUOTED.lastIndex = pos;
        const raw = ATTR_UNQUOTED.exec(tag);
        const length = raw === null ? 0 : raw[0].length;
        attribute = { value: raw?.[0] ?? '', valueStart: pos, valueEnd: pos + length };
        pos += length;
      }
    }
    const key = name[0].toLowerCase();
    if (!attrs.has(key)) attrs.set(key, attribute);
  }
  return attrs;
}

/** HTML 속성 값의 문자 참조를 푼다. ★ 역슬래시를 문자 참조로 바꿔 두어 백슬래시 이스케이프는 풀지 않는다 */
function decodeAttr(value: string): string {
  return parser.utils.unescapeAll(value.replace(/\\/g, '&#92;'));
}

/** `<img>` 태그 하나를 이미지 후보로 만든다. src가 없으면 null이다. 위치는 mapStart·mapEnd가 정한다. */
function htmlImageCandidate(
  tag: string,
  place: { start: number; end: number; pathStart: number | null; pathEnd: number | null },
): Candidate | null {
  const attrs = parseTagAttributes(tag);
  const src = attrs.get('src');
  if (src === undefined) return null;
  const alt = attrs.get('alt');
  return {
    kind: 'image',
    start: place.start,
    end: place.end,
    descriptionRaw: '',
    imagePath: decodeAttr(src.value),
    alt: alt === undefined ? null : decodeAttr(alt.value),
    pathRange:
      place.pathStart === null || place.pathEnd === null
        ? null
        : { start: place.pathStart, end: place.pathEnd },
    nested: [],
  };
}

/** 인라인 토큰 하나(최상위 자식만)에서 이미지 후보를 모은다. */
function inlineImageCandidates(
  token: Token,
  mapper: InlineMapper,
  keepUnmapped: boolean,
): Candidate[] {
  const found: Candidate[] = [];
  for (const child of token.children ?? []) {
    if (!isImageChild(child)) continue;
    const meta = metaOf(child);
    if (meta === null) continue;
    const start = mapper(meta.srcStart);
    const end = mapper(meta.srcEnd);
    // ★ 위치를 원문에 대응시키지 못하면 문단에서는 등록하지 않고 원문 그대로 둔다
    if ((start === null || end === null) && !keepUnmapped) continue;
    const place = { start: start ?? -1, end: end ?? -1 };
    if (child.type === 'image') {
      const dest = destOf(child);
      const pathStart = dest === null ? null : mapper(dest.start);
      const pathEnd = dest === null ? null : mapper(dest.end);
      found.push({
        kind: 'image',
        ...place,
        descriptionRaw: '',
        imagePath: child.attrGet('src') ?? '',
        alt: parser.renderer.renderInlineAsText(child.children ?? [], parser.options, {}),
        pathRange:
          pathStart === null || pathEnd === null ? null : { start: pathStart, end: pathEnd },
        nested: [],
      });
      continue;
    }
    const src = parseTagAttributes(child.content).get('src');
    if (src === undefined) continue;
    const pathStart = mapper(meta.srcStart + src.valueStart);
    const pathEnd = mapper(meta.srcStart + src.valueEnd);
    const candidate = htmlImageCandidate(child.content, {
      ...place,
      pathStart,
      pathEnd,
    });
    if (candidate !== null) found.push(candidate);
  }
  return found;
}

/** 표 줄 하나를 칸으로 나눈다. ★ markdown-it table 규칙과 같은 순서이고, 칸 글자마다 정규화 위치를 함께 만든다 */
function splitRowCells(text: string, lineStart: number, lineEnd: number): Cell[] {
  const raw = text.slice(lineStart, lineEnd);
  const base = lineStart + (raw.length - raw.trimStart().length);
  const line = raw.trim();
  const cells: number[][] = [];
  let current: number[] = [];
  let lastPos = 0;
  let isEscaped = false;
  const pushRange = (target: number[], from: number, to: number): void => {
    for (let at = from; at < to; at += 1) target.push(at);
  };
  for (let pos = 0; pos < line.length; pos += 1) {
    const ch = line.charCodeAt(pos);
    if (ch === 0x7c /* | */) {
      if (!isEscaped) {
        pushRange(current, lastPos, pos);
        cells.push(current);
        current = [];
        lastPos = pos + 1;
      } else {
        // 이스케이프된 `\|`는 `\`를 빼고 `|`를 남긴다
        pushRange(current, lastPos, pos - 1);
        lastPos = pos;
      }
    }
    isEscaped = ch === 0x5c; /* \ */
  }
  pushRange(current, lastPos, line.length);
  cells.push(current);
  if (cells.length > 0 && cells[0].length === 0) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].length === 0) cells.pop();
  return cells.map((indexes) => {
    const joined = indexes.map((at) => line[at]).join('');
    const lead = joined.length - joined.trimStart().length;
    const trail = joined.length - joined.trimEnd().length;
    const kept = indexes.slice(lead, indexes.length - trail);
    const content = kept.map((at) => line[at]).join('');
    if (kept.length === 0) return { content, positions: [base + (indexes[0] ?? 0)] };
    const positions = kept.map((at) => base + at);
    positions.push(base + kept[kept.length - 1] + 1);
    return { content, positions };
  });
}

/** GFM 표 하나를 후보로 만든다. 머리 칸 원문을 쉼표로 이어 설명 원문으로 쓰고, 칸 안 이미지를 모은다. */
function gfmTableCandidate(
  map: LineMap,
  tokens: Token[],
  index: number,
): { candidate: Candidate | null; next: number } {
  const open = tokens[index];
  const meta = tableMetaOf(open);
  const firstLine = open.map?.[0];
  if (meta === null || firstLine === undefined) return { candidate: null, next: index + 1 };
  const heads: string[] = [];
  const nested: Candidate[] = [];
  let inHead = true;
  let rowLine = firstLine;
  let cells: Cell[] | undefined;
  let cellNo = 0;
  let at = index + 1;
  for (; at < tokens.length && tokens[at].type !== 'table_close'; at += 1) {
    const token = tokens[at];
    if (token.type === 'thead_close') inHead = false;
    if (token.type === 'tr_open') {
      rowLine = token.map?.[0] ?? rowLine;
      cells = undefined;
      cellNo = 0;
    } else if (token.type === 'inline') {
      if (inHead && token.content.trim() !== '') heads.push(token.content.trim());
      if (hasImageChild(token)) {
        const lineAt = rowLine - firstLine;
        cells ??= splitRowCells(map.normalized, meta.lineStarts[lineAt], meta.lineEnds[lineAt]);
        // ★ 펼침 push는 인자 수만큼 호출 스택을 쓰므로 반복문으로 넣는다
        for (const image of inlineImageCandidates(token, cellMapper(cells[cellNo], token), true)) {
          nested.push(image);
        }
      }
      cellNo += 1;
    }
  }
  return {
    candidate: {
      kind: 'table',
      start: meta.srcStart,
      end: meta.srcEnd,
      descriptionRaw: heads.join(', '),
      imagePath: null,
      alt: null,
      pathRange: null,
      nested,
    },
    next: at + 1,
  };
}

/** 여는 태그 머리(`<tr`, `<th`·`<td`)를 찾는 정규식이다. ★ g 정규식이며 lastIndex로 앞에서부터만 훑는다 */
const TR_OPEN = /<tr\b/gi;
const CELL_OPEN = /<t[hd]\b/gi;
const TR_CLOSE = /<\/tr>/gi;
const CELL_CLOSE = /<\/t[hd]>/gi;

/** 정규식을 from부터 한 번 찾아 시작 위치와 끝 위치를 돌려준다. 없으면 null이다. */
function findFrom(pattern: RegExp, text: string, from: number): { at: number; end: number } | null {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match === null ? null : { at: match.index, end: match.index + match[0].length };
}

/** `<…>` 태그를 지운 글자를 돌려준다. ★ `>`가 없으면 그 뒤 `<`도 모두 글자로 남기므로 한 번만 앞으로 훑는다 */
function stripTags(text: string): string {
  let out = '';
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf('<', pos);
    if (open < 0) break;
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    out += text.slice(pos, open);
    pos = close + 1;
  }
  return out + text.slice(pos);
}

/**
 * HTML 표 첫 행의 칸 텍스트를 쉼표로 이어 설명 원문을 만든다.
 * ★ 닫는 태그가 없을 때 되돌아 훑지 않는다 — 앞의 태그가 닫히지 않으면 뒤의 태그도 닫히지 않으므로 거기서 멈춘다
 */
function htmlTableHeads(tableHtml: string): string {
  const rowOpen = findFrom(TR_OPEN, tableHtml, 0);
  if (rowOpen === null) return '';
  const rowTagEnd = tableHtml.indexOf('>', rowOpen.end);
  if (rowTagEnd < 0) return '';
  const rowClose = findFrom(TR_CLOSE, tableHtml, rowTagEnd + 1);
  if (rowClose === null) return '';
  const row = tableHtml.slice(rowTagEnd + 1, rowClose.at);
  const heads: string[] = [];
  let pos = 0;
  for (;;) {
    const open = findFrom(CELL_OPEN, row, pos);
    if (open === null) break;
    const tagEnd = row.indexOf('>', open.end);
    if (tagEnd < 0) break;
    const close = findFrom(CELL_CLOSE, row, tagEnd + 1);
    if (close === null) break;
    const text = stripTags(row.slice(tagEnd + 1, close.at)).trim();
    if (text !== '') heads.push(text);
    pos = close.end;
  }
  return heads.join(', ');
}

/**
 * 블록 전체를 표·이미지로 보지 않는 `<pre>` 블록의 시작 태그다. ★ 태그 이름 경계로 본다(`<preview>`는 아니다).
 * 주석·script·style·textarea는 블록을 건너뛰지 않는다 — scanHtmlTags가 그 안만 건너뛴다
 */
const PRE_BLOCK_HEAD = /^<pre(?=[\s/>]|$)/i;

/** `html_block` 하나에서 후보를 모은다. ★ 블록 전체를 훑는다 — `</table>` 뒤의 태그도 후보다 */
function htmlBlockCandidates(
  map: LineMap,
  token: Token,
  pairs: ReadonlyMap<number, number>,
): Candidate[] {
  const meta = metaOf(token);
  if (meta === null) return [];
  const head = token.content.trimStart();
  if (PRE_BLOCK_HEAD.test(head)) return [];
  const found: Candidate[] = [];
  for (const tag of scanHtmlTags(map.normalized, meta.srcStart, meta.srcEnd)) {
    if (tag.name === 'table') {
      if (tag.closing) continue;
      const end = pairs.get(tag.start) ?? meta.srcEnd;
      found.push({
        kind: 'table',
        start: tag.start,
        end,
        // ★ 받은 표에만 설명을 계산하도록 미룬다 — 후보마다 계산하면 겹친 표 때문에 제곱이 된다
        descriptionRaw: () => htmlTableHeads(map.normalized.slice(tag.start, end)),
        imagePath: null,
        alt: null,
        pathRange: null,
        nested: [],
      });
      continue;
    }
    const src = parseTagAttributes(tag.text).get('src');
    const candidate = htmlImageCandidate(tag.text, {
      start: tag.start,
      end: tag.end,
      pathStart: src === undefined ? null : tag.start + src.valueStart,
      pathEnd: src === undefined ? null : tag.start + src.valueEnd,
    });
    if (candidate !== null) found.push(candidate);
  }
  return found;
}

/** 토큰 목록에서 표·이미지 후보를 모은다. */
function collectCandidates(map: LineMap, tokens: Token[]): Candidate[] {
  const found: Candidate[] = [];
  let pairs: Map<number, number> | undefined;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (token.type === 'table_open') {
      const { candidate, next } = gfmTableCandidate(map, tokens, index);
      if (candidate !== null) {
        found.push(candidate);
        index = next;
        continue;
      }
    } else if (token.type === 'html_block') {
      // ★ 표 짝은 html_block 범위들에서 한 번만 구한다
      pairs ??= htmlTablePairs(map.normalized, htmlBlockRanges(tokens));
      // ★ 펼침 push는 후보가 많으면 호출 스택을 넘기므로 반복문으로 넣는다
      for (const candidate of htmlBlockCandidates(map, token, pairs)) found.push(candidate);
    } else if (token.type === 'inline' && token.map !== null && hasImageChild(token)) {
      for (const candidate of inlineImageCandidates(token, paragraphMapper(map, token), false)) {
        found.push(candidate);
      }
    }
    index += 1;
  }
  return found;
}

/** 위치 순서로 쓰는 키다. 위치를 모르는 칸 이미지(-1)는 표 위치로 본다. */
function sortKey(candidate: Candidate, table: Candidate): number {
  return candidate.start === -1 ? table.start : candidate.start;
}

/** start 이하인 마지막 표의 인덱스를 이분 탐색으로 찾는다. 없으면 -1이다. */
function lastTableAtOrBefore(tables: readonly Placed[], start: number): number {
  let low = 0;
  let high = tables.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (tables[mid].candidate.start <= start) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** 후보를 표(와 그 안 이미지)·최상위 이미지로 나눠 원본 순서로 놓는다. 겹치는 후보는 버린다. */
function placeCandidates(candidates: Candidate[]): Placed[] {
  const tables = candidates
    .filter((candidate) => candidate.kind === 'table')
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: Placed[] = [];
  let tableEnd = -1;
  for (const table of tables) {
    const last = accepted[accepted.length - 1];
    if (last !== undefined && table.start < tableEnd) {
      // 겹친 표는 버리고 그 안 이미지는 받은 표로 옮긴다
      for (const item of table.nested) last.nested.push(item);
      continue;
    }
    accepted.push({ candidate: table, nested: [...table.nested] });
    tableEnd = table.end;
  }

  const images = candidates
    .filter((candidate) => candidate.kind === 'image')
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const tops: Candidate[] = [];
  let imageEnd = -1;
  for (const image of images) {
    const at = lastTableAtOrBefore(accepted, image.start);
    if (at >= 0 && image.start < accepted[at].candidate.end) {
      // 표가 이미지 범위를 완전히 담으면 표 안 이미지이고, 일부만 겹치면 버린다
      if (image.end <= accepted[at].candidate.end) accepted[at].nested.push(image);
      continue;
    }
    // ★ 표를 우선한다 — 표 시작을 넘어 겹치는 이미지는 버린다 (표와 표 안 이미지를 잃지 않는다)
    const nextTable = accepted[at + 1];
    if (nextTable !== undefined && image.end > nextTable.candidate.start) continue;
    if (image.start < imageEnd) continue;
    tops.push(image);
    imageEnd = image.end;
  }

  const merged: Placed[] = [
    ...accepted.map(({ candidate, nested }) => ({
      candidate,
      nested: [...nested].sort((a, b) => sortKey(a, candidate) - sortKey(b, candidate)),
    })),
    ...tops.map((candidate) => ({ candidate, nested: [] })),
  ].sort((a, b) => a.candidate.start - b.candidate.start);
  const result: Placed[] = [];
  let lastEnd = -1;
  for (const item of merged) {
    // ★ 표와 그 안 이미지를 깨진 이미지 후보 하나 때문에 잃지 않는다. 위 검사로 표와 겹치는 이미지는 이미 빠졌다
    if (item.candidate.start < lastEnd && item.candidate.kind === 'image') continue;
    result.push(item);
    lastEnd = item.candidate.end;
  }
  return result;
}

/** 후보의 자리표시 설명을 정한다. */
function describeCandidate(candidate: Candidate): string {
  if (candidate.kind === 'table') {
    const raw = candidate.descriptionRaw;
    return sanitizeDescription(typeof raw === 'function' ? raw() : raw, '표');
  }
  const alt = candidate.alt?.trim() ?? '';
  const source = alt !== '' ? alt : fileNameOfPath(candidate.imagePath ?? '');
  return sanitizeDescription(source, '이미지');
}

/** 종류별 순번으로 자리표시 ID를 만든다. */
function nextId(counters: Record<AssetKind, number>, kind: AssetKind): string {
  counters[kind] += 1;
  return `${kind === 'table' ? 't' : 'i'}${counters[kind]}`;
}

/** 표 안 이미지 후보들을 ExtractedAsset으로 만든다. 색인용 MD에는 넣지 않는다. */
function nestedAssets(
  map: LineMap,
  table: ExtractedAsset,
  nested: readonly Candidate[],
  counters: Record<AssetKind, number>,
  firstOrder: number,
): ExtractedAsset[] {
  return nested.map((candidate, index) => {
    const located = candidate.start !== -1 && candidate.end !== -1;
    let pathInTable: TextRange | null = null;
    if (candidate.pathRange !== null) {
      const start = toOriginal(map, candidate.pathRange.start) - table.start;
      const end = toOriginal(map, candidate.pathRange.end) - table.start;
      const length = table.tableMarkdown?.length ?? 0;
      if (start >= 0 && start <= end && end <= length) pathInTable = { start, end };
    }
    const alt = candidate.alt === null || candidate.alt.trim() === '' ? null : candidate.alt;
    return {
      kind: 'image',
      placeholderId: nextId(counters, 'image'),
      order: firstOrder + index,
      start: located ? toOriginal(map, candidate.start) : table.start,
      end: located ? toOriginal(map, candidate.end) : table.end,
      tableMarkdown: null,
      imagePath: candidate.imagePath,
      alt,
      description: describeCandidate(candidate),
      tableId: table.placeholderId,
      pathInTable,
    };
  });
}

/** 원본 MD에서 표·이미지를 찾아 자리표시로 바꾼 색인용 MD를 만든다. */
export function extractAssets(markdown: string): Extraction {
  const map = buildLineMap(markdown);
  const tokens = parser.parse(map.normalized, {});
  const placed = placeCandidates(collectCandidates(map, tokens));

  const counters: Record<AssetKind, number> = { table: 0, image: 0 };
  const assets: ExtractedAsset[] = [];
  let indexingMarkdown = '';
  let cursor = 0;
  for (const { candidate, nested } of placed) {
    const start = toOriginal(map, candidate.start);
    const end = toOriginal(map, candidate.end);
    const placeholderId = nextId(counters, candidate.kind);
    const description = describeCandidate(candidate);
    const alt = candidate.alt === null || candidate.alt.trim() === '' ? null : candidate.alt;
    const asset: ExtractedAsset = {
      kind: candidate.kind,
      placeholderId,
      order: assets.length + 1,
      start,
      end,
      tableMarkdown: candidate.kind === 'table' ? markdown.slice(start, end) : null,
      imagePath: candidate.imagePath,
      alt,
      description,
      tableId: null,
      pathInTable: null,
    };
    assets.push(asset);
    // ★ 칸 안 이미지가 많아도 호출 스택을 넘기지 않도록 반복문으로 넣는다
    for (const child of nestedAssets(map, asset, nested, counters, assets.length + 1)) {
      assets.push(child);
    }
    // ★ 만든 자리표시에는 깨뜨리기를 적용하지 않는다
    indexingMarkdown += breakPlaceholderLike(markdown.slice(cursor, start));
    indexingMarkdown += formatPlaceholder(candidate.kind, placeholderId, description);
    cursor = end;
  }
  indexingMarkdown += breakPlaceholderLike(markdown.slice(cursor));
  return { assets, indexingMarkdown };
}

/** GFM 구분 행이다. */
const GFM_DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/;

/** 인용문·목록 안 표의 둘째 줄부터 붙은 블록 접두를 뗀 표를 돌려준다. ★ 저장값은 바꾸지 않는다 */
export function tableForDisplay(tableMarkdown: string): string {
  const lines = tableMarkdown.split('\n');
  if (lines.length < 2) return tableMarkdown;
  const rest = lines.slice(1);
  if (GFM_DELIMITER_ROW.test(rest[0].replace(/^[ \t>]*/, ''))) {
    return [lines[0], ...rest.map((line) => line.replace(/^[ \t>]*/, ''))].join('\n');
  }
  if (rest.every((line) => /^[ \t]*>/.test(line))) {
    return [lines[0], ...rest.map((line) => line.replace(/^(?:[ \t]*>[ \t]?)+/, ''))].join('\n');
  }
  return tableMarkdown;
}
