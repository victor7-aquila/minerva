import MarkdownIt from 'markdown-it';
import {
  breakPlaceholderLike,
  escapeImageAlt,
  formatPlaceholder,
  imageUrlOf,
  placeholderIdsIn,
  restoreText,
  sanitizeDescription,
  unbreakPlaceholderLike,
} from './placeholder';
import type { RestoreSource } from './placeholder';

// ★ 자리표시 형식은 루트 IF-1의 리터럴이다. 구현 상수에 기대지 않는다
const IF1_STRICT = /^\[\[minerva:(table|image):[a-z0-9]+ \| [^\n]*\]\]$/;
const IF1_ANYWHERE = /\[\[minerva:(table|image):[a-z0-9]+ \| [^\n]*?\]\]/g;
const ZWSP = String.fromCharCode(0x200b);

/** 문장을 Markdown으로 파싱해 이미지 토큰들을 돌려준다. */
function parseImages(markdown: string): Array<{ src: string }> {
  const tokens = new MarkdownIt().parse(markdown, {});
  const images: Array<{ src: string }> = [];
  for (const token of tokens) {
    for (const child of token.children ?? []) {
      if (child.type === 'image') images.push({ src: child.attrGet('src') ?? '' });
    }
  }
  return images;
}

/** 복원 원본 하나를 만든다. */
function source(overrides: Partial<RestoreSource>): RestoreSource {
  return { kind: 'image', tableMarkdown: null, text: '문장', imageUrl: null, ...overrides };
}

describe('REQ-BE-2.2.1', () => {
  it('T-FMT-1 formatPlaceholder는 IF-1 형식의 문자열을 만든다', () => {
    const result = formatPlaceholder('table', 't1', '키, 값');
    expect(result).toBe('[[minerva:table:t1 | 키, 값]]');
    expect(result).toMatch(IF1_STRICT);
    expect(formatPlaceholder('image', 'i12', '그림')).toMatch(IF1_STRICT);
  });
});

describe('REQ-BE-2.2.3', () => {
  it.each([
    ['a\nb\r\nc', 'a b c'],
    ['x ]] y', 'x y'],
    ['끝]', '끝'],
  ])('T-DESC-1 sanitizeDescription(%j)는 %j다', (input, expected) => {
    expect(sanitizeDescription(input, 'FB')).toBe(expected);
  });

  it.each([']]]', '   ', ''])('T-DESC-1 sanitizeDescription(%j)는 fallback이다', (input) => {
    expect(sanitizeDescription(input, 'FB')).toBe('FB');
  });

  it('T-DESC-1 자리표시 모양 설명은 [[ 뒤에 U+200B가 들어간다', () => {
    const result = sanitizeDescription('[[minerva:table:x | y', 'FB');
    expect(result.startsWith(`[[${ZWSP}`)).toBe(true);
  });

  it.each([
    'a\nb',
    'a\r\nb',
    'a\rb',
    'x]] y',
    'x]]]',
    'q] ]',
    ' ] ] ] ',
    '[[minerva:image:i1 | z]]',
    'a]\n]b]',
    '끝]]\n',
  ])('T-DESC-1 입력 %j의 결과에는 줄바꿈·]]이 없고 ]로 끝나지 않는다', (input) => {
    const result = sanitizeDescription(input, 'FB');
    expect(result).not.toMatch(/[\r\n]/);
    expect(result).not.toContain(']]');
    expect(result.endsWith(']')).toBe(false);
  });
});

describe('REQ-BE-2.2.2', () => {
  it('T-BRK-1 깨뜨린 문자열은 IF-1 자리표시로 읽히지 않고 되돌리면 원문과 같다', () => {
    const original = '[[minerva:table:x | y]]';
    const broken = breakPlaceholderLike(original);
    expect(broken.match(IF1_ANYWHERE)).toBeNull();
    expect(unbreakPlaceholderLike(broken)).toBe(original);
  });

  it.each([`[[${ZWSP}minerva:a`, `[[${ZWSP}${ZWSP}minerva:a`])(
    'T-BRK-2 이미 U+200B가 있는 %j도 왕복하면 원문과 같다',
    (original) => {
      const broken = breakPlaceholderLike(original);
      expect(broken).not.toBe(original);
      expect(unbreakPlaceholderLike(broken)).toBe(original);
    },
  );

  it.each(['[[minervax', '[minerva:', '[[MINERVA:'])('T-BRK-2 %j는 바뀌지 않는다', (text) => {
    expect(breakPlaceholderLike(text)).toBe(text);
  });
});

