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
      return new InvalidRequestError('업로드 요청 형식이 올바르지 않습니다');
    }
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
    if (!/^multipart\//i.test(typeof contentType === 'string' ? contentType : '')) {
      return next.handle();
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
