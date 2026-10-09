import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Page } from '../common';
import { DocumentsModule, DocumentsService } from '../documents';
import type { DocumentRefData, EvaluationTarget } from '../documents';
import { RagClient, RagModule } from '../rag';
import type { RagEvaluationRequest, RagEvaluationResult } from '../rag';
import { StorageModule } from '../storage';
import { EvaluationController } from './controllers/evaluation.controller';
import type {
  AnswerRefView,
  EvaluationMetricsView,
  EvaluationRecordView,
  EvaluationSummaryView,
  GoldenSetView,
  SummaryMetricsView,
} from './interfaces/evaluation.types';
import { EvaluationClock } from './services/evaluation-clock';
import { EvaluationCrudService } from './services/evaluation-crud.service';
import { EvaluationTasks } from './services/evaluation-tasks';
import { EvaluationService } from './services/evaluation.service';
import * as barrel from './index';
import { EvaluationModule } from './index';

/** 두 타입이 정확히 같은지 본다. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

/** API.md EvaluationMetrics의 기대 타입이다. */
interface ExpectedMetrics {
  hit_at_1: boolean;
  hit_at_3: boolean;
  hit_at_5: boolean;
  hit_at_n: boolean;
  rank: number | null;
  reciprocal_rank: number;
  coverage: number;
}

/** API.md EvaluationRecord의 기대 타입이다. */
interface ExpectedRecord {
  outcome: 'evaluating' | 'hit' | 'miss' | 'error';
  n: number | null;
  base: ExpectedMetrics | null;
  expanded: ExpectedMetrics | null;
  error_message: string | null;
  evaluated_at: string | null;
}

/** API.md DocumentRef(골든셋 정답 문서)의 기대 타입이다. */
interface ExpectedAnswer {
  doc_id: string;
  name: string;
  edition: { label: string; edition_date: string } | null;
}

/** API.md GoldenSet의 기대 타입이다. */
interface ExpectedGoldenSet {
  golden_set_id: string;
  query: string;
  answer: ExpectedAnswer;
  answer_span: string;
  edition_only: boolean;
  created_at: string;
  latest: ExpectedRecord;
}

/** API.md SummaryMetrics의 기대 타입이다. */
interface ExpectedSummaryMetrics {
  hit_at_1: number;
  hit_at_3: number;
  hit_at_5: number;
  hit_at_n: number;
  mrr: number;
}

/** API.md EvaluationSummary의 기대 타입이다. */
interface ExpectedSummary {
  golden_set_count: number;
  evaluating_count: number;
  last_evaluated_at: string | null;
  n: number;
  base: ExpectedSummaryMetrics;
  expanded: ExpectedSummaryMetrics;
}

/** 응답 타입과 쓰는 공급자 시그니처를 명세 모양과 대조한다. 컴파일되면 통과다. */
function typeChecks(): unknown[] {
  return [
    assertType<Equals<GoldenSetView, ExpectedGoldenSet>>(),
    assertType<Equals<EvaluationRecordView, ExpectedRecord>>(),
    assertType<Equals<EvaluationMetricsView, ExpectedMetrics>>(),
    assertType<Equals<AnswerRefView, ExpectedAnswer>>(),
    assertType<Equals<ReturnType<EvaluationService['list']>, Promise<Page<GoldenSetView>>>>(),
    assertType<
      Equals<DocumentsService['getRef'], (docId: string) => Promise<DocumentRefData | null>>
    >(),
    assertType<
      Equals<
        DocumentsService['getEvaluationTarget'],
        (docId: string) => Promise<EvaluationTarget | null>
      >
    >(),
    assertType<
      Equals<RagClient['evaluate'], (req: RagEvaluationRequest) => Promise<RagEvaluationResult>>
    >(),
    assertType<Equals<EvaluationSummaryView, ExpectedSummary>>(),
    assertType<Equals<SummaryMetricsView, ExpectedSummaryMetrics>>(),
  ];
}

