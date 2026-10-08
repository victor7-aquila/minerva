import { Catch, HttpException, Inject, Injectable } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DomainError, InvalidRequestError } from '../../common';
import { ERROR_STATUS, INTERNAL_ERROR, NOT_FOUND } from '../interfaces/error-status';
import { RequestValidationError } from '../helpers/validation';

/** 필터가 쓰는 요청 멤버다. ★ express는 직접 의존성이 아니라 로컬 인터페이스로 둔다 */
interface FilterRequest {
  originalUrl?: string;
  url?: string;
}

/** 필터가 쓰는 응답 멤버다. */
interface FilterResponse {
  readonly headersSent: boolean;
  status(code: number): FilterResponse;
  json(body: unknown): unknown;
}

/** 응답으로 내보낼 오류 값이다. */
interface MappedError {
  status: number;
  code: string;
  message: string;
}

const PAYLOAD_TOO_LARGE_MESSAGE = '요청 본문이 너무 큽니다';

/** 쿼리 문자열을 뗀 요청 경로를 돌려준다. */
function requestPath(req: FilterRequest): string {
  return String(req.originalUrl ?? req.url ?? '').split('?')[0];
}

/** 프레임워크(Nest·body-parser)가 던진 4xx면 그 상태를, 아니면 undefined를 돌려준다. */
function frameworkClientStatus(exception: unknown): number | undefined {
  let status: unknown;
  if (exception instanceof HttpException) {
    status = exception.getStatus();
  } else if (typeof exception === 'object' && exception !== null) {
    const candidate = exception as { status?: unknown; expose?: unknown };
    status = candidate.expose === true ? candidate.status : undefined;
  }
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/** 도메인 오류와 그 밖의 예외를 오류 응답으로 바꾼다. */
@Catch()
@Injectable()
export class DomainErrorFilter implements ExceptionFilter {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {
    this.logger.setContext('DomainErrorFilter');
  }

  /** 예외를 API.md 형식의 오류 응답으로 바꾼다. */
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const req = http.getRequest<FilterRequest>();
    const res = http.getResponse<FilterResponse>();
    const path = requestPath(req);

    const mapped = this.map(exception, path);
    if (mapped === undefined) {
      this.logUnhandled(exception, path);
    }
    if (res.headersSent) {
      return;
    }
    const { status, code, message }: MappedError = mapped ?? INTERNAL_ERROR;
    res.status(status).json({ error: { code, message } });
  }

  /** 예외를 응답 값으로 바꾼다. 500으로 처리할 예외면 undefined다. */
  private map(exception: unknown, path: string): MappedError | undefined {
    if (exception instanceof RequestValidationError) {
      this.logger.warn({ path, fields: [...exception.fields] }, 'api.request_invalid');
      return { status: 400, code: exception.code, message: exception.message };
    }
    if (exception instanceof DomainError) {
      const status = ERROR_STATUS[exception.code] as number | undefined;
      return status === undefined
        ? undefined
        : { status, code: exception.code, message: exception.message };
    }
    // ★ 프레임워크 오류의 message·getResponse()는 쓰지 않는다 (경로·입력 일부가 들어 있다)
    const clientStatus = frameworkClientStatus(exception);
    if (clientStatus === 404) {
      return { status: 404, code: NOT_FOUND.code, message: NOT_FOUND.message };
    }
    if (clientStatus === 413) {
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: PAYLOAD_TOO_LARGE_MESSAGE };
    }
    if (clientStatus !== undefined) {
      return { status: 400, code: 'INVALID_REQUEST', message: new InvalidRequestError().message };
    }
    return undefined;
  }

  /** 예상하지 못한 예외를 로그로 남긴다. ★ 스택의 첫 줄(이름·메시지)은 뗀다 */
  private logUnhandled(exception: unknown, path: string): void {
    const errorName = exception instanceof Error ? exception.name : 'UnknownError';
    if (exception instanceof Error && typeof exception.stack === 'string') {
      // ★ '    at '으로 시작하는 첫 줄부터만 남긴다. 그 앞은 모두 오류 메시지(여러 줄 가능)로 보고 버린다
      const lines = exception.stack.split('\n');
      const firstFrame = lines.findIndex((line) => line.startsWith('    at '));
      const stack = firstFrame === -1 ? '' : lines.slice(firstFrame).join('\n');
      this.logger.error({ path, errorName, stack }, 'api.unhandled');
      return;
    }
    this.logger.error({ path, errorName }, 'api.unhandled');
  }
}
