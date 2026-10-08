import type { TextRange } from '../interfaces/assets.types';
import { extractAssets, tableForDisplay } from './markdown-assets';
import type { ExtractedAsset, Extraction } from './markdown-assets';
import { breakPlaceholderLike, unbreakPlaceholderLike } from './placeholder';

// ★ 자리표시 형식은 루트 IF-1의 리터럴이다. 구현 상수에 기대지 않는다
const IF1_ANYWHERE = /\[\[minerva:(table|image):([a-z0-9]+) \| [^\n]*?\]\]/g;
const ZWSP = String.fromCharCode(0x200b);
const BOM = '﻿';

// ★ 리뷰 실측에서 기존(이차 시간) 구현은 8000줄에 1.5~2.1초, 한 줄 이미지 133KB에 2.7초였다.
// PERF-1·2(16000줄), PERF-3(닫히지 않은 표 16000개), PERF-5(한 줄 이미지 16000개, 약 192KB)는
// 기존 구현에서 상한의 여러 배(수 초)가 걸려 확실히 실패하고, 선형 구현은 수십 ms다.
// PERF-4는 구현 후 회귀 방어용이다 — 새 훑기·정규식이 닫히지 않은 입력에서 폭주하지 않는지 보며,
// 기존 구현에서도 통과하는 것이 의도다
const PERF_LIMIT_MS = 1000;

/** 줄들을 \n으로 잇는다. */
function lines(...parts: string[]): string {
  return parts.join('\n');
}

/** 색인용 MD 안의 자리표시 매치들을 찾는다. */
function placeholdersIn(markdown: string): RegExpExecArray[] {
  return [...markdown.matchAll(IF1_ANYWHERE)] as RegExpExecArray[];
}

/**
 * 색인용 MD에서 자리표시를 원문 조각으로 되돌리고 깨뜨린 문자열을 되돌려 원문을 재구성한다.
 * ★ 구현과 독립이다: 자리표시는 IF-1 정규식으로 찾고 원문 조각은 markdown.slice(start, end)다.
 */
function rebuild(markdown: string, extraction: Extraction): string {
  const found = placeholdersIn(extraction.indexingMarkdown);
  // ★ 표 안 이미지는 자리표시가 없다 — 최상위 자산(tableId가 null)만 자리표시와 짝이다
  const topLevel = topLevelOf(extraction);
  expect(found).toHaveLength(topLevel.length);
  let out = '';
  let cursor = 0;
  found.forEach((match, index) => {
    const asset = topLevel[index];
    expect(match[1]).toBe(asset.kind);
    expect(match[2]).toBe(asset.placeholderId);
    const before = extraction.indexingMarkdown.slice(cursor, match.index);
    out += unbreakPlaceholderLike(before) + markdown.slice(asset.start, asset.end);
    cursor = match.index + match[0].length;
  });
  return out + unbreakPlaceholderLike(extraction.indexingMarkdown.slice(cursor));
}

/** 자리표시가 있는 최상위 자산만 뽑는다. */
function topLevelOf(result: Extraction): ExtractedAsset[] {
  return result.assets.filter((asset) => (asset.tableId ?? null) === null);
}

/** ID로 자산을 찾는다. 없으면 실패시킨다. */
function assetOf(result: Extraction, placeholderId: string): ExtractedAsset {
  const found = result.assets.find((asset) => asset.placeholderId === placeholderId);
  if (found === undefined) throw new Error(`자산 ${placeholderId}가 없다`);
  return found;
}

/** 표 안 이미지의 pathInTable을 꺼낸다. 없으면 실패시킨다. */
function rangeOf(asset: ExtractedAsset): TextRange {
  if (asset.pathInTable === undefined || asset.pathInTable === null) {
    throw new Error(`${asset.placeholderId}의 pathInTable이 없다`);
  }
  return asset.pathInTable;
}

/** 표 tableMarkdown에서 이미지 pathInTable 위치의 글자를 꺼낸다. */
function pathTextIn(table: ExtractedAsset, image: ExtractedAsset): string {
  const range = rangeOf(image);
  return (table.tableMarkdown ?? '').slice(range.start, range.end);
}

/** 작업 시간을 잰다. */
function timed<T>(work: () => T): { value: T; elapsedMs: number } {
  const begin = performance.now();
  const value = work();
  return { value, elapsedMs: performance.now() - begin };
}

/** 종류 순서를 뽑는다. */
function kindsOf(result: Extraction): string[] {
  return result.assets.map((asset) => asset.kind);
}

/** 이미지 경로 순서를 뽑는다. */
function pathsOf(result: Extraction): Array<string | null> {
  return result.assets.filter((asset) => asset.kind === 'image').map((asset) => asset.imagePath);
}

/** MODULE.md 충족 기준 문서: 표 둘, 이미지 셋(인라인·참조형·HTML). */
const DOC_MODULE = lines(
  '# 제목',
  '',
  '| 키 | 값 |',
  '| --- | --- |',
  '| a | b |',
  '',
  '![a](img/a.png)',
  '',
  '본문 ![b][rb] 끝',
  '',
  '<table>',
  '<tr><th>H1</th><th>H2</th></tr>',
  '<tr><td>1</td><td>2</td></tr>',
  '</table>',
  '',
  '<img src="c.png" alt="C">',
  '',
  '[rb]: ./b.png',
);