/** 컨트롤러 핸들러의 라우트 메타데이터를 읽는다. */
function routeOf(name: keyof EvaluationController): {
  path: unknown;
  method: unknown;
  code: unknown;
} {
  const handler = EvaluationController.prototype[name] as unknown as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler),
    code: Reflect.getMetadata(HTTP_CODE_METADATA, handler),
  };
}

describe('REQ-BE-7.1.1', () => {
  // ★ contract·unused 도구가 없어 공개 표면을 여기서 보완 검증한다
  it('T-SURF-1 배럴의 값 export는 EvaluationModule뿐이다', () => {
    expect(Object.keys(barrel).sort()).toEqual(['EvaluationModule']);
  });

  it('T-SURF-2 EvaluationModule은 storage·documents·rag만 가져오고 아무것도 내보내지 않는다', () => {
    const imports = (Reflect.getMetadata('imports', EvaluationModule) ?? []) as unknown[];
    expect(new Set(imports)).toEqual(new Set([StorageModule, DocumentsModule, RagModule]));
    expect(imports).toHaveLength(3);
    expect(Reflect.getMetadata('controllers', EvaluationModule)).toEqual([EvaluationController]);
    expect(Reflect.getMetadata('providers', EvaluationModule)).toEqual(
      expect.arrayContaining([
        EvaluationService,
        EvaluationCrudService,
        EvaluationTasks,
        EvaluationClock,
      ]),
    );
    const exported = (Reflect.getMetadata('exports', EvaluationModule) ?? []) as unknown[];
    expect(exported).toEqual([]);
  });
});

describe('REQ-BE-5.1.3', () => {
  it('T-SURF-3 라우트 여섯 개뿐이고 고치는 라우트(PATCH·PUT)가 없다', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EvaluationController)).toBe('v1');
    expect(routeOf('list')).toEqual({
      path: 'golden-sets',
      method: RequestMethod.GET,
      code: undefined,
    });
    expect(routeOf('create')).toEqual({
      path: 'golden-sets',
      method: RequestMethod.POST,
      code: 201,
    });
    expect(routeOf('evaluateAll')).toEqual({
      path: 'golden-sets/evaluate-all',
      method: RequestMethod.POST,
      code: 202,
    });
    expect(routeOf('remove')).toEqual({
      path: 'golden-sets/:golden_set_id',
      method: RequestMethod.DELETE,
      code: 204,
    });
    expect(routeOf('evaluate')).toEqual({
      path: 'golden-sets/:golden_set_id/evaluate',
      method: RequestMethod.POST,
      code: 202,
    });
    expect(routeOf('summary')).toEqual({
      path: 'evaluation-summary',
      method: RequestMethod.GET,
      code: undefined,
    });
    const proto = EvaluationController.prototype as unknown as Record<string, object>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (key) =>
        key !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[key]) !== undefined,
    );
    expect(handlers.sort()).toEqual([
      'create',
      'evaluate',
      'evaluateAll',
      'list',
      'remove',
      'summary',
    ]);
    for (const key of handlers) {
      const method = Reflect.getMetadata(METHOD_METADATA, proto[key]) as RequestMethod;
      expect([RequestMethod.PATCH, RequestMethod.PUT]).not.toContain(method);
    }
  });
});

describe('REQ-BE-5.3.2', () => {
  it('T-SURF-4 응답 타입과 쓰는 공급자 시그니처가 명세와 같다', () => {
    // 타입 검사는 컴파일 때 끝난다. 함수가 만들어지는지만 확인한다
    expect(typeChecks).toBeInstanceOf(Function);
  });
});

describe('REQ-BE-5.3.3', () => {
  it('T-SURF-5 요약 응답 타입이 명세와 같다', () => {
    // ★ 위 typeChecks의 EvaluationSummaryView·SummaryMetricsView 단언이 컴파일 때 검사한다
    expect(typeChecks).toBeInstanceOf(Function);
  });
});
