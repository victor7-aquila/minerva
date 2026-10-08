import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { RagJobState as RagWireJobState } from '../rag';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import * as barrel from './index';
import { INDEX_JOB_STATE_CHANGED, IndexingModule, IndexingService } from './index';
import type {
  IndexJobStateChangedEvent,
  IndexRequestInput,
  IndexRequestOutcome,
  JobFailureInfo,
  JobResultInfo,
  RagEventNotification,
  RagJobState,
} from './index';
import { IndexingCrudService } from './services/indexing-crud.service';
import { RagEventsController } from './controllers/rag-events.controller';
import { RagEventsTokenGuard } from './guards/rag-events-token.guard';

/** 두 타입이 정확히 같은지 본다. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

/** IF-BE-1 계약 표면을 글자 그대로 옮긴 기대 타입이다. */
type ExpectedRagJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'superseded';
interface ExpectedJobFailureInfo {
  code: string;
  message: string;
  headingPath: string[] | null;
  placeholderId: string | null;
}
interface ExpectedJobResultInfo {
  chunkCount: number;
  fallbackUsed: boolean;
}
interface ExpectedEvent {
  docId: string;
  version: string;
  jobId: string;
  jobState: ExpectedRagJobState;
  searchableVersion: string | null;
  result: ExpectedJobResultInfo | null;
  failure: ExpectedJobFailureInfo | null;
  source: 'notification' | 'reconcile';
}

/** MODULE.md·「문서 변경」 1의 입력·결과 형태를 옮긴 기대 타입이다. */
interface ExpectedIndexRequestInput {
  docId: string;
  version: string;
  indexingMarkdown: string;
  hints: ReadonlyArray<{ placeholderId: string; text: string }>;
  name: string;
  edition: { label: string; editionDate: string } | null;
  force: boolean;
}
type ExpectedIndexRequestOutcome =
  | { kind: 'accepted'; jobId: string }
  | { kind: 'reused'; jobId: string }
  | { kind: 'rejected'; code: 'PAYLOAD_TOO_LARGE' | 'INVALID_REQUEST' }
  | { kind: 'unreachable' };
interface ExpectedRagEventNotification {
  docId: string;
  jobId: string;
  version: string;
  jobState: ExpectedRagJobState;
  searchableVersion: string | null;
  sequence: number;
}

/** 서비스 메서드 여섯 개를 명시 함수 타입에 대입한다. 컴파일되면 통과다. */
function signatureChecks(svc: IndexingService): unknown[] {
  const request: (input: IndexRequestInput) => Promise<IndexRequestOutcome> =
    svc.requestIndex.bind(svc);
  const notify: (notification: RagEventNotification) => Promise<void> =
    svc.handleNotification.bind(svc);
  const reconcile: (docIds: readonly string[]) => Promise<void> = svc.reconcile.bind(svc);
  const stages: (
    docIds: readonly string[],
  ) => Promise<ReadonlyMap<string, 'chunking' | 'embedding' | 'storing'>> = svc.getStages.bind(svc);
  const metadata: (
    docId: string,
    name: string,
    edition: { label: string; editionDate: string } | null,
  ) => Promise<boolean> = svc.updateMetadata.bind(svc);
  const remove: (docId: string) => Promise<boolean> = svc.deleteChunks.bind(svc);
  return [request, notify, reconcile, stages, metadata, remove];
}

describe('REQ-BE-3.2.2', () => {
  // ★ contract·unused 도구가 없어 공개 표면을 여기서 보완 검증한다
  it('T-SURF-1 배럴의 값 export는 정해진 셋뿐이고 이벤트 이름이 고정이다', () => {
    expect(Object.keys(barrel).sort()).toEqual([
      'INDEX_JOB_STATE_CHANGED',
      'IndexingModule',
      'IndexingService',
    ]);
    expect(INDEX_JOB_STATE_CHANGED).toBe('indexing.job-state-changed');
  });

  it('T-SURF-3 IF-BE-1 이벤트 타입이 계약 표면과 같다', () => {
    expect(assertType<Equals<RagJobState, ExpectedRagJobState>>()).toBe(true);
    expect(assertType<Equals<JobFailureInfo, ExpectedJobFailureInfo>>()).toBe(true);
    expect(assertType<Equals<JobResultInfo, ExpectedJobResultInfo>>()).toBe(true);
    expect(assertType<Equals<IndexJobStateChangedEvent, ExpectedEvent>>()).toBe(true);
    expect(assertType<Equals<RagJobState, RagWireJobState>>()).toBe(true);
  });
});

describe('REQ-BE-3.1.1', () => {
  it('T-SURF-2 서비스 메서드 시그니처와 입력·결과 타입이 고정이다', () => {
    // 시그니처 대입은 컴파일 단계에서 검증된다
    expect(typeof signatureChecks).toBe('function');
    expect(assertType<Equals<IndexRequestInput, ExpectedIndexRequestInput>>()).toBe(true);
    expect(assertType<Equals<IndexRequestOutcome, ExpectedIndexRequestOutcome>>()).toBe(true);
    expect(assertType<Equals<RagEventNotification, ExpectedRagEventNotification>>()).toBe(true);
    expect(Object.getOwnPropertyNames(IndexingService.prototype)).toEqual(
      expect.arrayContaining([
        'requestIndex',
        'handleNotification',
        'reconcile',
        'getStages',
        'updateMetadata',
        'deleteChunks',
        'onModuleInit',
      ]),
    );
  });

  it('T-SURF-4 IndexingModule은 storage·rag를 가져오고 서비스만 노출한다', () => {
    const imports = (Reflect.getMetadata('imports', IndexingModule) ?? []) as unknown[];
    expect(imports).toEqual(expect.arrayContaining([StorageModule, RagModule]));
    // ★ EventEmitterModule.forRoot()는 AppModule이 한 번만 가져온다(D1)
    const emitterModules = imports.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { module?: unknown }).module === EventEmitterModule,
    );
    expect(emitterModules).toHaveLength(0);
    expect(imports).not.toContain(EventEmitterModule);
    expect(Reflect.getMetadata('controllers', IndexingModule)).toEqual([RagEventsController]);
    expect(Reflect.getMetadata('exports', IndexingModule)).toEqual([IndexingService]);
    const providers = Reflect.getMetadata('providers', IndexingModule) as unknown[];
    expect(providers).toEqual(expect.arrayContaining([IndexingService, IndexingCrudService]));
  });
});

describe('REQ-BE-3.2.5', () => {
  it('T-SURF-5 알림 컨트롤러는 POST v1/internal/rag-events를 토큰 가드와 204로 연다', () => {
    // ★ 메타데이터 키는 @nestjs/common/constants의 PATH_METADATA·GUARDS_METADATA·METHOD_METADATA·HTTP_CODE_METADATA 값이다
    expect(Reflect.getMetadata('path', RagEventsController)).toBe('v1/internal/rag-events');
    expect(Reflect.getMetadata('__guards__', RagEventsController)).toEqual([RagEventsTokenGuard]);
    const handler = RagEventsController.prototype.receive;
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(204);
  });
});
