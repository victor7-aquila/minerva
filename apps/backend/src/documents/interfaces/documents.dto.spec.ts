import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import {
  DocIdParamDto,
  DocumentNamesQueryDto,
  EditDocumentDto,
  EditionDto,
  ListDocumentsQueryDto,
  ReplacementCheckQueryDto,
  UploadBodyDto,
  UploadMetaDto,
} from './documents.dto';

/** 검증 오류에서 문제가 된 필드 경로를 모은다. */
function paths(errors: ValidationError[], parent?: string): string[] {
  return errors.flatMap((error) => {
    const path = parent === undefined ? error.property : `${parent}.${error.property}`;
    const own = error.constraints !== undefined ? [path] : [];
    return [...own, ...paths(error.children ?? [], path)];
  });
}

/** 전역 파이프와 같은 옵션으로 검증한다. 인스턴스와 실패 필드를 돌려준다. */
async function check<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<{ instance: T; failed: string[] }> {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: paths(errors) };
}

describe('REQ-BE-7.1.2', () => {
  it('T-DTO-1 doc_id는 소문자 UUID v4만 받는다', async () => {
    expect((await check(DocIdParamDto, { doc_id: randomUUID() })).failed).toEqual([]);
    const bad = ['e2e-doc', randomUUID().toUpperCase(), '11111111-1111-1111-8111-111111111111', ''];
    for (const value of bad) {
      expect((await check(DocIdParamDto, { doc_id: value })).failed).toContain('doc_id');
    }
  });
});

describe('REQ-BE-1.1.6', () => {
  /** 업로드 본문의 meta 문자열을 만든다. */
  const metaOf = (item: Record<string, unknown>): string => JSON.stringify([item]);
  const goodEdition = { label: 'v1', edition_date: '2026-02-03' };

  it('T-DTO-2 meta는 JSON 문자열로 받아 DTO 인스턴스로 바꾸고 형식을 검사한다', async () => {
    const ok = await check(UploadBodyDto, {
      meta: metaOf({ file_name: 'a.md', name: '문서', edition: goodEdition }),
    });
    expect(ok.failed).toEqual([]);
    expect(ok.instance.meta[0]).toBeInstanceOf(UploadMetaDto);
    expect(ok.instance.meta[0].edition).toBeInstanceOf(EditionDto);

    const fails: Array<[string, string]> = [
      ['빈 이름', metaOf({ file_name: 'a.md', name: '' })],
      ['공백 이름', metaOf({ file_name: 'a.md', name: '  ' })],
      ['판 표기만', metaOf({ file_name: 'a.md', name: 'n', edition: { label: 'v1' } })],
      [
        '없는 날짜',
        metaOf({
          file_name: 'a.md',
          name: 'n',
          edition: { label: 'v1', edition_date: '2026-02-30' },
        }),
      ],
      ['모르는 키', metaOf({ file_name: 'a.md', name: 'n', extra: 1 })],
      ['깨진 JSON', '[{"file_name":'],
    ];
    for (const [title, meta] of fails) {
      const result = await check(UploadBodyDto, { meta });
      expect([title, result.failed.length > 0]).toEqual([title, true]);
    }

    for (const edition of [null, undefined]) {
      const item: Record<string, unknown> = { file_name: 'a.md', name: 'n' };
      if (edition !== undefined) item.edition = edition;
      expect((await check(UploadBodyDto, { meta: metaOf(item) })).failed).toEqual([]);
    }
  });
});

