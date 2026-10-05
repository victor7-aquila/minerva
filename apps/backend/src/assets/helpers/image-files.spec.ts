import { InvalidRequestError } from '../../common';
import type { UploadedImage } from '../interfaces/assets.types';
import {
  contentTypeOf,
  extensionOf,
  fileNameOfPath,
  indexUploads,
  matchKeysOfPath,
} from './image-files';

/** 업로드 이미지를 만든다. */
function upload(fileName: string): UploadedImage {
  return { fileName, contentType: 'image/png', data: Buffer.from([1, 2, 3]) };
}

describe('REQ-BE-1.1.3', () => {
  it.each([
    ['./img/a.png', 'a.png'],
    ['a.png?raw=1', 'a.png'],
    ['x/b.jpg#frag', 'b.jpg'],
    ['C:\\d\\c.gif', 'c.gif'],
    ['https://h/p/d.png', 'd.png'],
    ['noslash.webp', 'noslash.webp'],
  ])('T-PAIR-1 fileNameOfPath(%s)는 %s다', (input, expected) => {
    expect(fileNameOfPath(input)).toBe(expected);
  });

  it('T-PAIR-2 퍼센트 인코딩 경로의 키에 원래 값과 디코딩한 값이 모두 든다', () => {
    const keys = matchKeysOfPath('img/my%20pic.png');
    expect(keys).toEqual(expect.arrayContaining(['my%20pic.png', 'my pic.png']));
  });

  it('T-PAIR-2 잘못된 퍼센트 인코딩은 예외 없이 원래 값 하나만 준다', () => {
    expect(matchKeysOfPath('%E0%A4%A.png')).toEqual(['%E0%A4%A.png']);
  });

  it('T-PAIR-2 NFD 한글 경로의 키가 NFC 값과 같다', () => {
    const nfd = '한글.png'.normalize('NFD');
    expect(nfd).not.toBe('한글.png');
    expect(matchKeysOfPath(`img/${nfd}`)).toContain('한글.png'.normalize('NFC'));
  });
});

describe('REQ-BE-2.1.1', () => {
  it('T-PAIR-3 이름이 다른 업로드 둘은 키 둘로 색인된다', () => {
    const indexed = indexUploads([upload('a.png'), upload('b.png')]);
    expect([...indexed.keys()].sort()).toEqual(['a.png', 'b.png']);
  });

  it.each([
    ['같은 이름', 'a.png', 'a.png'],
    ['폴더만 다른 같은 이름', 'x/a.png', 'a.png'],
    ['NFC·NFD만 다른 한글 이름', '한글.png'.normalize('NFC'), '한글.png'.normalize('NFD')],
  ])('T-PAIR-3 %s이면 InvalidRequestError를 낸다', (_label, first, second) => {
    let caught: unknown;
    try {
      indexUploads([upload(first), upload(second)]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidRequestError);
    const error = caught as InvalidRequestError;
    expect(error.code).toBe('INVALID_REQUEST');
  });

  it.each([
    ['A.PNG', 'png'],
    ['b.jpeg', 'jpeg'],
    ['noext', 'bin'],
    ['.hidden', 'bin'],
    ['x.p n g', 'bin'],
  ])('T-PAIR-4 extensionOf(%s)는 %s다', (input, expected) => {
    expect(extensionOf(input)).toBe(expected);
  });

  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['svg', 'image/svg+xml'],
    ['webp', 'image/webp'],
  ])('T-PAIR-4 contentTypeOf(%s)는 업로드 값과 무관하게 %s다', (ext, expected) => {
    expect(contentTypeOf(ext, 'application/octet-stream')).toBe(expected);
  });

  it('T-PAIR-4 표 밖 확장자는 업로드 contentType을 쓰고 비면 octet-stream이다', () => {
    expect(contentTypeOf('bmp', 'image/bmp')).toBe('image/bmp');
    expect(contentTypeOf('bin', '')).toBe('application/octet-stream');
  });
});
