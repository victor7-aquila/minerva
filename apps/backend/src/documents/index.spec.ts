import 'reflect-metadata';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter';
import { AssetsModule } from '../assets';
import { LogsModule } from '../logs';
import { INDEX_JOB_STATE_CHANGED, IndexingModule } from '../indexing';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import { DocumentLifecycle } from './services/document-lifecycle.service';
import { DocumentsController } from './controllers/documents.controller';
import * as barrel from './index';
import { DocumentsModule, DocumentsService } from './index';
import type { DocumentRefData, EvaluationTarget } from './index';

/** 두 타입이 정확히 같은지 본다. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

/** MODULE.md 「다른 모듈용 조회」 코드 블록의 기대 타입이다. */
interface ExpectedDocumentRefData {
  docId: string;
  name: string;
  edition: { label: string; editionDate: string } | null;
  deleted: boolean;
}
interface ExpectedEvaluationTarget extends ExpectedDocumentRefData {
  searchState: 'searchable' | 'not_searchable' | 'replaced';
  searchableIndexingMarkdown: string | null;
}

/** 서비스의 공개 조회 메서드 네 개를 명시 함수 타입에 대입한다. 컴파일되면 통과다. */
function typeChecks(svc: DocumentsService): unknown[] {
  const resolveNames: (names: readonly string[]) => Promise<string[]> = svc.resolveNames.bind(svc);
  const visible: (docIds: readonly string[]) => Promise<Set<string>> = svc.visibleDocIds.bind(svc);
  const ref: (docId: string) => Promise<DocumentRefData | null> = svc.getRef.bind(svc);
  const target: (docId: string) => Promise<EvaluationTarget | null> =
    svc.getEvaluationTarget.bind(svc);
  return [
    resolveNames,
    visible,
    ref,
    target,
    assertType<Equals<DocumentRefData, ExpectedDocumentRefData>>(),
    assertType<Equals<EvaluationTarget, ExpectedEvaluationTarget>>(),
    assertType<Equals<ReturnType<DocumentsService['resolveNames']>, Promise<string[]>>>(),
    assertType<Equals<ReturnType<DocumentsService['visibleDocIds']>, Promise<Set<string>>>>(),
  ];
}

describe('REQ-BE-4.2.2', () => {
  it('T-SURF-1 배럴의 값 export는 DocumentsModule과 DocumentsService뿐이다', () => {
    expect(Object.keys(barrel).sort()).toEqual(['DocumentsModule', 'DocumentsService']);
  });

  it('T-SURF-2 공개 조회 메서드의 시그니처와 모델 모양이 명세와 같다', () => {
    // 타입 검사는 컴파일 때 끝난다. 함수가 만들어지는지만 확인한다
    expect(typeChecks).toBeInstanceOf(Function);
    expect(DocumentsService.prototype.resolveNames).toBeInstanceOf(Function);
    expect(DocumentsService.prototype.visibleDocIds).toBeInstanceOf(Function);
    expect(DocumentsService.prototype.getRef).toBeInstanceOf(Function);
    expect(DocumentsService.prototype.getEvaluationTarget).toBeInstanceOf(Function);
  });
});

describe('REQ-BE-7.1.1', () => {
  it('T-SURF-3 DocumentsModule은 이웃 모듈만 가져오고 이벤트·스케줄 동적 모듈은 가져오지 않는다', () => {
    const imports = (Reflect.getMetadata('imports', DocumentsModule) ?? []) as unknown[];
    expect(imports).toHaveLength(5);
    expect(imports).toEqual(
      expect.arrayContaining([StorageModule, RagModule, LogsModule, AssetsModule, IndexingModule]),
    );
    expect(imports.some((item) => typeof item === 'object' && item !== null)).toBe(false);
    expect(Reflect.getMetadata('controllers', DocumentsModule)).toEqual([DocumentsController]);
    expect(Reflect.getMetadata('exports', DocumentsModule)).toEqual([DocumentsService]);
  });

  /** 컨트롤러 핸들러 하나의 라우트 메타데이터다. */
  function route(name: string): { path: string; method: number; code: number | undefined } {
    const handler = (DocumentsController.prototype as unknown as Record<string, object>)[name];
    return {
      path: Reflect.getMetadata(PATH_METADATA, handler) as string,
      method: Reflect.getMetadata(METHOD_METADATA, handler) as number,
      code: Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined,
    };
  }

  it('T-SURF-5 컨트롤러는 12개 라우트를 명세의 경로·메서드·상태 코드로 노출한다', () => {
    const expected: Record<string, [string, RequestMethod, number | undefined]> = {
      upload: ['documents', RequestMethod.POST, 201],
      list: ['documents', RequestMethod.GET, undefined],
      names: ['document-names', RequestMethod.GET, undefined],
      replacementCheck: ['documents/replacement-check', RequestMethod.GET, undefined],
      detail: ['documents/:doc_id', RequestMethod.GET, undefined],
      original: ['documents/:doc_id/original', RequestMethod.GET, undefined],
      chunks: ['documents/:doc_id/chunks', RequestMethod.GET, undefined],
      edit: ['documents/:doc_id', RequestMethod.PATCH, undefined],
      uploadContents: ['documents/:doc_id/contents', RequestMethod.POST, 202],
      reindex: ['documents/:doc_id/reindex', RequestMethod.POST, 202],
      requeue: ['documents/:doc_id/queue', RequestMethod.POST, 202],
      remove: ['documents/:doc_id', RequestMethod.DELETE, 204],
    };
    expect(Object.keys(expected)).toHaveLength(12);
    for (const [name, [path, method, code]] of Object.entries(expected)) {
      expect([name, route(name)]).toEqual([name, { path, method, code }]);
    }
  });

  it('T-SURF-5 replacementCheck는 detail보다 먼저 선언되고 업로드 핸들러에 인터셉터가 없다', () => {
    const names = Object.getOwnPropertyNames(DocumentsController.prototype);
    expect(names.indexOf('replacementCheck')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('replacementCheck')).toBeLessThan(names.indexOf('detail'));
    for (const name of ['upload', 'uploadContents']) {
      const handler = (DocumentsController.prototype as unknown as Record<string, object>)[name];
      expect(Reflect.getMetadata('__interceptors__', handler)).toBeUndefined();
    }
  });
});

describe('REQ-BE-1.9.5', () => {
  it('T-SURF-4 색인 작업 상태 이벤트를 오류를 삼키지 않는 구독으로 받는다', () => {
    const meta = Reflect.getMetadata(
      EVENT_LISTENER_METADATA,
      DocumentLifecycle.prototype.onJobStateChanged,
    ) as Array<{ event: unknown; options?: { suppressErrors?: boolean } }> | undefined;
    const matched = (meta ?? []).filter(
      (item) => item.event === INDEX_JOB_STATE_CHANGED && item.options?.suppressErrors === false,
    );
    expect(INDEX_JOB_STATE_CHANGED).toBe('indexing.job-state-changed');
    expect(matched).toHaveLength(1);
  });
});
