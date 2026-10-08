import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import { DOC_A } from '../../../test/support/evaluation-fixtures';
import { CreateGoldenSetDto, GoldenSetIdParamDto, ListGoldenSetsQueryDto } from './evaluation.dto';

/** 검증 오류에서 문제가 된 필드 경로를 모은다. */
function paths(errors: ValidationError[], parent?: string): string[] {
  return errors.flatMap((error) => {
    const path = parent === undefined ? error.property : `${parent}.${error.property}`;
    const own = error.constraints !== undefined ? [path] : [];
    return [...own, ...paths(error.children ?? [], path)];
  });
}

/** 전역 파이프와 같은 옵션으로 검증해 실패 필드 경로 목록을 돌려준다. */
async function failedOf<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return paths(errors);
}

/** 추가 요청을 검증한다. */
function failedCreate(plain: Record<string, unknown>): Promise<string[]> {
  return failedOf(CreateGoldenSetDto, plain);
}

/** 목록 요청을 검증한다. */
function failedList(plain: Record<string, unknown>): Promise<string[]> {
  return failedOf(ListGoldenSetsQueryDto, plain);
}

const OK = { query: 'q', doc_id: DOC_A, answer_span: 's' };

describe('REQ-BE-5.1.1', () => {
  it('T-DTO-1 올바른 본문과 edition_only의 true·false·null을 받는다', async () => {
    expect(await failedCreate(OK)).toEqual([]);
    for (const value of [true, false, null]) {
      expect(await failedCreate({ ...OK, edition_only: value })).toEqual([]);
    }
  });

  it('T-DTO-2 doc_id는 공백 아닌 문자열이면 되고 UUID 형식은 보지 않는다', async () => {
    const { doc_id: _omit, ...withoutDocId } = OK;
    expect(await failedCreate(withoutDocId)).toEqual(['doc_id']);
    for (const value of ['', '  ', 1]) {
      expect(await failedCreate({ ...OK, doc_id: value })).toEqual(['doc_id']);
    }
    expect(await failedCreate({ ...OK, doc_id: 'not-a-uuid' })).toEqual([]);
  });

  it('T-DTO-3 query와 answer_span은 공백 아닌 문자열이어야 한다', async () => {
    for (const field of ['query', 'answer_span']) {
      const without: Record<string, unknown> = { ...OK };
      delete without[field];
      expect(await failedCreate(without)).toEqual([field]);
      for (const value of ['', ' \n', 1]) {
        expect(await failedCreate({ ...OK, [field]: value })).toEqual([field]);
      }
    }
  });

  it('T-DTO-4 edition_only는 불리언만 받고 모르는 필드는 거부한다', async () => {
    for (const value of ['true', 1]) {
      expect(await failedCreate({ ...OK, edition_only: value })).toEqual(['edition_only']);
    }
    expect((await failedCreate({ ...OK, top_n: 5 })).length).toBeGreaterThan(0);
    expect((await failedCreate({ ...OK, golden_set_id: 'x' })).length).toBeGreaterThan(0);
  });
});

describe('REQ-BE-5.3.1', () => {
  it('T-DTO-5 목록 쿼리의 기본값과 허용 값', async () => {
    expect(await failedList({})).toEqual([]);
    const defaults = plainToInstance(ListGoldenSetsQueryDto, {});
    expect(defaults.sort).toBe('created_at');
    expect(defaults.page).toBe(1);
    expect(defaults.page_size).toBe(20);
    expect(defaults.order).toBe('desc');
    for (const value of ['outcome', 'rank', 'coverage', 'evaluated_at', 'created_at']) {
      expect(await failedList({ sort: value })).toEqual([]);
    }
    for (const value of ['name', 'RANK']) {
      expect(await failedList({ sort: value })).toEqual(['sort']);
    }
    for (const value of ['hit', 'miss']) {
      expect(await failedList({ outcome: value })).toEqual([]);
    }
    for (const value of ['evaluating', 'error', 'HIT']) {
      expect(await failedList({ outcome: value })).toEqual(['outcome']);
    }
    // 쿼리 문자열은 문자열로 오므로 숫자로 바뀌어야 한다
    expect(await failedList({ page_size: '50', page: '2' })).toEqual([]);
    const converted = plainToInstance(ListGoldenSetsQueryDto, { page_size: '50', page: '2' });
    expect(converted.page).toBe(2);
    expect(converted.page_size).toBe(50);
  });
});

describe('REQ-BE-5.1.4', () => {
  it('T-DTO-6 골든셋 ID는 형식을 검사하지 않는다', async () => {
    expect(await failedOf(GoldenSetIdParamDto, { golden_set_id: 'abc' })).toEqual([]);
    expect(await failedOf(GoldenSetIdParamDto, { golden_set_id: 'e2e-gs' })).toEqual([]);
  });
});
