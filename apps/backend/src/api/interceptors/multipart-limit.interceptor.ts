import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Observable } from 'rxjs';
import { DomainError, InvalidRequestError, PayloadTooLargeError } from '../../common';
import type { AppConfig } from '../../common';
import { readUploadLimits, requestTooLargeMessage } from '../helpers/upload-limits';
import type { UploadLimits } from '../helpers/upload-limits';
import { openUploadState } from '../helpers/upload-state';
import type { ClosableResponse } from '../helpers/upload-state';

/** 업로드 파일을 받는 multipart 필드 이름이다 (API.md `files`). */
export const UPLOAD_FIELD = 'files';

/** 내부 FilesInterceptor 인스턴스의 주입 토큰이다. */
export const UPLOAD_FILES_INTERCEPTOR = Symbol('UPLOAD_FILES_INTERCEPTOR');

/** 업로드 요청 형식 오류 메시지다. */
const UPLOAD_FORMAT_MESSAGE = '업로드 요청 형식이 올바르지 않습니다';

/** multipart Content-Type이다. */
const MULTIPART_TYPE = /^multipart\//i;

/** RFC 7231 token이다. */
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";

/** 매개변수 값(token 또는 quoted-string)이다. */
const PARAM_VALUE = `(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*")`;

/** 받는 업로드 Content-Type이다. ★ busboy가 읽을 수 있는 모양만 통과시킨다 */
const FORM_DATA_TYPE = new RegExp(
  `^multipart/form-data(?:[ \\t]*;[ \\t]*${TOKEN}[ \\t]*=[ \\t]*${PARAM_VALUE})*[ \\t]*;?[ \\t]*$`,
  'i',
);

/** 업로드로 읽을 Content-Type인가를 본다. */
function isAcceptedFormData(contentType: string): boolean {
  return FORM_DATA_TYPE.test(contentType);
}

/** multipart 요청에서 쓰는 요청 멤버다. */
interface UploadRequest {
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/** multer 등이 던진 오류를 응답용 도메인 오류로 바꾼다. ★ 원래 메시지는 쓰지 않는다 */
function toUploadError(error: unknown): unknown {
  if (error instanceof DomainError) {
    return error;
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 413) {
      return new PayloadTooLargeError();
    }
    if (status >= 400 && status < 500) {
      return new InvalidRequestError(UPLOAD_FORMAT_MESSAGE);
    }
  }
  // ★ busboy 1.6의 생성 오류 문구에 기댄다. 엄격 검사가 놓친 모양만 여기로 온다
  if (
    error instanceof Error &&
    (error.message === 'Malformed content type' ||
      error.message.startsWith('Unsupported content type:'))
  ) {
    return new InvalidRequestError(UPLOAD_FORMAT_MESSAGE);
  }
  return error;
}

/** multipart 요청의 파일 수·파일 크기·요청 크기 한도를 본문을 끝까지 읽기 전에 지킨다. */
@Injectable()
export class MultipartLimitInterceptor implements NestInterceptor {
  private readonly limits: UploadLimits;

  constructor(
    @Inject(UPLOAD_FILES_INTERCEPTOR) private readonly files: NestInterceptor,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.limits = readUploadLimits(config);
  }

  /** multipart 요청이면 한도를 지키며 파일을 읽고, 아니면 그대로 넘긴다. */
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<UploadRequest>();
    const res = http.getResponse<ClosableResponse>();

    const contentType = req.headers['content-type'];
    const type = typeof contentType === 'string' ? contentType : '';
    if (!MULTIPART_TYPE.test(type)) {
      return next.handle();
    }
    if (!isAcceptedFormData(type)) {
      // ★ 본문을 읽지 않는다
      res.setHeader('Connection', 'close');
      throw new InvalidRequestError(UPLOAD_FORMAT_MESSAGE);
    }

    const { maxTotalBytes } = this.limits;
    const rawLength = req.headers['content-length'];
    const declared = typeof rawLength === 'string' ? Number(rawLength) : Number.NaN;
    if (Number.isFinite(declared) && declared > maxTotalBytes) {
      // ★ 본문을 한 바이트도 읽지 않는다
      res.setHeader('Connection', 'close');
      throw new PayloadTooLargeError(requestTooLargeMessage(maxTotalBytes));
    }

    const state = openUploadState(req, res, this.limits);
    const onData = (chunk: Buffer): void => {
      state.totalBytes += chunk.length;
      if (state.totalBytes > maxTotalBytes) {
        state.reject(new PayloadTooLargeError(requestTooLargeMessage(maxTotalBytes)));
      }
    };
    // ★ 내부 인터셉터를 부르기 직전 같은 틱에 단다 (첫 청크를 놓치지 않는다)
    req.on('data', onData);

    const parsing = Promise.resolve(this.files.intercept(context, next));
    // ★ 거부가 먼저 이긴 뒤 multer가 늦게 실패해도 처리되지 않은 거부가 없게 한다
    parsing.catch(() => undefined);
    try {
      return (await Promise.race([parsing, state.rejection])) as Observable<unknown>;
    } catch (error) {
      throw toUploadError(error);
    } finally {
      req.off('data', onData);
    }
  }
}