describe('REQ-BE-2.1.1', () => {
  it('T-EXT-1 GFM 표 둘째 HTML 표와 세 가지 이미지 표기를 원본 순서로 등록한다', () => {
    const result = extractAssets(DOC_MODULE);
    expect(kindsOf(result)).toEqual(['table', 'image', 'image', 'table', 'image']);
    expect(pathsOf(result)).toEqual(['img/a.png', './b.png', 'c.png']);
  });

  it('T-EXT-1 제목이 붙은 이미지는 경로만 등록하고 정의 없는 참조형은 등록하지 않는다', () => {
    const result = extractAssets(lines('![a](a.png "제목")', '', '![x][none]'));
    expect(pathsOf(result)).toEqual(['a.png']);
  });

  it('T-EXT-2 경로는 MD에 적힌 그대로다(꺾쇠 공백·퍼센트 인코딩 유지·역슬래시 이스케이프 해제)', () => {
    const md = lines('![x](<img/한 글.png>)', '', '![y](img/%ED%95%9C.png)', '', '![z](a\\_b.png)');
    const result = extractAssets(md);
    expect(pathsOf(result)).toEqual(['img/한 글.png', 'img/%ED%95%9C.png', 'a_b.png']);
  });

  it.each([
    ['한 블록 표', lines('<table>', '<tr><td>a</td></tr>', '</table>')],
    [
      '빈 줄이 든 표',
      lines('<table>', '<tr><td>a</td></tr>', '', '<tr><td>b</td></tr>', '</table>'),
    ],
    [
      '중첩 표',
      lines(
        '<table>',
        '<tr><td>',
        '<table>',
        '<tr><td>x</td></tr>',
        '</table>',
        '</td></tr>',
        '</table>',
      ),
    ],
    ['대문자 태그 표', lines('<TABLE>', '<TR><TD>u</TD></TR>', '</TABLE>')],
  ])(
    'T-EXT-3 HTML 표(%s)는 표 하나이고 tableMarkdown이 여는 태그부터 닫는 태그까지다',
    (_label, md) => {
      const result = extractAssets(md);
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].kind).toBe('table');
      expect(result.assets[0].tableMarkdown).toBe(md);
      expect(rebuild(md, result)).toBe(md);
    },
  );

  it('T-EXT-4 HTML <img>는 인라인·블록·속성 순서·따옴표 없는 값을 모두 등록하고 src 없는 것은 뺀다', () => {
    const md = lines(
      "문단 안 <img src='x.png'> 인라인.",
      '',
      '<p align="center"><img src="y.png" alt="Y"></p>',
      '',
      '<img alt=Z src=z.png>',
      '',
      '<img alt="n">',
    );
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['image', 'image', 'image']);
    expect(pathsOf(result)).toEqual(['x.png', 'y.png', 'z.png']);
    expect(result.assets[1].alt).toBe('Y');
    expect(result.assets[2].alt).toBe('Z');
    // 태그 범위만 자리표시로 바뀐다
    expect(result.indexingMarkdown).toContain('<p align="center">[[minerva:image:i2 | Y]]</p>');
    expect(result.indexingMarkdown).not.toContain('src="y.png"');
    expect(result.indexingMarkdown).toContain('<img alt="n">');
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-EXT-5 목록·인용문·게으른 연속 줄·제목·링크 안·한 줄 둘의 이미지를 모두 등록한다', () => {
    const md = lines(
      '- 목록 ![l](l.png) 항목',
      '',
      '> 인용 ![q](q.png)',
      '>',
      '> | a | b |',
      '> | - | - |',
      '> | 1 | 2 |',
      '',
      '> 인용2 ![lz](lz.png)',
      '게으른 ![lz2](lz2.png)',
      '',
      '## H ![h](h.png) ##',
      '',
      'Setext ![s](s.png)',
      '===',
      '',
      '[![in](in.png)](u)',
      '',
      '한 줄 ![p1](p1.png) 와 ![p2](p2.png)',
    );
    const result = extractAssets(md);
    expect(pathsOf(result)).toEqual([
      'l.png',
      'q.png',
      'lz.png',
      'lz2.png',
      'h.png',
      's.png',
      'in.png',
      'p1.png',
      'p2.png',
    ]);
    expect(kindsOf(result).filter((kind) => kind === 'table')).toHaveLength(1);
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-EXT-6 GFM 표 칸 안의 이미지는 표 안 이미지로 등록되고 자리표시는 표 하나뿐이다', () => {
    const md = lines('| a | b |', '| - | - |', '| ![a](a.png) | x |');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table', 'image']);
    expect(result.assets[0].tableMarkdown).toContain('![a](a.png)');
    expect(result.assets[1].tableId).toBe('t1');
    expect(result.assets[1].imagePath).toBe('a.png');
    expect(placeholdersIn(result.indexingMarkdown)).toHaveLength(1);
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-EXT-6 HTML 표 안의 <img>는 표 안 이미지로 등록되고 자리표시는 표 하나뿐이다', () => {
    const md = lines('<table>', '<tr><td><img src="b.png"></td></tr>', '</table>');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table', 'image']);
    expect(result.assets[0].tableMarkdown).toContain('<img src="b.png">');
    expect(result.assets[1].tableId).toBe('t1');
    expect(result.assets[1].imagePath).toBe('b.png');
    expect(placeholdersIn(result.indexingMarkdown)).toHaveLength(1);
    expect(rebuild(md, result)).toBe(md);
  });

  // ── 성능 (H1) ──

  it('T-PR3-PERF-1 여러 줄 <br> 문단 16000줄 뒤의 이미지 하나를 제한 시간 안에 추출한다', () => {
    const md = `${Array.from({ length: 16000 }, () => 'line of text<br>').join('\n')}\n![a](x.png)`;
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
    expect(pathsOf(value)).toEqual(['x.png']);
  });

  it('T-PR3-PERF-2 한 문단의 여러 줄 이미지 16000개를 제한 시간 안에 추출한다', () => {
    const md = Array.from({ length: 16000 }, () => '![a](x.png)').join('\n');
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
    expect(value.assets).toHaveLength(16000);
    expect(placeholdersIn(value.indexingMarkdown)).toHaveLength(16000);
  });

  it('T-PR3-PERF-3 닫히지 않은 <table> HTML 블록 16000개를 제한 시간 안에 추출한다', () => {
    const md = Array.from({ length: 16000 }, () => '<table>').join('\n\n');
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
    expect(value.assets).toHaveLength(16000);
    expect(value.assets.every((asset) => asset.tableMarkdown === '<table>')).toBe(true);
  });

  it.each([
    ['닫히지 않은 <img 태그', '<img src=a.png'],
    ['닫히지 않은 주석', '<!-- x'],
  ])(
    'T-PR3-PERF-4 <div> 블록 안의 %s 8000줄을 예외 없이 제한 시간 안에 추출한다',
    (_label, line) => {
      const md = ['<div>', ...Array.from({ length: 8000 }, () => line)].join('\n');
      const { elapsedMs } = timed(() => extractAssets(md));
      expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
    },
  );

  // ★ H-1 회귀 탐지: 닫히지 않은 표 입력에서 표 끝 탐색이 이차 이상으로 폭주하지 않아야 한다.
  //   기대 결과 모양은 명세로 정해지지 않았으므로 시간만 단언한다
  it('T-PR3-PERF-6 한 줄에 닫히지 않은 <table> 80000개가 이어진 입력을 제한 시간 안에 추출한다', () => {
    const md = '<table>'.repeat(80000);
    const { elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
  });

  it('T-PR3-PERF-7 <table> 2000겹 중첩 입력을 제한 시간 안에 추출한다', () => {
    const md = '<table><tr><td>'.repeat(2000);
    const { elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
  });

  it('T-PR3-PERF-8 줄마다 닫는 태그 없는 <table><tr><td>x</td> 2000줄을 제한 시간 안에 추출한다', () => {
    const md = Array.from({ length: 2000 }, () => '<table><tr><td>x</td>').join('\n');
    const { elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
  });

  // ★ 칸 안의 '<'가 매우 많은 입력 — <tr>·칸 정규식·stripTags가 같은 구간을 되돌아 훑으면 느려진다
  it("T-PR3-PERF-9 표 칸 안에 '<' 120000개가 이어진 입력을 제한 시간 안에 추출한다", () => {
    const md = `<table><tr><td>${'<'.repeat(120000)}</td></tr></table>`;
    const { elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
  });

  // ★ 스택 초과 회귀: 결과를 모으며 인자 펼치기(push(...arr))로 호출 스택이 넘치면 RangeError가 난다.
  //   기대 결과 모양은 명세로 정해지지 않았으므로 예외 없음과 최소 개수만 단언한다
  it('T-PR3-STACK-1 한 블록에 <table> 후보 200000개가 있어도 예외 없이 추출한다', () => {
    const md = '<table>'.repeat(200000);
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS * 5);
    expect(value.assets.length).toBeGreaterThan(0);
  });

  it('T-PR3-STACK-2 한 문단(한 줄)에 이미지 200000개가 있어도 예외 없이 추출한다', () => {
    const md = '![a](x.png)'.repeat(200000);
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS * 5);
    expect(value.assets).toHaveLength(200000);
  });

  it('T-PR3-STACK-3 GFM 표 한 행의 칸 안에 이미지 200000개가 있어도 예외 없이 추출한다', () => {
    const md = `| ${'![a](x.png)'.repeat(200000)} |\n| - |\n`;
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS * 5);
    // 표 1개 + 칸 안 이미지 200000개
    expect(value.assets).toHaveLength(200001);
  });

  // ★ HTML 표가 GFM 표를 덮는 입력 — 겹친 표의 nested를 옮기는 지점의 펼침 push 회귀를 잡는다
  it('T-PR3-STACK-4 HTML 표가 이미지 200000개를 가진 GFM 표를 덮어도 예외 없이 추출한다', () => {
    const md = `<table>\n\n| ${'![a](x.png)'.repeat(200000)} |\n| - |\n\n</table>`;
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS * 5);
    // 겹친 표는 하나로 합쳐지고 이미지는 모두 그 표로 옮겨진다: 표 1개 + 이미지 200000개
    expect(value.assets).toHaveLength(200001);
    // 표는 최상위 자산 하나뿐이고, 이미지 200000개 모두 그 표의 tableId를 가진다
    const tables = value.assets.filter((asset) => asset.kind === 'table');
    expect(tables).toHaveLength(1);
    const tableId = tables[0]?.placeholderId;
    expect(tableId).toBeDefined();
    const images = value.assets.filter((asset) => asset.kind === 'image');
    expect(images).toHaveLength(200000);
    expect(images.every((asset) => asset.tableId === tableId)).toBe(true);
  });

  // ★ 이 입력은 줄별 기준 위치 캐시가 없으면 baseInLine이 이미지마다 줄 전체를 훑어 느려진다
  it('T-PR3-PERF-5 한 줄에 이미지 16000개(약 192KB)가 이어진 문단을 제한 시간 안에 추출한다', () => {
    const md = Array.from({ length: 16000 }, () => '![a](x.png)').join(' ');
    const { value, elapsedMs } = timed(() => extractAssets(md));
    expect(elapsedMs).toBeLessThan(PERF_LIMIT_MS);
    expect(value.assets).toHaveLength(16000);
  });

  // ── HTML 블록 안의 표 (M1·A-N1) ──

  it('T-PR3-WRAP-1 <div>로 감싼 HTML 표를 표로 등록하고 안의 이미지는 표 안 이미지다', () => {
    const md = lines(
      '<div align="center">',
      '<table>',
      '<tr><td><img src="a.png"></td></tr>',
      '</table>',
      '</div>',
    );
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table', 'image']);
    expect(result.assets[0].tableMarkdown).toBe(
      lines('<table>', '<tr><td><img src="a.png"></td></tr>', '</table>'),
    );
    expect(result.assets[1].tableId).toBe('t1');
    expect(result.indexingMarkdown).toBe(
      lines('<div align="center">', '[[minerva:table:t1 | 표]]', '</div>'),
    );
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-WRAP-2 한 줄 <div> 안의 표 밖 이미지와 표가 각자 최상위로 등록된다', () => {
    const md = '<div><img src="out.png"><table><tr><td>x</td></tr></table></div>';
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['image', 'table']);
    expect(result.assets.map((asset) => asset.placeholderId)).toEqual(['i1', 't1']);
    expect(result.assets[0].tableId).toBeNull();
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-WRAP-3 빈 줄이 든 <div> 안 표의 뒤쪽 이미지도 그 표 안 이미지다', () => {
    const md = lines(
      '<div>',
      '<table>',
      '<tr><td>a</td></tr>',
      '',
      '<tr><td><img src="b.png"></td></tr>',
      '</table>',
      '</div>',
    );
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table', 'image']);
    expect(result.assets[1].imagePath).toBe('b.png');
    expect(result.assets[1].tableId).toBe('t1');
  });

  it('T-PR3-WRAP-4 </table> 뒤 같은 블록의 <img>도 최상위 이미지로 등록된다', () => {
    const md = lines('<table><tr><td>a</td></tr></table>', '<img src="after.png">');
    const result = extractAssets(md);
    expect(result.assets.map((asset) => asset.placeholderId)).toEqual(['t1', 'i1']);
    expect(result.assets[1].imagePath).toBe('after.png');
    expect(result.assets[1].tableId).toBeNull();
    expect(result.indexingMarkdown).toBe(
      lines('[[minerva:table:t1 | a]]', '[[minerva:image:i1 | after.png]]'),
    );
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-WRAP-5 빈 줄 없이 이어진 두 표는 각자 표 하나로 등록된다', () => {
    const first = '<table><tr><td>a</td></tr></table>';
    const second = '<table><tr><td>b</td></tr></table>';
    const result = extractAssets(lines(first, second));
    expect(result.assets.map((asset) => asset.placeholderId)).toEqual(['t1', 't2']);
    expect(result.assets[0].tableMarkdown).toBe(first);
    expect(result.assets[1].tableMarkdown).toBe(second);
  });

  // ── 표 안 이미지 (H2) ──

  it('T-PR3-NEST-1 같은 경로가 두 칸에 있으면 칸마다 위치가 정확한 표 안 이미지 둘이 된다', () => {
    const md = lines('| a | b |', '| - | - |', '| ![i](z.png) | ![i](z.png) |');
    const result = extractAssets(md);
    expect(result.assets.map((asset) => asset.placeholderId)).toEqual(['t1', 'i1', 'i2']);
    const table = assetOf(result, 't1');
    const [first, second] = [assetOf(result, 'i1'), assetOf(result, 'i2')];
    for (const image of [first, second]) {
      expect(image.tableId).toBe('t1');
      expect(image.imagePath).toBe('z.png');
      expect(pathTextIn(table, image)).toBe('z.png');
    }
    expect(rangeOf(first).start).not.toBe(rangeOf(second).start);
    expect(rangeOf(first).start).toBe((table.tableMarkdown ?? '').indexOf('z.png'));
    expect(rangeOf(second).start).toBe((table.tableMarkdown ?? '').lastIndexOf('z.png'));
    expect(result.indexingMarkdown).toBe('[[minerva:table:t1 | a, b]]');
  });

  it('T-PR3-NEST-2 HTML 표 안 <img>는 alt·경로·표 안 위치를 가진다', () => {
    const result = extractAssets('<table><tr><td><img src="b.png" alt="B"></td></tr></table>');
    const image = assetOf(result, 'i1');
    expect(image.tableId).toBe('t1');
    expect(image.alt).toBe('B');
    expect(image.imagePath).toBe('b.png');
    expect(pathTextIn(assetOf(result, 't1'), image)).toBe('b.png');
  });

  it('T-PR3-NEST-3 표 안 이미지는 그 표 바로 뒤에 놓이고 ID·order가 원본 차례로 이어진다', () => {
    const md = lines('![a](a1.png)', '', '| h |', '| - |', '| ![x](x.png) |', '', '![b](a2.png)');
    const result = extractAssets(md);
    expect(result.assets.map((asset) => asset.placeholderId)).toEqual(['i1', 't1', 'i2', 'i3']);
    expect(result.assets.map((asset) => asset.order)).toEqual([1, 2, 3, 4]);
    expect(assetOf(result, 'i2').tableId).toBe('t1');
    expect(assetOf(result, 'i3').tableId).toBeNull();
  });

  it('T-PR3-NEST-4 꺾쇠 경로의 위치는 꺾쇠 안이고 참조형 경로는 위치가 null이다', () => {
    const angle = extractAssets(lines('| a |', '| - |', '| x \\| y ![p](<p q.png>) |'));
    const angleImage = assetOf(angle, 'i1');
    expect(angleImage.imagePath).toBe('p q.png');
    expect(pathTextIn(assetOf(angle, 't1'), angleImage)).toBe('p q.png');

    const reference = extractAssets(lines('| a |', '| - |', '| ![r][ref] |', '', '[ref]: r.png'));
    const referenceImage = assetOf(reference, 'i1');
    expect(referenceImage.imagePath).toBe('r.png');
    expect(referenceImage.pathInTable).toBeNull();
  });

  it('T-PR3-NEST-5 인용문 안 표는 tableMarkdown에 > 접두가 남고 위치는 그 원문 기준이다', () => {
    const md = lines('> | a |', '> | - |', '> | ![q](q.png) |');
    const result = extractAssets(md);
    const table = assetOf(result, 't1');
    expect(table.tableMarkdown).toBe(lines('| a |', '> | - |', '> | ![q](q.png) |'));
    expect(pathTextIn(table, assetOf(result, 'i1'))).toBe('q.png');
  });

  it('T-PR3-NEST-6 BOM이 붙은 CRLF 문서의 표 안 이미지도 위치가 맞고 원문과 같게 재구성된다', () => {
    const md = `${BOM}| a |\r\n| - |\r\n| ![c](c.png) |\r\n`;
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table', 'image']);
    expect(pathTextIn(assetOf(result, 't1'), assetOf(result, 'i1'))).toBe('c.png');
    expect(rebuild(md, result)).toBe(md);
  });

  // ── 엣지 케이스 (L16) ──

  it('T-PR3-EDGE-1 맨 앞 BOM이 있어도 HTML 표가 등록되고 위치는 BOM만큼 밀린다', () => {
    const md = `${BOM}<table><tr><td>a</td></tr></table>`;
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].start).toBe(1);
    expect(result.indexingMarkdown).toBe(`${BOM}[[minerva:table:t1 | a]]`);
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-EDGE-1b BOM 바로 뒤의 코드 펜스가 뒤 문서의 추출을 막지 않는다', () => {
    const md = `${BOM}\`\`\`\ncode\n\`\`\`\n\n# T\n\n![a](b.png)`;
    const result = extractAssets(md);
    expect(pathsOf(result)).toEqual(['b.png']);
    expect(result.indexingMarkdown.startsWith(`${BOM}\`\`\`\ncode\n\`\`\`\n`)).toBe(true);
  });

  it.each([
    ['다른 속성 값 안의 src=는 건너뛴다', '<img alt="x src=evil.png" src="real.png">', 'real.png'],
    ['data-src는 src가 아니다', '<img data-src="d.png" src=\'s.png\'>', 's.png'],
    ['같은 이름이면 처음 속성이 이긴다', '<img SRC="u.png" src="v.png">', 'u.png'],
  ])('T-PR3-EDGE-2 %s', (_label, md, expected) => {
    expect(pathsOf(extractAssets(md))).toEqual([expected]);
  });

  it('T-PR3-EDGE-2 다른 속성 값 안의 src=가 있어도 alt는 그 값 그대로다', () => {
    const result = extractAssets('<img alt="x src=evil.png" src="real.png">');
    expect(result.assets[0].alt).toBe('x src=evil.png');
  });

  it('T-PR3-EDGE-3 HTML src의 문자 참조는 풀고 역슬래시는 그대로, Markdown 경로는 이스케이프를 푼다', () => {
    const md = lines(
      '![m](a&amp;b.png)',
      '',
      '<img src="a&amp;b.png" alt="&lt;b&gt;">',
      '',
      '<img src="c\\d.png">',
      '',
      '![e](a\\_b.png)',
    );
    const result = extractAssets(md);
    expect(pathsOf(result)).toEqual(['a&b.png', 'a&b.png', 'c\\d.png', 'a_b.png']);
    expect(result.assets[1].alt).toBe('<b>');
  });

  it('T-PR3-EDGE-4 HTML 블록 안 주석과 script 안의 <img>는 등록하지 않는다', () => {
    const md = lines(
      '<div>',
      '<!-- <img src="x.png"> -->',
      '<script>var s = \'<img src="y.png">\';</script>',
      '<img src="z.png">',
      '</div>',
    );
    expect(pathsOf(extractAssets(md))).toEqual(['z.png']);
  });

  it('T-PR3-EDGE-4 HTML 블록 안 주석 속 표는 등록하지 않는다', () => {
    const md = lines('<div>', '<!-- <table><tr><td>a</td></tr></table> -->', '</div>');
    expect(extractAssets(md).assets).toEqual([]);
  });

  it('T-PR3-EDGE-4 닫히지 않은 주석 안의 <img>는 블록 끝까지 등록하지 않는다', () => {
    const md = lines('<div>', '<!-- <img src="x.png">', '</div>');
    expect(extractAssets(md).assets).toEqual([]);
  });

  // ── F1: HTML 표 짝은 html_block 범위 안에서만 구한다 ──

  const F1_TABLE = lines('<table>', '<tr><td>a</td></tr>', '', '<tr><td>b</td></tr>', '</table>');

  it('T-PR3-F1-1 문단 글의 <script> 낱말이 뒤쪽 빈 줄 낀 HTML 표의 짝을 깨지 않는다', () => {
    const md = `Avoid inline \`<script>\` tags.\n\n${F1_TABLE}\n`;
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toBe(F1_TABLE);
    expect(result.indexingMarkdown).not.toContain('<tr><td>b</td></tr>');
    expect(rebuild(md, result)).toBe(md);
  });

  it.each([
    ['인라인 코드 안 주석 시작', 'Use `<!--` carefully.'],
    ['닫히지 않은 raw text 낱말', 'Raw <style> text without close.'],
    ['textarea 낱말', 'Type `<textarea>` here.'],
    // 회귀 방지용(현재 구현에서도 통과) — F1의 재현 입력이 아니다
    ["따옴표 없는 속성 안의 '", "Link <a href=it's>x</a> here."],
  ])('T-PR3-F1-2 문단 앞에 %s가 있어도 표 하나로 등록된다', (_label, paragraph) => {
    const md = `${paragraph}\n\n${F1_TABLE}\n`;
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toBe(F1_TABLE);
    expect(result.indexingMarkdown).not.toContain('<tr><td>b</td></tr>');
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-F1-3 칸 안에 Markdown 문단이 낀 HTML 표도 마지막 </table>까지 표 하나다', () => {
    const md = lines('<table>', '<tr><td>', '', '**굵게** 문단', '', '</td></tr>', '</table>');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toBe(md);
  });

  it('T-PR3-F1-4 코드 블록 안 </table>과 코드 블록 뒤 블록의 </table>은 짝이 아니다', () => {
    const md = lines('<table>', '', '```', '</table>', '```', '', '</table>');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toBe('<table>');
  });

  // ── F4: 표와 겹치는 이미지 후보보다 표를 우선한다 ──

  it('T-PR3-F4-1 표 시작을 넘어 겹치는 깨진 <img 후보가 있어도 표와 표 안 이미지는 등록된다', () => {
    const md = lines(
      '<div>',
      '<img src="a.png"',
      '<table><tr><td><img src="b.png"></td></tr></table>',
      '</div>',
    );
    const result = extractAssets(md);
    const table = assetOf(result, 't1');
    expect(table.kind).toBe('table');
    const inside = result.assets.filter((asset) => asset.tableId === 't1');
    expect(inside.map((asset) => asset.imagePath)).toEqual(['b.png']);
    // 표와 겹치는 이미지 후보는 등록되지 않는다 — 이미지는 표 안 b.png 하나뿐이다
    expect(pathsOf(result)).toEqual(['b.png']);
    expect(result.indexingMarkdown).toContain('[[minerva:table:t1 |');
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-F4-2 표와 겹치지 않는 앞 이미지는 그대로 등록된다', () => {
    const md = lines('<img src="a.png">', '<table><tr><td>x</td></tr></table>');
    const result = extractAssets(md);
    expect(result.assets.map((asset) => asset.placeholderId)).toEqual(['i1', 't1']);
    expect(rebuild(md, result)).toBe(md);
  });
});

