import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import { SearchRequestDto } from './search.dto';

/** 검증 오류에서 문제가 된 필드 경로를 모은다. */
function paths(errors: ValidationError[], parent?: string): string[] {
  return errors.flatMap((error) => {
    const path = parent === undefined ? error.property : `${parent}.${error.property}`;
    const own = error.constraints !== undefined ? [path] : [];
    return [...own, ...paths(error.children ?? [], path)];
  });
}

/** 전역 파이프와 같은 옵션으로 검증해 실패 필드 경로 목록을 돌려준다. */
async function failed(plain: Record<string, unknown>): Promise<string[]> {
  const instance = plainToInstance(SearchRequestDto, plain);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return paths(errors);
}

describe('REQ-BE-4.1.1', () => {
  it('T-DTO-1 올바른 본문과 null인 선택 필드는 통과한다', async () => {
    expect(await failed({ query: 'q' })).toEqual([]);
    expect(
      await failed({
        query: 'q',
        top_n: 50,
        names: ['A'],
        edition_scope: 'specific',
        edition: { name: 'A', label: 'v1' },
        expand_neighbors: true,
      }),
    ).toEqual([]);
    expect(
      await failed({
        query: 'q',
        top_n: null,
        names: null,
        edition_scope: null,
        edition: null,
        expand_neighbors: null,
      }),
    ).toEqual([]);
  });

  it('T-DTO-2 query가 없거나 문자열이 아니거나 공백뿐이면 거부한다', async () => {
    for (const plain of [{}, { query: 1 }, { query: '' }, { query: '  \n' }]) {
      expect(await failed(plain)).toContain('query');
    }
  });

  it('T-DTO-3 top_n은 1~50 정수만 받는다', async () => {
    for (const value of [1, 50]) expect(await failed({ query: 'q', top_n: value })).toEqual([]);
    for (const value of [0, 51, -1, 1.5, '5']) {
      expect(await failed({ query: 'q', top_n: value })).toContain('top_n');
    }
  });

  it('T-DTO-4 names는 공백이 아닌 문자열 배열만 받는다', async () => {
    for (const value of [[], ['A', 'B']]) {
      expect(await failed({ query: 'q', names: value })).toEqual([]);
    }
    for (const value of ['A', [1], ['A', '  '], ['']]) {
      expect(await failed({ query: 'q', names: value })).toContain('names');
    }
  });

  it('T-DTO-5 edition_scope는 all·latest·specific만 받는다', async () => {
    for (const value of ['all', 'latest']) {
      expect(await failed({ query: 'q', edition_scope: value })).toEqual([]);
    }
    for (const value of ['ALL', 'other', 1]) {
      expect(await failed({ query: 'q', edition_scope: value })).toContain('edition_scope');
    }
  });

  it('T-DTO-6 specific이면 edition이 필수이고 그 밖에는 형식만 본다', async () => {
    const specific = { query: 'q', edition_scope: 'specific' };
    expect(await failed(specific)).toContain('edition');
    expect(await failed({ ...specific, edition: null })).toContain('edition');
    expect(await failed({ ...specific, edition: 'A' })).toContain('edition');
    expect(await failed({ ...specific, edition: { name: ' ', label: 'v1' } })).toContain(
      'edition.name',
    );
    expect(await failed({ ...specific, edition: { name: 'A' } })).toContain('edition.label');
    // 모르는 필드는 edition 아래 경로로 거부된다
    expect(
      (await failed({ ...specific, edition: { name: 'A', label: 'v1', extra: 1 } })).length,
    ).toBeGreaterThan(0);
    // ★ specific이 아니면 edition은 형식만 본다(S3)
    expect(await failed({ query: 'q', edition: { name: 'A', label: 'v1' } })).toEqual([]);
    expect(
      await failed({ query: 'q', edition_scope: 'latest', edition: { name: '', label: 'v1' } }),
    ).toContain('edition.name');
  });

  it('T-DTO-7 expand_neighbors는 불리언만 받는다', async () => {
    for (const value of [true, false]) {
      expect(await failed({ query: 'q', expand_neighbors: value })).toEqual([]);
    }
    for (const value of ['true', 1]) {
      expect(await failed({ query: 'q', expand_neighbors: value })).toContain('expand_neighbors');
    }
  });

  it('T-DTO-8 모르는 필드는 거부한다', async () => {
    expect(await failed({ query: 'q', doc_ids: ['x'] })).toContain('doc_ids');
    expect(await failed({ query: 'q', version: '1' })).toContain('version');
  });
});
