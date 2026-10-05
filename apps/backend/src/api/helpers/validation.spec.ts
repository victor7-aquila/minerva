import 'reflect-metadata';
import type { ValidationError } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { InvalidRequestError } from '../../common';
import { PageQueryDto } from '../../../libs/utils';
import { RequestValidationError, collectFieldPaths, createValidationPipe } from './validation';

class EditionDto {
  @IsString() label!: string;
}
class ItemDto {
  @IsString() name!: string;
}
class ProbeDto {
  @IsString() name!: string;
  @IsInt() count!: number;
  @IsOptional() @ValidateNested() @Type(() => EditionDto) edition?: EditionDto;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items?: ItemDto[];
}

/** 본문 검증을 실행하고 던진 오류를 돌려준다. */
async function failure(value: unknown): Promise<RequestValidationError> {
  const pipe = createValidationPipe();
  try {
    await pipe.transform(value, { type: 'body', metatype: ProbeDto, data: '' });
  } catch (error) {
    expect(error).toBeInstanceOf(RequestValidationError);
    return error as RequestValidationError;
  }
  throw new Error('검증 오류가 나야 합니다');
}

describe('REQ-BE-7.1.2', () => {
  it('T-VAL-1 필수 필드 누락은 RequestValidationError로 거부한다', async () => {
    const error = await failure({ count: 1 });
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.fields).toContain('name');
    expect(error.message).toContain('name');
    expect(error.message).toMatch(/[가-힣]/);
  });

  it('T-VAL-2 타입 오류는 필드 이름만 담고 입력값은 담지 않는다', async () => {
    const error = await failure({ name: 'SECRET-7f3a', count: 'SECRET-COUNT' });
    expect(error.fields).toEqual(['count']);
    const dump = `${error.message}|${JSON.stringify(error.fields)}|${JSON.stringify(error)}`;
    expect(dump).not.toContain('SECRET-COUNT');
    expect(dump).not.toContain('SECRET-7f3a');
  });

  it('T-VAL-3 모르는 필드는 이름만 담는다', async () => {
    const error = await failure({ name: 'a', count: 1, extra: 'SECRET-7f3a' });
    expect(error.fields).toEqual(['extra']);
    expect(error.message).toContain('extra');
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain('SECRET-7f3a');
  });

  it('T-VAL-4 중첩 필드는 점으로 이은 경로로 담는다', async () => {
    const error = await failure({
      name: 'a',
      count: 1,
      edition: { label: 5 },
      items: [{ name: 'x' }, { name: 7 }],
    });
    expect([...error.fields].sort()).toEqual(['edition.label', 'items.1.name']);
  });

  it('T-VAL-5 여러 오류의 필드 이름은 한 번씩만 담고 메시지 접두사가 고정이다', async () => {
    const error = await failure({ count: 'x', extra: 1 });
    expect([...error.fields].sort()).toEqual(['count', 'extra', 'name']);
    expect(new Set(error.fields).size).toBe(error.fields.length);
    expect(error.message.startsWith('요청 형식이 올바르지 않습니다. 확인할 필드: ')).toBe(true);
  });

  it('T-VAL-6 정상 쿼리는 변환되어 통과한다', async () => {
    const pipe = createValidationPipe();
    const result = (await pipe.transform(
      { page: '2', page_size: '50' },
      { type: 'query', metatype: PageQueryDto },
    )) as PageQueryDto;
    expect(result).toBeInstanceOf(PageQueryDto);
    expect(result.page).toBe(2);
    expect(result.page_size).toBe(50);
    expect(result.order).toBe('desc');
  });

  it('T-VAL-7 whitelist로 선언하지 않은 값은 남지 않는다', async () => {
    const pipe = createValidationPipe();
    const result = (await pipe.transform(
      { name: 'a', count: 1 },
      { type: 'body', metatype: ProbeDto, data: '' },
    )) as Record<string, unknown>;
    // ★ 클래스 필드 선언 때문에 선택 필드가 undefined 값 키로 생길 수 있어 값이 정의된 키만 비교한다
    const definedKeys = Object.keys(result).filter((k) => result[k] !== undefined);
    expect(definedKeys.sort()).toEqual(['count', 'name']);
    expect(result).not.toHaveProperty('extra');
  });

  it('T-VAL-8 collectFieldPaths는 제약 있는 경로만 점으로 이어 중복 없이 모은다', () => {
    const errors = [
      { property: 'a', constraints: { isString: 'x' } },
      {
        property: 'b',
        children: [
          { property: 'c', constraints: { isInt: 'x' } },
          { property: 'c', constraints: { isInt: 'y' } },
        ],
      },
      { property: 'a', constraints: { isString: 'again' } },
    ] as unknown as ValidationError[];
    expect(collectFieldPaths(errors)).toEqual(['a', 'b.c']);
    const withParent = [{ property: 'x', constraints: { k: 'v' } }] as unknown as ValidationError[];
    expect(collectFieldPaths(withParent, 'p')).toEqual(['p.x']);
  });

  it('T-VAL-9 RequestValidationError의 메시지·이름·동결', () => {
    const empty = new RequestValidationError([]);
    const two = new RequestValidationError(['a', 'b']);
    expect(empty.message).toBe('요청 형식이 올바르지 않습니다');
    expect(two.message).toBe('요청 형식이 올바르지 않습니다. 확인할 필드: a, b');
    expect(two.name).toBe('RequestValidationError');
    expect(Object.isFrozen(two.fields)).toBe(true);
  });
});