describe('REQ-BE-2.1.2', () => {
  it.each([
    ['``` 펜스', lines('```', '| a | b |', '| - | - |', '![f](f.png)', '```')],
    ['~~~ 펜스', lines('~~~', '| a | b |', '| - | - |', '![f](f.png)', '~~~')],
    ['들여쓰기 코드 블록', lines('문단', '', '    ![x](x.png)', '', '끝')],
  ])('T-EXT-7 %s 안의 표·이미지는 등록하지 않고 색인용 MD에 그대로 둔다', (_label, md) => {
    const result = extractAssets(md);
    expect(result.assets).toEqual([]);
    expect(result.indexingMarkdown).toBe(md);
  });

  it('T-EXT-7 인라인 코드와 같은 문단의 진짜 이미지만 바뀌고 코드 스팬 글자는 그대로다', () => {
    const md = '`![c](c.png)` 와 ![c](c.png)';
    const result = extractAssets(md);
    expect(result.assets).toHaveLength(1);
    expect(result.indexingMarkdown).toBe('`![c](c.png)` 와 [[minerva:image:i1 | c]]');
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-EXT-7 인용문·목록 안 코드 블록의 이미지는 등록하지 않는다', () => {
    const md = lines('> ```', '> ![q](q.png)', '> ```', '', '- ```', '  ![l](l.png)', '  ```');
    expect(extractAssets(md).assets).toEqual([]);
  });

  it('T-EXT-8 HTML 주석 블록과 <pre> 블록 안의 <img>는 등록하지 않는다', () => {
    const md = lines(
      '<!--',
      '<img src="h.png">',
      '-->',
      '',
      '<pre>',
      '<img src="p.png">',
      '</pre>',
    );
    const result = extractAssets(md);
    expect(result.assets).toEqual([]);
    expect(result.indexingMarkdown).toBe(md);
  });

  // ★ 닫는 </table>이 코드 블록 안에 있으면 표의 끝으로 보지 않는다 — 표는 블록 끝에서 끊긴다
  it('T-PR3-CODE-1 코드 블록 안의 </table>은 표 끝이 아니고 안의 표 모양·이미지는 등록하지 않는다', () => {
    const md = lines('<table>', '', '```', '</table>', '| a |', '| - |', '| ![x](x.png) |', '```');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toBe('<table>');
  });

  it('T-PR3-EDGE-1c BOM 바로 뒤 코드 펜스 안의 이미지는 등록하지 않는다', () => {
    const md = `${BOM}\`\`\`\n![x](y.png)\n\`\`\``;
    expect(extractAssets(md).assets).toEqual([]);
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-PR3-DISP-1 GFM 표는 둘째 줄부터 인용·목록 접두를 뗀다', () => {
    expect(tableForDisplay(lines('| 키 | 값 |', '> | --- | --- |', '> | a | b |'))).toBe(
      lines('| 키 | 값 |', '| --- | --- |', '| a | b |'),
    );
    expect(tableForDisplay(lines('| a | b |', '  | - | - |', '  | 1 | 2 |'))).toBe(
      lines('| a | b |', '| - | - |', '| 1 | 2 |'),
    );
    expect(tableForDisplay(lines('| a |', '> > | - |', '> > | 1 |'))).toBe(
      lines('| a |', '| - |', '| 1 |'),
    );
  });

  it('T-PR3-DISP-2 HTML 표는 둘째 줄부터 모든 줄이 >로 시작할 때만 접두를 뗀다', () => {
    expect(tableForDisplay(lines('<table>', '> <tr><td>a</td></tr>', '> </table>'))).toBe(
      lines('<table>', '<tr><td>a</td></tr>', '</table>'),
    );
    const mixed = lines('<table>', '> <tr><td>a</td></tr>', '</table>');
    expect(tableForDisplay(mixed)).toBe(mixed);
  });

  it('T-PR3-DISP-3 한 줄 표·접두 없는 표는 그대로고 CRLF의 \\r는 남는다', () => {
    const oneLine = '<table><tr><td>a</td></tr></table>';
    expect(tableForDisplay(oneLine)).toBe(oneLine);
    const plain = lines('| a |', '| - |', '| 1 |');
    expect(tableForDisplay(plain)).toBe(plain);
    expect(tableForDisplay('| a |\r\n> | - |\r\n> | 1 |')).toBe('| a |\r\n| - |\r\n| 1 |');
    const crlfPlain = '| a |\r\n| - |\r\n| 1 |';
    expect(tableForDisplay(crlfPlain)).toBe(crlfPlain);
  });
});