describe('REQ-BE-2.5.2', () => {
  it('T-ESC-1 escapeImageAlt는 역슬래시를 먼저, 대괄호를 이스케이프하고 줄바꿈을 공백으로 바꾼다', () => {
    expect(escapeImageAlt('a[b]c\\')).toBe('a\\[b\\]c\\\\');
    expect(escapeImageAlt('a\nb\r\nc')).toBe('a b c');
  });

  it.each(['a[b]c\\', '[x]', '끝]', '역슬래시\\', '[[깊게]]', 'a\\]b'])(
    'T-ESC-1 캡션 %j를 넣어도 이미지 하나로 파싱되고 src가 보존된다',
    (caption) => {
      const images = parseImages(`![${escapeImageAlt(caption)}](u)`);
      expect(images).toEqual([{ src: 'u' }]);
    },
  );

  it('T-RST-P2 이미지(주소 있음)는 ![캡션](주소)로 복원되고 이미지 하나로 파싱된다', () => {
    const sources = new Map([
      ['i1', source({ text: '캡션 [a] \\', imageUrl: '/v1/documents/d/versions/1/assets/i1' })],
    ]);
    const restored = restoreText('앞 [[minerva:image:i1 | 설명]] 뒤', sources);
    expect(restored.startsWith('앞 ![')).toBe(true);
    expect(restored.endsWith('](/v1/documents/d/versions/1/assets/i1) 뒤')).toBe(true);
    expect(parseImages(restored)).toEqual([{ src: '/v1/documents/d/versions/1/assets/i1' }]);
  });

  it('T-RST-P2 이미지(주소 없음)는 캡션 문장만으로 복원된다', () => {
    const sources = new Map([['i1', source({ text: '캡션 문장', imageUrl: null })]]);
    expect(restoreText('[[minerva:image:i1 | 설명]]', sources)).toBe('캡션 문장');
  });
});

describe('REQ-BE-2.4.1', () => {
  it('T-URL-1 imageUrlOf는 각 조각을 인코딩한 호스트 없는 경로를 만든다', () => {
    const url = imageUrlOf('d 1', 'v/2', 'i1');
    expect(url).toBe('/v1/documents/d%201/versions/v%2F2/assets/i1');
    expect(url.startsWith('/v1/')).toBe(true);
    expect(url).not.toMatch(/^[a-z]+:\/\//);
  });
});

describe('REQ-BE-2.5.1', () => {
  it('T-RST-P1 표 자리표시는 tableMarkdown 그대로(여러 줄)로 바뀌고 앞뒤 글자는 보존된다', () => {
    const table = '| 키 | 값 |\n| --- | --- |\n| a | b |';
    const sources = new Map([['t1', source({ kind: 'table', tableMarkdown: table })]]);
    expect(restoreText('앞\n[[minerva:table:t1 | 키, 값]]\n뒤', sources)).toBe(`앞\n${table}\n뒤`);
  });

  it('T-RST-P3 모르는 ID와 종류가 다른 ID는 자리표시 그대로 둔다', () => {
    const sources = new Map([['i1', source({ kind: 'image', text: '문장' })]]);
    const text = '[[minerva:table:t9 | x]] 와 [[minerva:table:i1 | y]]';
    expect(restoreText(text, sources)).toBe(text);
  });

  it('T-RST-P3 깨뜨린 문자열은 되돌리고 바꿔 넣은 표 원문 안의 깨뜨린 문자열은 건드리지 않는다', () => {
    const table = `| 열 |\n| --- |\n| [[${ZWSP}minerva:table:x |`;
    const sources = new Map([['t1', source({ kind: 'table', tableMarkdown: table })]]);
    const text = `[[${ZWSP}minerva:table:z | q]] 그리고 [[minerva:table:t1 | 열]]`;
    expect(restoreText(text, sources)).toBe(`[[minerva:table:z | q]] 그리고 ${table}`);
  });
});

describe('REQ-BE-2.5.3', () => {
  it('T-RST-P4 placeholderIdsIn은 중복 없이 처음 나온 순서로 ID를 주고 깨뜨린 것은 뺀다', () => {
    const text = [
      '[[minerva:image:i2 | a]]',
      '[[minerva:table:t1 | b]]',
      '[[minerva:image:i2 | a]]',
      `[[${ZWSP}minerva:table:t7 | c]]`,
    ].join('\n');
    expect(placeholderIdsIn(text)).toEqual(['i2', 't1']);
  });
});
