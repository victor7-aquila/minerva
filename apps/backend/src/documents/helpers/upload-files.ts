import type { UploadedImage } from '../../assets';
import { InvalidRequestError, PayloadTooLargeError, UnsupportedFileError } from '../../common';
import type { EditionValue } from '../interfaces/documents.types';

/** 업로드 인터셉터가 넘기는 파일 중 쓰는 멤버다. ★ api를 import하지 않으려 로컬로 둔다 */
export interface UploadFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}
/** documents가 검사하는 형식별 크기 한도다. */
export interface UploadSizeLimits {
  maxMdBytes: number;
  maxImageBytes: number;
}
/** 업로드 MD 하나다. */
export interface UploadedMarkdown {
  fileName: string;
  markdown: string;
}
/** 분류한 업로드다. */
export interface ClassifiedUpload {
  markdowns: UploadedMarkdown[];
  images: UploadedImage[];
}
/** 문서 정보 하나(DTO 값)다. */
export interface UploadMetaInput {
  file_name: string;
  name: string;
  edition?: { label: string; edition_date: string } | null;
}
/** 문서 하나를 만들 값이다. */
export interface NewDocumentInput {
  fileName: string;
  markdown: string;
  name: string;
  edition: EditionValue | null;
}

/** 이미지로 받는 확장자다. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

/** 파일 이름에서 소문자 확장자를 구한다. 없으면 빈 문자열이다. */
function extensionOf(originalName: string): string {
  const base = originalName.slice(
    Math.max(originalName.lastIndexOf('/'), originalName.lastIndexOf('\\')) + 1,
  );
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 바이트 수를 한도 표기(MB·KB·바이트)로 바꾼다. */
export function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb}MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}KB`;
  return `${bytes}바이트`;
}

/** 업로드 파일을 형식별로 나누고 검증한다. */
export function classifyUpload(
  files: readonly UploadFile[] | undefined,
  limits: UploadSizeLimits,
  mode: 'upload' | 'content',
): ClassifiedUpload {
  if (files === undefined || files.length === 0) {
    throw new InvalidRequestError('올릴 파일이 없습니다');
  }
  const mdFiles: UploadFile[] = [];
  const imageFiles: UploadFile[] = [];
  const unsupported: string[] = [];
  for (const file of files) {
    const ext = extensionOf(file.originalname);
    if (ext === 'md') mdFiles.push(file);
    else if (IMAGE_EXTENSIONS.has(ext)) imageFiles.push(file);
    else unsupported.push(file.originalname);
  }
  if (unsupported.length > 0) {
    throw new UnsupportedFileError(`지원하지 않는 형식의 파일입니다: ${unsupported.join(', ')}`);
  }

  // ★ 한도와 같은 크기는 받는다
  const bigMd = mdFiles.filter((f) => f.buffer.length > limits.maxMdBytes);
  if (bigMd.length > 0) {
    throw new PayloadTooLargeError(
      `MD 파일 하나의 크기 한도(${formatBytes(limits.maxMdBytes)})를 넘었습니다: ${bigMd
        .map((f) => f.originalname)
        .join(', ')}`,
    );
  }
  const bigImages = imageFiles.filter((f) => f.buffer.length > limits.maxImageBytes);
  if (bigImages.length > 0) {
    throw new PayloadTooLargeError(
      `이미지 파일 하나의 크기 한도(${formatBytes(limits.maxImageBytes)})를 넘었습니다: ${bigImages
        .map((f) => f.originalname)
        .join(', ')}`,
    );
  }

  if (mode === 'upload' && mdFiles.length === 0) {
    throw new InvalidRequestError('MD 파일이 하나 이상 있어야 합니다');
  }
  if (mode === 'content' && mdFiles.length !== 1) {
    throw new InvalidRequestError('MD 파일은 정확히 하나여야 합니다');
  }

  // ★ ignoreBOM: true — BOM이 문자열에 남아 다시 UTF-8로 바꾸면 원래 바이트와 같다 (REQ-BE-1.1.7)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const markdowns = mdFiles.map((file): UploadedMarkdown => {
    try {
      return { fileName: file.originalname, markdown: decoder.decode(file.buffer) };
    } catch {
      throw new UnsupportedFileError(`UTF-8로 읽을 수 없는 MD 파일입니다: ${file.originalname}`);
    }
  });
  const images = imageFiles.map((file): UploadedImage => ({
    fileName: file.originalname,
    contentType: file.mimetype,
    data: file.buffer,
  }));
  return { markdowns, images };
}

/** MD와 문서 정보를 짝지어 만들 문서 목록을 만든다. */
export function matchMeta(
  markdowns: readonly UploadedMarkdown[],
  meta: readonly UploadMetaInput[],
): NewDocumentInput[] {
  const mdByName = new Map<string, UploadedMarkdown>();
  for (const md of markdowns) {
    const key = md.fileName.normalize('NFC');
    if (mdByName.has(key)) {
      throw new InvalidRequestError(`같은 이름의 MD 파일이 여러 개 있습니다: ${md.fileName}`);
    }
    mdByName.set(key, md);
  }
  const metaByName = new Map<string, UploadMetaInput>();
  for (const item of meta) {
    const key = item.file_name.normalize('NFC');
    if (metaByName.has(key)) {
      throw new InvalidRequestError(`같은 파일의 문서 정보가 여러 개 있습니다: ${item.file_name}`);
    }
    metaByName.set(key, item);
  }
  const mdNames = new Set(mdByName.keys());
  const metaNames = new Set(metaByName.keys());
  const withoutMeta = [...mdNames].filter((n) => !metaNames.has(n));
  if (withoutMeta.length > 0) {
    throw new InvalidRequestError(`문서 정보가 없는 MD 파일이 있습니다: ${withoutMeta.join(', ')}`);
  }
  const withoutMd = [...metaNames].filter((n) => !mdNames.has(n));
  if (withoutMd.length > 0) {
    throw new InvalidRequestError(
      `올린 MD 파일에 없는 문서 정보가 있습니다: ${withoutMd.join(', ')}`,
    );
  }
  return markdowns.map((md): NewDocumentInput => {
    const info = metaByName.get(md.fileName.normalize('NFC'));
    // ★ 위에서 짝을 모두 확인했으므로 있다
    if (info === undefined) throw new InvalidRequestError('문서 정보가 없는 MD 파일이 있습니다');
    return {
      fileName: md.fileName,
      markdown: md.markdown,
      name: info.name.trim(),
      edition: info.edition
        ? { label: info.edition.label.trim(), editionDate: info.edition.edition_date }
        : null,
    };
  });
}
