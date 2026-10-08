import crypto from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { UnauthorizedError } from '../../common';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import { RagEventsTokenGuard } from './rag-events-token.guard';

// ★ nestjs-pino는 루트 로거를 파일당 하나만 만든다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

const TOKEN = 'secret-token-1234';
/** 로그 비노출 검사용 센티널이다. */
const TOKEN_SENT = 'TOKEN-SENT-87';
const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];

let moduleRef: TestingModule;
let guard: RagEventsTokenGuard;

beforeEach(async () => {
  capture.clear();
  moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({ RAG_EVENTS_TOKEN: TOKEN }, capture.stream)],
    providers: [RagEventsTokenGuard],
  }).compile();
  guard = moduleRef.get(RagEventsTokenGuard);
});

afterEach(async () => {
  await moduleRef.close();
});

/** 헤더만 가진 실행 컨텍스트를 만든다. */
function ctx(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

/** 가드의 거부 로그에서 pino 기본 필드를 뺀 값을 읽는다. */
function denyLogs(): Record<string, unknown>[] {
  return capture
    .parsed()
    .filter((line) => line.msg === 'indexing.event_unauthorized')
    .map((line) =>
      Object.fromEntries(Object.entries(line).filter(([key]) => !PINO_BASE.includes(key))),
    );
}

/** 가드가 거부했는지 확인하고 던진 오류를 돌려준다. */
function rejection(headers: Record<string, unknown>): unknown {
  try {
    guard.canActivate(ctx(headers));
  } catch (error) {
    return error;
  }
  throw new Error('거부되지 않았습니다');
}

describe('REQ-BE-3.2.5', () => {
  it('T-TOK-1 가드는 같은 값만 통과시키고 길이가 달라도 예외 없이 거부한다', () => {
    const passes = (token: string): boolean => {
      try {
        return guard.canActivate(ctx({ 'x-minerva-token': token }));
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedError);
        return false;
      }
    };
    expect(passes(TOKEN)).toBe(true);
    expect(passes('secret-token-1235')).toBe(false);
    expect(passes('secret')).toBe(false);
    expect(passes('secret-token-1234-and-much-longer-value')).toBe(false);
    expect(passes('x')).toBe(false);
  });

  it('T-TOK-1b 길이가 달라도 가드가 같은 길이의 다이제스트로 timingSafeEqual을 부른다', () => {
    // ★ 시간 자체는 못 재므로 호출 여부와 인자 길이(SHA-256 32바이트)만 본다
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect(rejection({ 'x-minerva-token': 'secret' })).toBeInstanceOf(UnauthorizedError);
      expect(spy).toHaveBeenCalled();
      for (const [a, b] of spy.mock.calls) {
        expect((a as Uint8Array).byteLength).toBe(32);
        expect((b as Uint8Array).byteLength).toBe(32);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('T-TOK-2 맞는 토큰이면 통과하고 로그가 없다', () => {
    expect(guard.canActivate(ctx({ 'x-minerva-token': TOKEN }))).toBe(true);
    expect(denyLogs()).toHaveLength(0);
  });

  it('T-TOK-3 헤더가 없으면 UnauthorizedError와 경고 로그다', () => {
    const error = rejection({});
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as UnauthorizedError).code).toBe('UNAUTHORIZED');
    expect((error as UnauthorizedError).message).toBe('알림 토큰이 없거나 올바르지 않습니다');
    expect(denyLogs()).toEqual([{ tokenPresent: false }]);
    expect(capture.parsed().find((l) => l.msg === 'indexing.event_unauthorized')?.level).toBe(40);
  });

  it('T-TOK-4 틀린 토큰이면 거부하고 받은 값·설정 값을 로그에 남기지 않는다', () => {
    expect(rejection({ 'x-minerva-token': TOKEN_SENT })).toBeInstanceOf(UnauthorizedError);
    expect(denyLogs()).toEqual([{ tokenPresent: true }]);
    const text = capture.lines.join('\n');
    expect(text).not.toContain(TOKEN_SENT);
    expect(text).not.toContain(TOKEN);
  });

  it('T-TOK-5 빈 값과 배열 헤더는 토큰이 없는 것으로 거부한다', () => {
    expect(rejection({ 'x-minerva-token': '' })).toBeInstanceOf(UnauthorizedError);
    expect(rejection({ 'x-minerva-token': [TOKEN] })).toBeInstanceOf(UnauthorizedError);
    expect(denyLogs()).toEqual([{ tokenPresent: false }, { tokenPresent: false }]);
  });

  it('T-TOK-6 설정 토큰의 앞부분이나 뒤에 붙인 값은 거부한다', () => {
    expect(rejection({ 'x-minerva-token': 'secret-token-123' })).toBeInstanceOf(UnauthorizedError);
    expect(rejection({ 'x-minerva-token': 'secret-token-12345' })).toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
