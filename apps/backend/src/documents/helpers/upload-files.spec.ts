import { InvalidRequestError, PayloadTooLargeError, UnsupportedFileError } from '../../common';
import { expectSafeKoreanMessage, uploadFile } from '../../../test/support/documents-fixtures';
import { classifyUpload, matchMeta } from './upload-files';
import type { UploadFile, UploadMetaInput } from './upload-files';

/** 크기 한도다. */
const LIMITS = { maxMdBytes: 1000, maxImageBytes: 2000 };

/** 함수를 실행해 던진 값을 돌려준다. 던지지 않으면 오류다. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('예외가 던져지지 않았습니다');
}

/** n바이트짜리 파일을 만든다. */
function sized(name: string, bytes: number): UploadFile {
  return uploadFile(name, Buffer.alloc(bytes, 97));
}

describe('REQ-BE-1.1.2', () => {
  it('T-UPF-1 지원하지 않는 형식이 있으면 그 이름을 모두 담아 UnsupportedFileError다', () => {
    const files = [
      uploadFile('a.md', 'x'),
      uploadFile('x.pdf', 'x'),
      uploadFile('y.txt', 'x'),
      uploadFile('noext', 'x'),
    ];
    const error = thrown(() => classifyUpload(files, LIMITS, 'upload'));
    expect(error).toBeInstanceOf(UnsupportedFileError);
    expect(error.message).toContain('x.pdf');
    expect(error.message).toContain('y.txt');
    expect(error.message).toContain('noext');
    expect(error.message).not.toContain('a.md');
  });

  it('T-UPF-2 확장자는 대소문자를 가리지 않고 경로는 떼며 MD·이미지로 나눈다', () => {
    const png = Buffer.from([1, 2, 3]);
    const files = [
      uploadFile('A.MD', 'a'),
      uploadFile('dir/b.md', 'b'),
      uploadFile('C.PNG', png, 'image/png'),
      uploadFile('d.jpeg', png, 'image/jpeg'),
      uploadFile('e.svg', png, 'image/svg+xml'),
      uploadFile('f.webp', png, 'image/webp'),
      uploadFile('g.gif', png, 'image/gif'),
      uploadFile('h.jpg', png, 'image/jpeg'),
    ];
    const result = classifyUpload(files, LIMITS, 'upload');
    expect(result.markdowns).toHaveLength(2);
    expect(result.images).toHaveLength(6);
    expect(result.images[0].fileName).toBe('C.PNG');
    expect(result.images[0].contentType).toBe('image/png');
    expect(result.images[0].data.equals(png)).toBe(true);
    expect(result.images.map((image) => image.contentType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/svg+xml',
      'image/webp',
      'image/gif',
      'image/jpeg',
    ]);
  });

  it('T-UPF-12 검사 순서는 형식, 크기, MD 개수 순이다', () => {
    // 형식 오류가 크기 오류보다 먼저다
    expect(
      thrown(() =>
        classifyUpload([uploadFile('x.pdf', 'x'), sized('big.md', 1001)], LIMITS, 'upload'),
      ),
    ).toBeInstanceOf(UnsupportedFileError);
    // 크기 오류가 MD 개수 오류보다 먼저다(MD 0개)
    expect(thrown(() => classifyUpload([sized('big.png', 2001)], LIMITS, 'upload'))).toBeInstanceOf(
      PayloadTooLargeError,
    );
  });
});

describe('REQ-BE-1.1.10', () => {
  it('T-UPF-3 MD는 한도와 같은 크기까지 받고 넘으면 이름이 담긴 PayloadTooLargeError다', () => {
    expect(() => classifyUpload([sized('ok.md', 1000)], LIMITS, 'upload')).not.toThrow();
    const error = thrown(() => classifyUpload([sized('big.md', 1001)], LIMITS, 'upload'));
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expectSafeKoreanMessage(error.message, ['big.md']);
  });

  it('T-UPF-4 이미지는 한도와 같은 크기까지 받고 넘으면 이미지 이름이 담긴 오류다', () => {
    const ok = [sized('a.md', 1000), sized('ok.png', 2000)];
    expect(() => classifyUpload(ok, LIMITS, 'upload')).not.toThrow();
    const over = [sized('a.md', 1000), sized('big.png', 2001)];
    const error = thrown(() => classifyUpload(over, LIMITS, 'upload'));
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expectSafeKoreanMessage(error.message, ['big.png']);
  });

  it('T-UPF-5 한도를 넘은 응답 메시지에 파일 이름이 담긴다(한도 표기 형식은 정하지 않는다)', () => {
    const error = thrown(() => classifyUpload([sized('big.md', 1001)], LIMITS, 'upload'));
    expect(error.message).toContain('big.md');
    expect(error.message).toMatch(/[0-9]/);
  });
});

