import type { MulterModuleOptions } from '@nestjs/platform-express';
import { PayloadTooLargeError } from '../../common';
import { fileTooLargeMessage, tooManyFilesMessage } from './upload-limits';
import { uploadStateOf } from './upload-state';

/** multer가 넘기는 파일 정보 중 쓰는 멤버다. */
interface IncomingFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  stream: NodeJS.ReadableStream;
}

type FileFilterCallback = (error: Error | null, accept: boolean) => void;
type HandleFileCallback = (error?: unknown, info?: { buffer: Buffer; size: number }) => void;

const STATE_MISSING = 'upload state missing';

/** 파일 수를 세고 한도를 넘으면 바로 거부한다. */
function countingFileFilter(req: object, _file: object, cb: FileFilterCallback): void {
  const state = uploadStateOf(req);
  if (state === undefined) {
    // ★ 인터셉터를 거치지 않은 호출 — 일어나면 안 되는 일이라 500으로 둔다
    cb(new Error(STATE_MISSING), false);
    return;
  }
  if (state.rejected) {
    cb(null, false);
    return;
  }
  state.fileCount += 1;
  if (state.fileCount > state.limits.maxFiles) {
    state.reject(new PayloadTooLargeError(tooManyFilesMessage(state.limits.maxFiles)));
    cb(null, false);
    return;
  }
  cb(null, true);
}

/** 파일 하나 크기를 세며 메모리에 모으는 multer 저장 엔진이다. */
const limitedMemoryStorage = {
  _handleFile(req: object, file: IncomingFile, cb: HandleFileCallback): void {
    const state = uploadStateOf(req);
    if (state === undefined) {
      cb(new Error(STATE_MISSING));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    file.stream.on('data', (chunk: Buffer) => {
      if (state.rejected) {
        return;
      }
      size += chunk.length;
      // ★ 한도와 같은 크기는 받는다
      if (size > state.limits.maxFileBytes) {
        chunks.length = 0;
        state.reject(
          new PayloadTooLargeError(
            fileTooLargeMessage(file.originalname, state.limits.maxFileBytes),
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    file.stream.on('end', () => {
      if (state.rejected) {
        cb(null, { buffer: Buffer.alloc(0), size: 0 });
        return;
      }
      cb(null, { buffer: Buffer.concat(chunks), size });
    });
    file.stream.on('error', (error: Error) => cb(error));
  },
  _removeFile(_req: object, file: { buffer?: Buffer }, cb: (error?: Error | null) => void): void {
    delete file.buffer;
    cb(null);
  },
};

/** multipart 파서(multer) 옵션을 만든다. 한도는 요청별 상태에서 읽는다. */
export function createMulterOptions(): MulterModuleOptions {
  return {
    storage: limitedMemoryStorage,
    fileFilter: countingFileFilter,
    // ★ 파일 이름을 UTF-8로 읽는다 (기본 latin1이면 한글 이름이 깨진다)
    defParamCharset: 'utf8',
    // ★ limits.files·fileSize를 주지 않는다. multer는 한도 오류 때 본문을 끝까지 비운 뒤에야 알리므로
    //   파일 수·크기는 위 필터·엔진이 직접 세어 바로 거부한다
  };
}
