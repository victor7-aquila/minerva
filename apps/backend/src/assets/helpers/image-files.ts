import { InvalidRequestError } from '../../common';
import type { UploadedImage } from '../interfaces/assets.types';

/** 확장자별 contentType 고정 표다. */
const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** 마지막 `/`·`\` 뒤 부분을 돌려준다. */
function lastSegment(value: string): string {
  return value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
}

/** 이미지 경로에서 파일 이름을 뽑는다. */
export function fileNameOfPath(imagePath: string): string {
  const cut = imagePath.search(/[?#]/);
  const withoutQuery = cut >= 0 ? imagePath.slice(0, cut) : imagePath;
  return lastSegment(withoutQuery);
}

/** 이미지 경로의 짝 맞추기 키 목록을 만든다. */
export function matchKeysOfPath(imagePath: string): string[] {
  const name = fileNameOfPath(imagePath);
  if (name === '') return [];
  const keys = [name.normalize('NFC')];
  try {
    keys.push(decodeURIComponent(name).normalize('NFC'));
  } catch {
    // 디코딩할 수 없는 경로는 원래 값만 쓴다
  }
  return [...new Set(keys)];
}

/** 업로드 파일 이름의 짝 맞추기 키를 만든다. */
export function uploadKeyOf(fileName: string): string {
  return lastSegment(fileName).normalize('NFC');
}

/** 업로드 이미지를 키로 색인한다. */
export function indexUploads(images: readonly UploadedImage[]): Map<string, UploadedImage> {
  const indexed = new Map<string, UploadedImage>();
  for (const image of images) {
    const key = uploadKeyOf(image.fileName);
    if (indexed.has(key)) {
      throw new InvalidRequestError(`같은 이름의 이미지 파일이 여러 개 있습니다: ${key}`);
    }
    indexed.set(key, image);
  }
  return indexed;
}

/** 파일 이름에서 확장자를 뽑는다. */
export function extensionOf(fileName: string): string {
  const name = lastSegment(fileName);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'bin';
  const ext = name.slice(dot + 1).toLowerCase();
  // ★ 파일 키에 들어가므로 영문 소문자·숫자만 허용한다
  return /^[a-z0-9]+$/.test(ext) ? ext : 'bin';
}

/** 확장자와 업로드 값으로 contentType을 정한다. */
export function contentTypeOf(ext: string, uploaded: string): string {
  const fixed = CONTENT_TYPE_BY_EXT[ext];
  if (fixed !== undefined && Object.hasOwn(CONTENT_TYPE_BY_EXT, ext)) return fixed;
  const trimmed = uploaded.trim();
  return trimmed !== '' ? trimmed : 'application/octet-stream';
}
