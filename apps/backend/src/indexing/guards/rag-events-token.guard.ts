import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { UnauthorizedError } from '../../common';
import type { AppConfig } from '../../common';

/** 알림 토큰 헤더 이름이다(IF-2). ★ Node는 헤더 이름을 소문자로 준다 */
const TOKEN_HEADER = 'x-minerva-token';

/** 가드가 쓰는 요청 멤버다. ★ express는 직접 의존성이 아니라 로컬 인터페이스로 둔다 */
interface GuardRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** 문자열의 SHA-256 다이제스트를 만든다. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** RAG Server 알림의 토큰을 검사한다. */
@Injectable()
export class RagEventsTokenGuard implements CanActivate {
  /** ★ 설정 토큰의 다이제스트만 둔다. 원문을 필드로 두지 않는다 */
  private readonly expectedDigest: Buffer;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('RagEventsTokenGuard');
    this.expectedDigest = digest(config.get('RAG_EVENTS_TOKEN', { infer: true }));
  }

  /** 토큰이 맞으면 통과시키고, 없거나 다르면 UnauthorizedError를 던진다. */
  canActivate(context: ExecutionContext): boolean {
    const value = context.switchToHttp().getRequest<GuardRequest>().headers[TOKEN_HEADER];
    const tokenPresent = typeof value === 'string' && value !== '';
    // ★ 둘 다 SHA-256 32바이트라 길이가 달라도 시간이 일정하고 예외가 없다
    if (tokenPresent && timingSafeEqual(digest(value), this.expectedDigest)) return true;
    // ★ 받은 값·설정 값을 로그에 넣지 않는다
    this.logger.warn({ tokenPresent }, 'indexing.event_unauthorized');
    throw new UnauthorizedError();
  }
}