describe('REQ-BE-1.3.3', () => {
  it('T-DTO-3 목록 쿼리를 변환하고 검증하며 기본값을 채운다', async () => {
    const multi = await check(ListDocumentsQueryDto, { search_state: 'searchable,replaced' });
    expect(multi.failed).toEqual([]);
    expect(multi.instance.search_state).toEqual(['searchable', 'replaced']);
    expect(
      (await check(ListDocumentsQueryDto, { search_state: 'searchable,unknown' })).failed,
    ).toContain('search_state');

    const yes = await check(ListDocumentsQueryDto, { has_edition: 'true' });
    expect(yes.failed).toEqual([]);
    expect(yes.instance.has_edition).toBe(true);
    const no = await check(ListDocumentsQueryDto, { has_edition: 'false' });
    expect(no.failed).toEqual([]);
    expect(no.instance.has_edition).toBe(false);
    expect((await check(ListDocumentsQueryDto, { has_edition: 'yes' })).failed).toContain(
      'has_edition',
    );

    expect((await check(ListDocumentsQueryDto, { uploaded_to: '2026-13-01' })).failed).toContain(
      'uploaded_to',
    );
    expect((await check(ListDocumentsQueryDto, { sort: 'size' })).failed).toContain('sort');

    const empty = await check(ListDocumentsQueryDto, {});
    expect(empty.failed).toEqual([]);
    expect(empty.instance.sort).toBe('updated_at');
    expect(empty.instance.page).toBe(1);
    expect(empty.instance.page_size).toBe(20);
    expect(empty.instance.order).toBe('desc');
  });
});

describe('REQ-BE-1.3.7', () => {
  it('T-DTO-4 이름 목록의 limit은 1~50이고 기본은 20이다', async () => {
    for (const limit of ['0', '51', 'abc']) {
      expect((await check(DocumentNamesQueryDto, { limit })).failed).toContain('limit');
    }
    const none = await check(DocumentNamesQueryDto, {});
    expect(none.failed).toEqual([]);
    expect(none.instance.limit).toBe(20);
    const max = await check(DocumentNamesQueryDto, { limit: '50' });
    expect(max.failed).toEqual([]);
    expect(max.instance.limit).toBe(50);
  });
});

describe('REQ-BE-1.2.7', () => {
  it('T-DTO-5 같은 판 확인 쿼리를 검증한다', async () => {
    expect((await check(ReplacementCheckQueryDto, {})).failed).toContain('name');
    expect((await check(ReplacementCheckQueryDto, { name: '  ' })).failed).toContain('name');
    expect(
      (await check(ReplacementCheckQueryDto, { name: 'n', edition_label: '' })).failed,
    ).toContain('edition_label');
    expect(
      (await check(ReplacementCheckQueryDto, { name: 'n', exclude_doc_id: 'x' })).failed,
    ).toContain('exclude_doc_id');
    expect(
      (
        await check(ReplacementCheckQueryDto, {
          name: 'n',
          edition_label: 'v1',
          exclude_doc_id: randomUUID(),
        })
      ).failed,
    ).toEqual([]);
  });
});

describe('REQ-BE-1.5.1', () => {
  it('T-DTO-6 편집 본문: 이름 null은 거부하고 판 null은 지우기이며 빈 본문도 받는다', async () => {
    expect((await check(EditDocumentDto, { name: null })).failed).toContain('name');

    const clear = await check(EditDocumentDto, { edition: null });
    expect(clear.failed).toEqual([]);
    expect(clear.instance.edition).toBeNull();

    const empty = await check(EditDocumentDto, {});
    expect(empty.failed).toEqual([]);
    expect(empty.instance.name).toBeUndefined();
    expect(empty.instance.edition).toBeUndefined();
    expect(empty.instance.assets).toBeUndefined();

    const dup = await check(EditDocumentDto, {
      assets: [
        { placeholder_id: 't1', text: '가' },
        { placeholder_id: 't1', text: '나' },
      ],
    });
    expect(dup.failed.length).toBeGreaterThan(0);

    const blank = await check(EditDocumentDto, { assets: [{ placeholder_id: 't1', text: '  ' }] });
    expect(blank.failed.length).toBeGreaterThan(0);

    expect((await check(EditDocumentDto, { version: '2' })).failed).toContain('version');
  });
});
