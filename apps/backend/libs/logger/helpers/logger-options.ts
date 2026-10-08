import { IncomingMessage } from 'node:http';
import { stdSerializers } from 'pino';
import type { DestinationStream } from 'pino';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import {
  CIRCULAR,
  FORBIDDEN_LOG_KEYS,
  REDACTED_LOG_PATHS,
  REMOVED,
} from '../interfaces/log-constants';

/** 평범한 객체인지 본다. 클래스 인스턴스는 아니다. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ancestors: 지금 내려온 경로 위의 객체들. 경로를 벗어나면 뺀다 — 공유 참조는 순환이 아니다
/** 값을 재귀로 훑어 금지 키의 값을 지운 복사본을 만든다. */
function scrub(value: unknown, ancestors: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    const copied = value.map((item: unknown) => scrub(item, ancestors));
    ancestors.delete(value);
    return copied;
  }
  // ★ 클래스 인스턴스(IncomingMessage·ServerResponse·Error·Date·Buffer 등)는 같은 참조로 넘긴다.
  //   formatters.log는 serializer보다 먼저 돈다. pino-http의 원본 req·res를 복사하면 serializer가 깨진다
  if (!isPlainObject(value)) return value;
  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);
  const copied: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    copied[key] = FORBIDDEN_LOG_KEYS.has(key) ? REMOVED : scrub(inner, ancestors);
  }
  ancestors.delete(value);
  return copied;
}

/** 객체를 끝까지 훑어 금지 키의 값을 지운 복사본을 만든다. */
export function scrubForbiddenKeys(value: unknown): unknown {
  return scrub(value, new Set<object>());
}

/** 파싱할 수 없는 로그 줄 자리에 내보내는 고정 줄이다. */
const UNPARSEABLE_LINE = '{"level":50,"msg":"logger.unparseable"}';

/** 직렬화된 로그 한 줄에서 금지 키를 지운 줄을 만든다. 파싱에 실패하면 원문 대신 고정 줄을 낸다. */
function scrubLine(line: string): string {
  try {
    return JSON.stringify(scrubForbiddenKeys(JSON.parse(line)));
  } catch {
    // ★ 원문을 내보내지 않는다. 통과시키면 스크럽 우회로가 된다
    return UNPARSEABLE_LINE;
  }
}

/** URL에서 쿼리(`?`)와 프래그먼트(`#`) 이후를 뗀다. */
function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

// ★ 요청 직렬화: url과 referer 헤더의 쿼리를 뗀다. 쿼리 문자열에 사용자 입력이 실릴 수 있다 (REQ-BE-8.2.1)
/** pino 기본 요청 직렬화 결과에서 url·referer의 쿼리를 뗀다. */
function serializeRequest(req: unknown): Record<string, unknown> {
  // ★ pino-http는 이미 직렬화한 req를 넘긴다. 다시 직렬화하면 socket이 없어 remoteAddress·remotePort가 빠진다.
  //   IncomingMessage일 때만 표준 serializer를 쓰고, 그 밖(평범한 객체 등)은 복사해 같은 규칙을 적용한다
  const serialized =
    req instanceof IncomingMessage
      ? (stdSerializers.req(req) as unknown as Record<string, unknown>)
      : { ...(req as Record<string, unknown>) };
  if (typeof serialized.url === 'string') serialized.url = stripQuery(serialized.url);
  const headers = serialized.headers;
  if (headers !== null && typeof headers === 'object') {
    const copied = { ...(headers as Record<string, unknown>) };
    for (const name of ['referer', 'referrer']) {
      const value = copied[name];
      if (typeof value === 'string') copied[name] = stripQuery(value);
    }
    serialized.headers = copied;
  }
  return serialized;
}

/** 금지 데이터를 지우는 pino-http 옵션을 만든다. */
export function createPinoHttpOptions(): Options {
  return {
    formatters: {
      // 로그 호출의 필드 객체 — logger.info({ ... }, '모듈.동작')
      log: (fields) => scrubForbiddenKeys(fields) as Record<string, unknown>,
      // ★ 루트 로거의 기본 바인딩(pid·hostname 등)에만 적용된다. logger.child({ ... }) 바인딩에는 적용되지 않으며,
      //   child 경로는 아래 hooks.streamWrite가 맡는다
      bindings: (bindings) => scrubForbiddenKeys(bindings) as Record<string, unknown>,
    },
    hooks: {
      // ★ pino 공개 훅 streamWrite — 직렬화된 줄이 어떤 출력 대상으로 가기 직전에 모든 깊이(child 바인딩·클래스 인스턴스 포함)를 훑는다
      streamWrite: (line: string) => `${scrubLine(line.trim())}\n`,
    },
    serializers: { req: serializeRequest },
    redact: { paths: [...REDACTED_LOG_PATHS], censor: REMOVED },
  };
}

/** nestjs-pino LoggerModule 설정을 만든다. 출력 대상을 주면 그곳에 쓴다. */
export function createLoggerParams(destination?: DestinationStream): Params {
  const options = createPinoHttpOptions();
  return { pinoHttp: destination ? [options, destination] : options };
}