describe('REQ-BE-2.1.3', () => {
  it('T-EXT-9 표와 이미지가 섞여도 ID는 종류별로 원본 차례대로 서로 다르고 order는 1부터 연속이다', () => {
    const table = (n: number): string => lines(`| h${n} |`, '| - |', `| v${n} |`);
    const md = lines(
      '![a](a1.png)',
      '',
      table(1),
      '',
      '![b](a2.png)',
      '',
      '![c](a3.png)',
      '',
      table(2),
      '',
      '![d](a4.png)',
      '',
      table(3),
    );
    const result = extractAssets(md);
    const ids = result.assets.map((asset) => asset.placeholderId);
    expect(ids).toEqual(['i1', 't1', 'i2', 'i3', 't2', 'i4', 't3']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+$/);
    expect(result.assets.map((asset) => asset.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('REQ-BE-2.2.1', () => {
  it('T-IDX-1 표·이미지마다 자리표시가 정확히 하나씩 들어가고 그 밖의 글자는 원본과 같다', () => {
    const result = extractAssets(DOC_MODULE);
    const found = placeholdersIn(result.indexingMarkdown);
    expect(found).toHaveLength(5);
    expect(found.map((match) => match[2]).sort()).toEqual(['i1', 'i2', 'i3', 't1', 't2']);
    expect(found.map((match) => match[1])).toEqual(kindsOf(result));
    expect(rebuild(DOC_MODULE, result)).toBe(DOC_MODULE);
  });

  it('T-IDX-2 인용문 안 GFM 표는 첫 줄 내용 위치에 한 줄로 들어가고 둘째 줄부터의 접두는 tableMarkdown에 남는다', () => {
    const md = lines('> | 키 | 값 |', '> | --- | --- |', '> | a | b |');
    const result = extractAssets(md);
    expect(result.indexingMarkdown).toBe('> [[minerva:table:t1 | 키, 값]]');
    expect(result.assets[0].tableMarkdown).toBe(
      lines('| 키 | 값 |', '> | --- | --- |', '> | a | b |'),
    );
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-IDX-2 목록 안 GFM 표도 같은 방식이다', () => {
    const md = lines('- | a | b |', '  | - | - |', '  | 1 | 2 |');
    const result = extractAssets(md);
    expect(result.indexingMarkdown).toBe('- [[minerva:table:t1 | a, b]]');
    expect(result.assets[0].tableMarkdown).toBe(lines('| a | b |', '  | - | - |', '  | 1 | 2 |'));
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-PR3-F1-5 문단 글에 <script>가 있어도 첫 문단은 원문 그대로고 표 자리에 자리표시가 하나다', () => {
    const table = lines('<table>', '<tr><td>a</td></tr>', '', '<tr><td>b</td></tr>', '</table>');
    const md = `Avoid inline \`<script>\` tags.\n\n${table}\n`;
    const result = extractAssets(md);
    const found = placeholdersIn(result.indexingMarkdown);
    expect(found).toHaveLength(1);
    expect(result.indexingMarkdown.startsWith('Avoid inline `<script>` tags.\n\n')).toBe(true);
    expect(result.indexingMarkdown).not.toContain('<tr><td>b</td></tr>');
  });

  it('T-IDX-3 CRLF 문서는 줄바꿈이 그대로 남고 원문과 같게 재구성된다', () => {
    const md =
      '# 제목\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n![x](x.png)\r\n\r\n> 인용 ![q](q.png)\r\n';
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table', 'image', 'image']);
    expect(result.assets[0].tableMarkdown).toContain('\r\n');
    expect(rebuild(md, result)).toBe(md);
    // 줄바꿈이 모두 CRLF로 남는다
    expect(result.indexingMarkdown).not.toMatch(/(?<!\r)\n/);
    const countCrlf = (text: string): number => (text.match(/\r\n/g) ?? []).length;
    const inAssets = result.assets.reduce(
      (sum, asset) => sum + countCrlf(md.slice(asset.start, asset.end)),
      0,
    );
    expect(countCrlf(result.indexingMarkdown)).toBe(countCrlf(md) - inAssets);
  });

  it('T-IDX-3 끝 줄바꿈 없는 문서·표·이미지 없는 문서·빈 문서를 처리한다', () => {
    const noEol = lines('| a | b |', '| - | - |');
    const noEolResult = extractAssets(noEol);
    expect(noEolResult.indexingMarkdown).toBe('[[minerva:table:t1 | a, b]]');
    expect(rebuild(noEol, noEolResult)).toBe(noEol);

    const plain = lines('그냥 문단 [[minerva:t1 입니다', '', '끝');
    expect(extractAssets(plain)).toEqual({
      assets: [],
      indexingMarkdown: breakPlaceholderLike(plain),
    });

    expect(extractAssets('')).toEqual({ assets: [], indexingMarkdown: '' });
  });
});

describe('REQ-BE-2.2.2', () => {
  it('T-IDX-4 원본 본문의 자리표시 모양 문자열은 깨뜨려 자리표시로 읽히지 않는다', () => {
    const md = lines(
      '문단 [[minerva:table:x | y]] 끝',
      '',
      '```',
      '[[minerva:image:i9 | z]]',
      '```',
      '',
      '![a](a.png)',
    );
    const result = extractAssets(md);
    // 자리표시로 읽히는 것은 이미지가 만든 하나뿐이다
    expect(placeholdersIn(result.indexingMarkdown)).toHaveLength(1);
    expect(result.indexingMarkdown).toContain(`[[${ZWSP}minerva:table:x | y]]`);
    expect(rebuild(md, result)).toBe(md);
  });
});

describe('REQ-BE-2.2.3', () => {
  it('T-DESC-2 GFM 표의 설명은 머리 행 칸을 쉼표로 이은 것이다', () => {
    const result = extractAssets(lines('| 키 | 값 |', '| --- | --- |', '| a | b |'));
    expect(result.assets[0].description).toBe('키, 값');
  });

  it('T-DESC-3 이미지 설명은 대체 텍스트, 비면 파일 이름이고 빈 대체 텍스트의 alt는 null이다', () => {
    const md = lines('![](img/pic.png)', '', '![  ](q.png?x=1)', '', '![대체 *강조*](r.png)');
    const result = extractAssets(md);
    expect(result.assets.map((asset) => asset.description)).toEqual([
      'pic.png',
      'q.png',
      '대체 강조',
    ]);
    expect(result.assets[0].alt).toBeNull();
    expect(result.assets[1].alt).toBeNull();
  });

  it('T-DESC-3 대체 텍스트의 줄바꿈·]]·끝 ]는 설명에서 정리된다', () => {
    const md = lines('![줄', '바꿈](n.png)', '', '![a\\]\\] b](s.png)', '', '![끝\\]](t.png)');
    const result = extractAssets(md);
    const descriptions = result.assets.map((asset) => asset.description);
    expect(descriptions).toEqual(['줄 바꿈', 'a b', '끝']);
    for (const text of descriptions) {
      expect(text).not.toMatch(/[\r\n]/);
      expect(text).not.toContain(']]');
      expect(text.endsWith(']')).toBe(false);
    }
  });

  it('T-DESC-3 HTML 표 설명은 첫 행 칸 텍스트에서 태그를 뗀 것이다', () => {
    const result = extractAssets(
      lines(
        '<table>',
        '<tr><th>A</th><th><b>B</b></th></tr>',
        '<tr><td>1</td><td>2</td></tr>',
        '</table>',
      ),
    );
    expect(result.assets[0].description).toBe('A, B');
  });

  // ★ 결정 D10의 fallback("정리 결과가 비면 `표`") 근거다. 머리 칸이 모두 비면 쉼표만 남지 않고 `표`가 된다
  it('T-DESC-3 머리 칸이 모두 빈 표의 설명은 "표"다', () => {
    const result = extractAssets(lines('|  |  |', '| - | - |', '| 1 | 2 |'));
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].description).toBe('표');
  });
});
