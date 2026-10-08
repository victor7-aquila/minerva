import type { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { AssetsService } from '../../src/assets';
import { DocumentsService } from '../../src/documents';
import { RagClient } from '../../src/rag';
import type { RagResultChunk, RagSearchRequest, RagSearchResult } from '../../src/rag';
// ★ 배럴에는 SearchModule만 있다. 테스트 전용 예외로 내부 파일을 직접 import한다
import { SearchRequestDto } from '../../src/search/interfaces/search.dto';
import { SearchService } from '../../src/search/services/search.service';
import { createTestCommonModule } from './test-common.module';

/** 로그 비노출 검사용 센티널이다. */
export const QUERY_SENT = 'QUERY-SENT-81 인증서 갱신';
export const NAME_SENT = 'NAME-SENT-82';
export const LABEL_SENT = 'LABEL-SENT-83';
export const CHUNK_SENT = 'CHUNK-SENT-84';

/** 문서 ID 상수다(소문자 UUID v4). */
export const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const DOC_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const DOC_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** RAG 결과 청크를 만든다. */
export function ragChunk(text: string, over: Partial<RagResultChunk> = {}): RagResultChunk {
  return {
    chunkId: `c-${text}`,
    kind: 'text',
    text,
    placeholderIds: [],
    splitIndex: null,
    splitTotal: null,
    ...over,
  };
}

/** RAG 결과 하나를 만든다. */
export function ragResult(over: Partial<RagSearchResult> = {}): RagSearchResult {
  return {
    rank: 1,
    score: 0.9,
    docId: DOC_A,
    version: '3',
    headingPath: ['장', '절'],
    name: NAME_SENT,
    edition: { label: LABEL_SENT, editionDate: '2025-01-31', isLatest: true },
    otherEditionsInResults: false,
    chunks: [ragChunk(CHUNK_SENT)],
    before: [],
    after: [],
    ...over,
  };
}

/** 가짜 DocumentsService(검색용 조회 두 개)를 만든다. 기본: 이름은 빈 결과, 모든 문서가 보인다. */
export function createFakeSearchDocuments() {
  return {
    resolveNames: jest.fn(async (_names: readonly string[]): Promise<string[]> => []),
    visibleDocIds: jest.fn(async (ids: readonly string[]): Promise<Set<string>> => new Set(ids)),
  };
}

/** 가짜 AssetsService(restore)를 만든다. 결과는 `R[버전]본문`이다. */
export function createFakeSearchAssets() {
  return {
    restore: jest.fn(
      async (_docId: string, version: string, text: string): Promise<string> =>
        `R[${version}]${text}`,
    ),
  };
}

/** 가짜 RagClient(search)를 만든다. 기본은 빈 결과다. */
export function createFakeSearchRag() {
  return { search: jest.fn(async (_req: RagSearchRequest): Promise<RagSearchResult[]> => []) };
}

/** 검색 서비스 테스트 모듈이다. */
export interface SearchTestModule {
  moduleRef: TestingModule;
  service: SearchService;
  documents: ReturnType<typeof createFakeSearchDocuments>;
  assets: ReturnType<typeof createFakeSearchAssets>;
  rag: ReturnType<typeof createFakeSearchRag>;
  close(): Promise<void>;
}

/** 가짜 이웃 위에 진짜 SearchService를 올린다. */
export async function buildSearchTestModule(opts: { stream: Writable }): Promise<SearchTestModule> {
  const documents = createFakeSearchDocuments();
  const assets = createFakeSearchAssets();
  const rag = createFakeSearchRag();
  const moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({}, opts.stream)],
    providers: [
      SearchService,
      { provide: DocumentsService, useValue: documents },
      { provide: AssetsService, useValue: assets },
      { provide: RagClient, useValue: rag },
    ],
  }).compile();
  return {
    moduleRef,
    service: moduleRef.get(SearchService),
    documents,
    assets,
    rag,
    close: () => moduleRef.close(),
  };
}

/** 요청 본문을 DTO 인스턴스로 만든다(검증하지 않는다). */
export function searchBody(plain: Record<string, unknown>): SearchRequestDto {
  return plainToInstance(SearchRequestDto, plain);
}
