import { extractAssets } from './markdown-assets';
import type { Extraction } from './markdown-assets';
import { breakPlaceholderLike, unbreakPlaceholderLike } from './placeholder';

// ★ 자리표시 형식은 루트 IF-1의 리터럴이다. 구현 상수에 기대지 않는다
const IF1_ANYWHERE = /\[\[minerva:(table|image):([a-z0-9]+) \| [^\n]*?\]\]/g;
const ZWSP = String.fromCharCode(0x200b);

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
  expect(found).toHaveLength(extraction.assets.length);
  let out = '';
  let cursor = 0;
  found.forEach((match, index) => {
    const asset = extraction.assets[index];
    expect(match[1]).toBe(asset.kind);
    expect(match[2]).toBe(asset.placeholderId);
    const before = extraction.indexingMarkdown.slice(cursor, match.index);
    out += unbreakPlaceholderLike(before) + markdown.slice(asset.start, asset.end);
    cursor = match.index + match[0].length;
  });
  return out + unbreakPlaceholderLike(extraction.indexingMarkdown.slice(cursor));
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

  it('T-EXT-6 GFM 표 칸 안의 이미지는 표의 일부라 따로 등록하지 않는다', () => {
    const md = lines('| a | b |', '| - | - |', '| ![a](a.png) | x |');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toContain('![a](a.png)');
    expect(rebuild(md, result)).toBe(md);
  });

  it('T-EXT-6 HTML 표 안의 <img>는 표의 일부라 따로 등록하지 않는다', () => {
    const md = lines('<table>', '<tr><td><img src="b.png"></td></tr>', '</table>');
    const result = extractAssets(md);
    expect(kindsOf(result)).toEqual(['table']);
    expect(result.assets[0].tableMarkdown).toContain('<img src="b.png">');
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
