import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';
import { InvalidRequestError } from '../../common';

/** 요청 검증 실패다. 문제가 된 필드 이름을 함께 든다. ★ api 내부 전용 — 배럴에 넣지 않는다 */
export class RequestValidationError extends InvalidRequestError {
  /** 문제가 된 필드 이름(중첩은 점으로 이음). ★ 값은 담지 않는다 */
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(
      fields.length > 0
        ? `요청 형식이 올바르지 않습니다. 확인할 필드: ${fields.join(', ')}`
        : '요청 형식이 올바르지 않습니다',
    );
    this.fields = Object.freeze([...fields]);
  }
}

/** 검증 오류 목록에서 문제가 된 필드 경로를 모은다. */
export function collectFieldPaths(errors: readonly ValidationError[], parent?: string): string[] {
  const paths: string[] = [];
  for (const e of errors) {
    // ★ value·target·constraints 문장은 읽지 않는다 (입력값이 들어 있을 수 있다)
    const path = parent === undefined ? e.property : `${parent}.${e.property}`;
    if (e.constraints !== undefined && Object.keys(e.constraints).length > 0) {
      paths.push(path);
    }
    if (e.children !== undefined && e.children.length > 0) {
      paths.push(...collectFieldPaths(e.children, path));
    }
  }
  return [...new Set(paths)];
}

/** 전역 요청 검증 파이프를 만든다. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // ★ 오류 객체에 입력값·대상 객체를 담지 않는다 (메시지·로그로 새는 길을 막는다)
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new RequestValidationError(collectFieldPaths(errors)),
  });
}
