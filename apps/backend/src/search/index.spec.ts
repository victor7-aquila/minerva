import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AssetsModule, AssetsService } from '../assets';
import { DocumentsModule, DocumentsService } from '../documents';
import { RagClient, RagModule } from '../rag';
import type { RagSearchResult } from '../rag';
import { SearchController } from './controllers/search.controller';
import type { SearchRequestDto } from './interfaces/search.dto';
import { SearchService } from './services/search.service';
import type {
  ResultEditionView,
  SearchResponseView,
  SearchResultView,
} from './interfaces/search.types';
import * as barrel from './index';
import { SearchModule } from './index';

/** 두 타입이 정확히 같은지 본다. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

/** API.md ResultEdition의 기대 타입이다. */
interface ExpectedEdition {
  label: string;
  edition_date: string;
  is_latest: boolean;
  other_editions_in_results: boolean;
}

/** API.md SearchResult의 기대 타입이다. */
interface Expected {
  rank: number;
  score: number;
  doc_id: string;
  name: string;
  edition: ExpectedEdition | null;
  heading_path: string[];
  markdown: string;
  before: string[];
  after: string[];
}

/** 응답 타입과 쓰는 공급자 시그니처를 명세 모양과 대조한다. 컴파일되면 통과다. */
function typeChecks(): unknown[] {
  return [
    assertType<Equals<SearchResultView, Expected>>(),
    assertType<Equals<ResultEditionView, ExpectedEdition>>(),
    assertType<Equals<ReturnType<SearchService['search']>, Promise<SearchResponseView>>>(),
    assertType<Equals<Parameters<SearchService['search']>, [body: SearchRequestDto]>>(),
    assertType<Equals<ReturnType<DocumentsService['resolveNames']>, Promise<string[]>>>(),
    assertType<Equals<ReturnType<DocumentsService['visibleDocIds']>, Promise<Set<string>>>>(),
    assertType<
      Equals<Parameters<AssetsService['restore']>, [docId: string, version: string, text: string]>
    >(),
    assertType<Equals<ReturnType<RagClient['search']>, Promise<RagSearchResult[]>>>(),
  ];
}

describe('REQ-BE-4.1.1', () => {
  // ★ contract·unused 도구가 없어 공개 표면을 여기서 보완 검증한다
  it('T-SURF-1 배럴의 값 export는 SearchModule뿐이다', () => {
    expect(Object.keys(barrel).sort()).toEqual(['SearchModule']);
  });

  it('T-SURF-3 POST /v1/search 라우트 하나이고 상태 코드는 200이다', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SearchController)).toBe('v1/search');
    const handler = SearchController.prototype.search;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    const routes = Object.getOwnPropertyNames(SearchController.prototype).filter(
      (key) =>
        key !== 'constructor' &&
        Reflect.getMetadata(
          METHOD_METADATA,
          (SearchController.prototype as unknown as Record<string, object>)[key],
        ) !== undefined,
    );
    expect(routes).toEqual(['search']);
  });
});

describe('REQ-BE-7.1.1', () => {
  it('T-SURF-2 SearchModule은 documents·assets·rag만 가져오고 아무것도 내보내지 않는다', () => {
    const imports = (Reflect.getMetadata('imports', SearchModule) ?? []) as unknown[];
    expect(imports).toHaveLength(3);
    expect(imports).toEqual(expect.arrayContaining([DocumentsModule, AssetsModule, RagModule]));
    expect(imports.some((item) => typeof item === 'object' && item !== null)).toBe(false);
    expect(Reflect.getMetadata('controllers', SearchModule)).toEqual([SearchController]);
    expect(Reflect.getMetadata('providers', SearchModule)).toEqual([SearchService]);
    const exported = (Reflect.getMetadata('exports', SearchModule) ?? []) as unknown[];
    expect(exported).toEqual([]);
  });
});

describe('REQ-BE-4.2.3', () => {
  it('T-SURF-4 응답 타입과 쓰는 공급자 시그니처가 명세와 같다', () => {
    // 타입 검사는 컴파일 때 끝난다. 함수가 만들어지는지만 확인한다
    expect(typeChecks).toBeInstanceOf(Function);
  });
});
