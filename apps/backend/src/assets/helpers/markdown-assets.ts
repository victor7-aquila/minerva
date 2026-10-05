import MarkdownIt from 'markdown-it';
import type { AssetKind } from '../interfaces/assets.types';
import { fileNameOfPath } from './image-files';
import { breakPlaceholderLike, formatPlaceholder, sanitizeDescription } from './placeholder';

/** 원본 MD에서 찾은 표·이미지 하나다. start·end는 원문(markdown 인자) 기준 위치다. */
export interface ExtractedAsset {
  kind: AssetKind;
  placeholderId: string;
  order: number;
  start: number;
  end: number;
  tableMarkdown: string | null;
  imagePath: string | null;
  alt: string | null;
  description: string;
}

/** 추출 결과다. */
export interface Extraction {
  assets: ExtractedAsset[];
  indexingMarkdown: string;
}

/** 규칙 함수가 토큰에 남기는 위치다. */
interface SourceMeta {
  srcStart: number;
  srcEnd: number;
}

/** 후보를 모으는 동안 쓰는 값이다. 위치는 정규화한 텍스트 기준이다. */
interface Candidate {
  kind: AssetKind;
  start: number;
  end: number;
  descriptionRaw: string;
  imagePath: string | null;
  alt: string | null;
}

/** 줄 대응 표다. 정규화한 텍스트와 원문의 줄 시작 위치를 갖는다. */
interface LineMap {
  normalized: string;
  normStarts: number[];
  origStarts: number[];
  hasCr: boolean;
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

/** 블록 규칙을 감싸 만든 첫 토큰에 원문 위치(정규화한 텍스트 기준)를 남긴다. */
function wrapBlockRule(md: Md, name: string): void {
  const rule = findRule<BlockRule>(md.block.ruler, name);
  const original = rule.fn;
  const wrapped: BlockRule = (state, startLine, endLine, silent) => {
    const at = state.tokens.length;
    const ok = original(state, startLine, endLine, silent);
    if (ok && !silent) {
      const meta: SourceMeta = {
        srcStart: state.bMarks[startLine] + state.tShift[startLine],
        srcEnd: state.eMarks[state.line - 1],
      };
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
  wrapInlineRule(md, 'image');
  wrapInlineRule(md, 'html_inline');
  wrapBlockRule(md, 'table');
  wrapBlockRule(md, 'html_block');
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
  const normalized = markdown.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  return {
    normalized,
    normStarts: lineStarts(normalized, /\n/g),
    origStarts: lineStarts(markdown, /\r\n|\r|\n/g),
    hasCr: markdown.includes('\r'),
  };
}

/** 정규화한 위치를 원문 위치로 바꾼다. */
function toOriginal(map: LineMap, pos: number): number {
  if (!map.hasCr) return pos;
  let low = 0;
  let high = map.normStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (map.normStarts[mid] <= pos) low = mid;
    else high = mid - 1;
  }
  return map.origStarts[low] + (pos - map.normStarts[low]);
}

/** 정규화한 텍스트의 한 줄 내용을 돌려준다. */
function lineText(map: LineMap, line: number): string {
  const start = map.normStarts[line];
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

/** 인라인 토큰 내용 기준 위치를 정규화한 텍스트 위치로 바꾼다. 대응이 없으면 null이다. */
function inlineToNormalized(map: LineMap, token: Token, pos: number): number | null {
  if (token.map === null) return null;
  const contentLines = token.content.split('\n');
  let acc = 0;
  for (let index = 0; index < contentLines.length; index += 1) {
    const content = contentLines[index];
    if (pos <= acc + content.length) {
      const line = token.map[0] + index;
      const base = baseInLine(lineText(map, line), content);
      if (base === null) return null;
      return map.normStarts[line] + base + (pos - acc);
    }
    acc += content.length + 1;
  }
  return null;
}

/** 태그 문자열에서 속성 값을 읽는다. 없으면 null이다. */
function attrOf(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i');
  const match = pattern.exec(tag);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** `<img>` 태그 하나를 이미지 후보로 만든다. src가 없으면 null이다. */
function htmlImageCandidate(tag: string, start: number): Candidate | null {
  const src = attrOf(tag, 'src');
  if (src === null) return null;
  return {
    kind: 'image',
    start,
    end: start + tag.length,
    descriptionRaw: '',
    imagePath: src,
    alt: attrOf(tag, 'alt'),
  };
}

/** GFM 표 하나를 후보로 만든다. 머리 칸 원문을 쉼표로 이어 설명 원문으로 쓴다. */
function gfmTableCandidate(tokens: Token[], index: number): Candidate | null {
  const meta = metaOf(tokens[index]);
  if (meta === null) return null;
  const heads: string[] = [];
  for (let at = index + 1; at < tokens.length && tokens[at].type !== 'thead_close'; at += 1) {
    const text = tokens[at].type === 'inline' ? tokens[at].content.trim() : '';
    if (text !== '') heads.push(text);
  }
  return {
    kind: 'table',
    start: meta.srcStart,
    end: meta.srcEnd,
    descriptionRaw: heads.join(', '),
    imagePath: null,
    alt: null,
  };
}

/** HTML 표의 끝 위치를 찾는다. 깊이가 맞는 `</table>`이 없으면 fallbackEnd를 쓴다. */
function htmlTableEnd(text: string, start: number, limit: number, fallbackEnd: number): number {
  const region = text.slice(start, limit);
  let depth = 0;
  for (const match of region.matchAll(/<(\/?)table\b[^>]*>/gi)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return start + match.index + match[0].length;
  }
  return fallbackEnd;
}

/** HTML 표 첫 행의 칸 텍스트를 쉼표로 이어 설명 원문을 만든다. */
function htmlTableHeads(tableHtml: string): string {
  const row = /<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(tableHtml);
  if (row === null) return '';
  const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
  return cells
    .map((cell) => cell[1].replace(/<[^>]*>/g, '').trim())
    .filter((text) => text !== '')
    .join(', ');
}

/** 이미지로 보지 않는 HTML 블록의 시작 표지다. */
const HTML_SKIP_PREFIXES = ['<!--', '<pre', '<script', '<style', '<textarea'];

/** `html_block` 하나에서 후보를 모은다. */
function htmlBlockCandidates(
  map: LineMap,
  token: Token,
  codeStarts: readonly number[],
): Candidate[] {
  const meta = metaOf(token);
  if (meta === null) return [];
  const head = token.content.trimStart().toLowerCase();
  const text = map.normalized;
  if (head.startsWith('<table')) {
    const limit = codeStarts.find((at) => at > meta.srcStart) ?? text.length;
    const end = htmlTableEnd(text, meta.srcStart, limit, meta.srcEnd);
    return [
      {
        kind: 'table',
        start: meta.srcStart,
        end,
        descriptionRaw: htmlTableHeads(text.slice(meta.srcStart, end)),
        imagePath: null,
        alt: null,
      },
    ];
  }
  if (HTML_SKIP_PREFIXES.some((prefix) => head.startsWith(prefix))) return [];
  const block = text.slice(meta.srcStart, meta.srcEnd);
  const found: Candidate[] = [];
  for (const match of block.matchAll(/<img\b[^>]*>/gi)) {
    const candidate = htmlImageCandidate(match[0], meta.srcStart + match.index);
    if (candidate !== null) found.push(candidate);
  }
  return found;
}

/** 인라인 토큰 하나(최상위 자식만)에서 이미지 후보를 모은다. */
function inlineCandidates(map: LineMap, token: Token): Candidate[] {
  const found: Candidate[] = [];
  for (const child of token.children ?? []) {
    const meta = metaOf(child);
    if (meta === null) continue;
    const start = inlineToNormalized(map, token, meta.srcStart);
    const end = inlineToNormalized(map, token, meta.srcEnd);
    // ★ 위치를 원문에 대응시키지 못하면 등록하지 않고 원문 그대로 둔다
    if (start === null || end === null) continue;
    if (child.type === 'image') {
      found.push({
        kind: 'image',
        start,
        end,
        descriptionRaw: '',
        imagePath: child.attrGet('src') ?? '',
        alt: parser.renderer.renderInlineAsText(child.children ?? [], parser.options, {}),
      });
    } else if (child.type === 'html_inline' && /^<img\b/i.test(child.content)) {
      const candidate = htmlImageCandidate(child.content, start);
      if (candidate !== null) found.push({ ...candidate, end });
    }
  }
  return found;
}

/** 코드 블록(`fence`·`code_block`)의 시작 위치를 오름차순으로 모은다. */
function codeBlockStarts(map: LineMap, tokens: Token[]): number[] {
  const starts: number[] = [];
  for (const token of tokens) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map !== null) {
      starts.push(map.normStarts[token.map[0]]);
    }
  }
  return starts.sort((a, b) => a - b);
}

/** 토큰 목록에서 표·이미지 후보를 모은다. */
function collectCandidates(map: LineMap, tokens: Token[]): Candidate[] {
  const codeStarts = codeBlockStarts(map, tokens);
  const found: Candidate[] = [];
  tokens.forEach((token, index) => {
    if (token.type === 'table_open') {
      const candidate = gfmTableCandidate(tokens, index);
      if (candidate !== null) found.push(candidate);
    } else if (token.type === 'html_block') {
      found.push(...htmlBlockCandidates(map, token, codeStarts));
    } else if (token.type === 'inline' && token.map !== null) {
      found.push(...inlineCandidates(map, token));
    }
  });
  return found;
}

/** 시작 위치 순으로 정렬하고 앞 후보와 겹치는 후보를 버린다. */
function selectCandidates(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: Candidate[] = [];
  let lastEnd = -1;
  for (const candidate of sorted) {
    if (candidate.start < lastEnd) continue;
    accepted.push(candidate);
    lastEnd = candidate.end;
  }
  return accepted;
}

/** 후보의 자리표시 설명을 정한다. */
function describeCandidate(candidate: Candidate): string {
  if (candidate.kind === 'table') return sanitizeDescription(candidate.descriptionRaw, '표');
  const alt = candidate.alt?.trim() ?? '';
  const source = alt !== '' ? alt : fileNameOfPath(candidate.imagePath ?? '');
  return sanitizeDescription(source, '이미지');
}

/** 원본 MD에서 표·이미지를 찾아 자리표시로 바꾼 색인용 MD를 만든다. */
export function extractAssets(markdown: string): Extraction {
  const map = buildLineMap(markdown);
  const tokens = parser.parse(map.normalized, {});
  const selected = selectCandidates(collectCandidates(map, tokens));

  const counters: Record<AssetKind, number> = { table: 0, image: 0 };
  const assets: ExtractedAsset[] = [];
  let indexingMarkdown = '';
  let cursor = 0;
  selected.forEach((candidate, index) => {
    counters[candidate.kind] += 1;
    const start = toOriginal(map, candidate.start);
    const end = toOriginal(map, candidate.end);
    const placeholderId = `${candidate.kind === 'table' ? 't' : 'i'}${counters[candidate.kind]}`;
    const description = describeCandidate(candidate);
    const alt = candidate.alt === null || candidate.alt.trim() === '' ? null : candidate.alt;
    assets.push({
      kind: candidate.kind,
      placeholderId,
      order: index + 1,
      start,
      end,
      tableMarkdown: candidate.kind === 'table' ? markdown.slice(start, end) : null,
      imagePath: candidate.imagePath,
      alt,
      description,
    });
    // ★ 만든 자리표시에는 깨뜨리기를 적용하지 않는다
    indexingMarkdown += breakPlaceholderLike(markdown.slice(cursor, start));
    indexingMarkdown += formatPlaceholder(candidate.kind, placeholderId, description);
    cursor = end;
  });
  indexingMarkdown += breakPlaceholderLike(markdown.slice(cursor));
  return { assets, indexingMarkdown };
}