describe('REQ-BE-1.1.1', () => {
  it('T-UPF-6 파일이 없거나 MD가 없으면 InvalidRequestError다', () => {
    expect(thrown(() => classifyUpload(undefined, LIMITS, 'upload'))).toBeInstanceOf(
      InvalidRequestError,
    );
    expect(thrown(() => classifyUpload([], LIMITS, 'upload'))).toBeInstanceOf(InvalidRequestError);
    const error = thrown(() => classifyUpload([sized('a.png', 3)], LIMITS, 'upload'));
    expect(error).toBeInstanceOf(InvalidRequestError);
    expectSafeKoreanMessage(error.message);
  });

  it('T-UPF-7 MD 순서대로 문서 정보를 짝지으며 이름·판 표기의 앞뒤 공백을 뗀다', () => {
    const markdowns = [
      { fileName: 'b.md', markdown: 'B' },
      { fileName: 'a.md', markdown: 'A' },
    ];
    const meta: UploadMetaInput[] = [
      {
        file_name: 'a.md',
        name: '  이름  ',
        edition: { label: ' v1 ', edition_date: '2026-01-02' },
      },
      { file_name: 'b.md', name: 'B문서' },
    ];
    const result = matchMeta(markdowns, meta);
    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe('b.md');
    expect(result[0].name).toBe('B문서');
    expect(result[0].edition).toBeNull();
    expect(result[1].fileName).toBe('a.md');
    expect(result[1].name).toBe('이름');
    expect(result[1].edition).toEqual({ label: 'v1', editionDate: '2026-01-02' });
  });

  it('T-UPF-7b 한글 파일 이름은 NFD·NFC가 달라도 짝지어진다', () => {
    const nfd = '한글.md'.normalize('NFD');
    const nfc = '한글.md'.normalize('NFC');
    expect(nfd).not.toBe(nfc);
    const result = matchMeta(
      [{ fileName: nfd, markdown: 'x' }],
      [{ file_name: nfc, name: '이름' }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe(nfd);
    expect(result[0].name).toBe('이름');
  });
});

describe('REQ-BE-1.1.6', () => {
  it('T-UPF-8 이름·정보가 중복되거나 짝이 없으면 그 파일 이름이 담긴 InvalidRequestError다', () => {
    const md = (fileName: string) => ({ fileName, markdown: 'x' });
    const info = (file_name: string): UploadMetaInput => ({ file_name, name: '이름' });

    const dupMd = thrown(() => matchMeta([md('dup.md'), md('dup.md')], [info('dup.md')]));
    expect(dupMd).toBeInstanceOf(InvalidRequestError);
    expect(dupMd.message).toContain('dup.md');

    const dupInfo = thrown(() => matchMeta([md('a.md')], [info('a.md'), info('a.md')]));
    expect(dupInfo).toBeInstanceOf(InvalidRequestError);
    expect(dupInfo.message).toContain('a.md');

    const noInfo = thrown(() => matchMeta([md('a.md'), md('lonely.md')], [info('a.md')]));
    expect(noInfo).toBeInstanceOf(InvalidRequestError);
    expect(noInfo.message).toContain('lonely.md');

    const noMd = thrown(() => matchMeta([md('a.md')], [info('a.md'), info('ghost.md')]));
    expect(noMd).toBeInstanceOf(InvalidRequestError);
    expect(noMd.message).toContain('ghost.md');
  });
});

describe('REQ-BE-1.1.7', () => {
  it('T-UPF-9 BOM과 CRLF를 그대로 두어 UTF-8로 되돌리면 입력 바이트와 같다', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('제목\r\n한글 본문\r\n', 'utf8'),
    ]);
    const { markdowns } = classifyUpload([uploadFile('a.md', bytes)], LIMITS, 'upload');
    expect(Buffer.from(markdowns[0].markdown, 'utf8').equals(bytes)).toBe(true);
  });

  it('T-UPF-10 UTF-8로 읽을 수 없는 MD는 UnsupportedFileError다', () => {
    const bad = Buffer.from([0xff, 0xfe, 0x41]);
    const error = thrown(() => classifyUpload([uploadFile('bad.md', bad)], LIMITS, 'upload'));
    expect(error).toBeInstanceOf(UnsupportedFileError);
    expectSafeKoreanMessage(error.message, ['bad.md']);
  });
});

describe('REQ-BE-1.6.1', () => {
  it('T-UPF-11 내용 다시 올리기는 MD가 정확히 하나여야 한다', () => {
    const none = thrown(() =>
      classifyUpload([uploadFile('a.png', Buffer.from([1]))], LIMITS, 'content'),
    );
    expect(none).toBeInstanceOf(InvalidRequestError);
    expectSafeKoreanMessage(none.message);
    const two = thrown(() =>
      classifyUpload([uploadFile('a.md', 'a'), uploadFile('b.md', 'b')], LIMITS, 'content'),
    );
    expect(two).toBeInstanceOf(InvalidRequestError);
    expectSafeKoreanMessage(two.message);
    const ok = classifyUpload(
      [
        uploadFile('a.md', 'a'),
        uploadFile('1.png', Buffer.from([1])),
        uploadFile('2.png', Buffer.from([2])),
      ],
      LIMITS,
      'content',
    );
    expect(ok.markdowns).toHaveLength(1);
    expect(ok.images).toHaveLength(2);
  });
});
