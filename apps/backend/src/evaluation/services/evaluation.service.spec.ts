import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { toIsoUtc } from '../../../libs/utils';
import {
  AnswerSpanNotFoundError,
  DocumentNotFoundError,
  DocumentNotSearchableError,
  EvaluationInProgressError,
  GoldenSetNotFoundError,
  InvalidRequestError,
  RagUnavailableError,
} from '../../common';
import { RagRequestError } from '../../rag';
import type { RagEvaluationRequest, RagEvaluationResult } from '../../rag';
import { createLogCapture } from '../../../test/support/log-capture';
import {
  DOC_A,
  DOC_B,
  IDX_SENT,
  LABEL_SENT,
  NAME_SENT,
  QUERY_SENT,
  SPAN_SENT,
  buildEvaluationTestModule,
  deferred,
  evaluatingRecord,
  evaluationRecord,
  evaluationTarget,
  goldenSetRecord,
  missMetrics,
  ragEvalResult,
  ragMetrics,
  seedEvaluation,
  waitUntil,
} from '../../../test/support/evaluation-fixtures';
import type { EvaluationHarness } from '../../../test/support/evaluation-fixtures';
import { CreateGoldenSetDto, ListGoldenSetsQueryDto } from '../interfaces/evaluation.dto';
import { EVALUATION_MESSAGES } from '../interfaces/evaluation.types';
import type {
  EvaluationRecord,
  GoldenSetRecord,
  GoldenSetView,
} from '../interfaces/evaluation.types';

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let h: EvaluationHarness;

beforeEach(async () => {
  capture.clear();
  h = await buildEvaluationTestModule({ stream: capture.stream });
});

afterEach(async () => {
  await h.close();
  capture.clear();
});

/** 추가 요청 본문을 DTO 인스턴스로 만든다(검증하지 않는다). */
function body(over: Record<string, unknown> = {}): CreateGoldenSetDto {
  return plainToInstance(CreateGoldenSetDto, {
    query: QUERY_SENT,
    doc_id: DOC_A,
    answer_span: SPAN_SENT,
    ...over,
  });
}

/** 목록 쿼리를 DTO 인스턴스로 만든다(기본값이 채워진다). */
function listQuery(over: Record<string, unknown> = {}): ListGoldenSetsQueryDto {
  return plainToInstance(ListGoldenSetsQueryDto, over);
}

/** 저장된 골든셋이다. */
function goldens(): GoldenSetRecord[] {
  return h.db.dump('golden_sets') as unknown as GoldenSetRecord[];
}

/** 저장된 평가 기록이다. */
function records(): EvaluationRecord[] {
  return h.db.dump('evaluation_records') as unknown as EvaluationRecord[];
}

/** 이 이름의 로그 줄이다. */
function linesOf(msg: string): Array<Record<string, unknown>> {
  return capture.parsed().filter((line) => line.msg === msg);
}

/** 기본 필드(PINO 기본 키)를 뺀 키 목록이다. */
function extraKeys(line: Record<string, unknown>): string[] {
  return Object.keys(line)
    .filter((key) => !PINO_BASE.includes(key))
    .sort();
}

/** 골든셋과 끝난 기록 하나씩을 넣는다. */
async function seedFinished(ids: string[], queries: string[] = []): Promise<void> {
  await seedEvaluation(
    h.db,
    ids.map((id, i) =>
      goldenSetRecord({
        goldenSetId: id,
        query: queries[i] ?? `q-${id}`,
        createdAt: new Date(Date.UTC(2026, 9, 1, i + 1)),
      }),
    ),
    ids.map((id) => evaluationRecord({ recordId: `r-${id}`, goldenSetId: id })),
  );
}

/** 호출마다 다른 deferred를 돌려주도록 가짜 RAG를 바꾸고 deferred 목록을 돌려준다. */
function ragDeferreds(): Array<ReturnType<typeof deferred<RagEvaluationResult>>> {
  const list: Array<ReturnType<typeof deferred<RagEvaluationResult>>> = [];
  h.rag.evaluate.mockImplementation((_req: RagEvaluationRequest) => {
    const d = deferred<RagEvaluationResult>();
    list.push(d);
    return d.promise;
  });
  return list;
}

/** 가짜 RAG가 받은 n번째 요청이다. */
function ragRequest(n = 0): RagEvaluationRequest {
  return h.rag.evaluate.mock.calls[n][0];
}

describe('REQ-BE-5.1.1', () => {
  it('T-ADD-1 추가하면 평가 중 기록과 골든셋을 저장하고 응답을 준다', async () => {
    const view = await h.service.create(body());
    expect(Object.keys(view).sort()).toEqual([
      'answer',
      'answer_span',
      'created_at',
      'edition_only',
      'golden_set_id',
      'latest',
      'query',
    ]);
    expect(view.golden_set_id).toMatch(UUID_PATTERN);
    expect(view.latest).toEqual({
      outcome: 'evaluating',
      n: null,
      base: null,
      expanded: null,
      error_message: null,
      evaluated_at: null,
    });
    expect(view.answer).toEqual({
      doc_id: DOC_A,
      name: NAME_SENT,
      edition: { label: LABEL_SENT, edition_date: '2025-01-31' },
    });
    expect(view.edition_only).toBe(false);
    const stored = h.db.dump('golden_sets');
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]).sort()).toEqual([
      'answerSpan',
      'createdAt',
      'docId',
      'editionOnly',
      'goldenSetId',
      'query',
    ]);
    expect(view.created_at).toBe(toIsoUtc(goldens()[0].createdAt));
    // ★ 시각은 EvaluationClock이 준 값이어야 한다
    const clockValues = h.clock.now.mock.results.map((r) => (r.value as Date).getTime());
    expect(clockValues).toContain(goldens()[0].createdAt.getTime());
    const stored2 = records();
    expect(stored2).toHaveLength(1);
    expect(stored2[0].outcome).toBe('evaluating');
    expect(stored2[0].goldenSetId).toBe(view.golden_set_id);
    expect(stored2[0].recordId).toMatch(UUID_PATTERN);
    expect(stored2[0].evaluatedAt).toBeNull();
    expect(clockValues).toContain(stored2[0].startedAt.getTime());
  });

  it('T-ADD-2 정답 문서가 없거나 삭제됐으면 404이고 아무것도 저장하지 않는다', async () => {
    h.documents.getEvaluationTarget.mockResolvedValueOnce(null);
    await expect(h.service.create(body())).rejects.toBeInstanceOf(DocumentNotFoundError);
    h.documents.getEvaluationTarget.mockResolvedValueOnce(evaluationTarget({ deleted: true }));
    const error = await h.service.create(body()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentNotFoundError);
    expect((error as DocumentNotFoundError).code).toBe('DOCUMENT_NOT_FOUND');
    expect(goldens()).toEqual([]);
    expect(records()).toEqual([]);
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
  });

  it('T-ADD-3 판 정보가 없는 문서에 edition_only가 참이면 INVALID_REQUEST다', async () => {
    h.documents.getEvaluationTarget.mockResolvedValue(evaluationTarget({ edition: null }));
    const error = await h.service.create(body({ edition_only: true })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).code).toBe('INVALID_REQUEST');
    expect((error as InvalidRequestError).message).toBe(EVALUATION_MESSAGES.editionRequired);
    expect(goldens()).toEqual([]);
    expect(records()).toEqual([]);
    // 같은 문서라도 edition_only가 거짓이면 된다
    await h.service.create(body({ edition_only: false }));
    // 판 있는 문서는 참도 된다
    h.documents.getEvaluationTarget.mockResolvedValue(evaluationTarget());
    await h.service.create(body({ edition_only: true }));
    // null은 거짓이다
    await h.service.create(body({ edition_only: null }));
    expect(goldens().map((g) => g.editionOnly)).toEqual([false, true, false]);
    await h.tasks.drain();
  });

  it('T-ADD-4 질의와 정답 구간을 다듬지 않고 저장한다', async () => {
    await h.service.create(body({ query: '  ' + QUERY_SENT + ' ', answer_span: ' ' + SPAN_SENT }));
    expect(goldens()[0].query).toBe('  ' + QUERY_SENT + ' ');
    expect(goldens()[0].answerSpan).toBe(' ' + SPAN_SENT);
    await h.tasks.drain();
  });

  it('T-ADD-6 기록 저장이 실패하면 골든셋은 저장되지 않는다', async () => {
    h.db.failNext('insertOne', new Error('db down'));
    await expect(h.service.create(body())).rejects.toThrow('db down');
    // ★ 평가 중 기록을 먼저 넣으므로 골든셋 저장까지 가지 않는다
    expect(goldens()).toEqual([]);
  });
});

describe('REQ-BE-5.1.2', () => {
  it('T-ADD-7 검색 가능이 아닌 문서는 409이고 삭제 확인이 먼저다', async () => {
    for (const searchState of ['not_searchable', 'replaced'] as const) {
      h.documents.getEvaluationTarget.mockResolvedValueOnce(evaluationTarget({ searchState }));
      const error = await h.service.create(body()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocumentNotSearchableError);
      expect((error as DocumentNotSearchableError).code).toBe('DOCUMENT_NOT_SEARCHABLE');
    }
    expect(goldens()).toEqual([]);
    expect(records()).toEqual([]);
    h.documents.getEvaluationTarget.mockResolvedValueOnce(
      evaluationTarget({ searchState: 'replaced', deleted: true }),
    );
    await expect(h.service.create(body())).rejects.toBeInstanceOf(DocumentNotFoundError);
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
  });
});

describe('REQ-BE-5.1.5', () => {
  it('T-ADD-5 정답 구간이 색인용 MD의 구역 안에 없으면 거부하고 검증 순서를 지킨다', async () => {
    await expect(h.service.create(body({ answer_span: '없는 문장' }))).rejects.toBeInstanceOf(
      AnswerSpanNotFoundError,
    );
    const error = await h.service
      .create(body({ answer_span: '인증서 종류별 유효 기간 표' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnswerSpanNotFoundError);
    expect((error as AnswerSpanNotFoundError).code).toBe('ANSWER_SPAN_NOT_FOUND');
    h.documents.getEvaluationTarget.mockResolvedValueOnce(
      evaluationTarget({ searchableIndexingMarkdown: null }),
    );
    await expect(h.service.create(body())).rejects.toBeInstanceOf(AnswerSpanNotFoundError);
    expect(goldens()).toEqual([]);
    expect(records()).toEqual([]);
    // 줄바꿈만 다른 구간은 성공한다
    await expect(
      h.service.create(body({ answer_span: SPAN_SENT.replace(/ /g, '\n') })),
    ).resolves.toBeDefined();
    await h.tasks.drain();
    // 검색 안 됨 문서 + 없는 구간 → 상태 오류가 먼저다
    h.documents.getEvaluationTarget.mockResolvedValueOnce(
      evaluationTarget({ searchState: 'not_searchable' }),
    );
    await expect(h.service.create(body({ answer_span: '없는 문장' }))).rejects.toBeInstanceOf(
      DocumentNotSearchableError,
    );
    // 판 없는 문서 + edition_only + 없는 구간 → 판 오류가 먼저다
    h.documents.getEvaluationTarget.mockResolvedValueOnce(evaluationTarget({ edition: null }));
    await expect(
      h.service.create(body({ edition_only: true, answer_span: '없는 문장' })),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe('REQ-BE-5.1.4', () => {
  it('T-DEL-1 골든셋과 그 기록을 모두 지운다', async () => {
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' }), goldenSetRecord({ goldenSetId: 'G2' })],
      [
        evaluationRecord({ recordId: 'r1', goldenSetId: 'G1' }),
        evaluationRecord({ recordId: 'r2', goldenSetId: 'G1' }),
        evaluationRecord({ recordId: 'r3', goldenSetId: 'G2' }),
      ],
    );
    await h.service.remove('G1');
    expect(goldens().map((g) => g.goldenSetId)).toEqual(['G2']);
    expect(records().map((r) => r.recordId)).toEqual(['r3']);
    expect((await h.service.summary()).golden_set_count).toBe(1);
    expect((await h.service.list(listQuery())).total).toBe(1);
  });

  it('T-DEL-2 없는 골든셋은 404이고 아무것도 바꾸지 않는다', async () => {
    await seedFinished(['G1']);
    const error = await h.service.remove('missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoldenSetNotFoundError);
    expect((error as GoldenSetNotFoundError).code).toBe('GOLDEN_SET_NOT_FOUND');
    expect(goldens()).toHaveLength(1);
    expect(records()).toHaveLength(1);
  });

  it('T-DEL-3 평가 중에 지워도 끝난 평가가 기록을 되살리지 않는다', async () => {
    const pending = ragDeferreds();
    const view = await h.service.create(body());
    await waitUntil(() => h.rag.evaluate.mock.calls.length === 1);
    await h.service.remove(view.golden_set_id);
    pending[0].resolve(ragEvalResult());
    await h.tasks.drain();
    expect(records()).toEqual([]);
    expect(linesOf('evaluation.done')).toHaveLength(0);
  });

  it('T-DEL-4 골든셋이 지워진 채 평가 중 기록만 남으면 RAG 없이 그 골든셋의 기록만 지운다', async () => {
    await seedFinished(['G2']);
    await seedEvaluation(h.db, [goldenSetRecord({ goldenSetId: 'G1' })], []);
    await h.service.evaluateOne('G1');
    expect(records().filter((r) => r.goldenSetId === 'G1')).toHaveLength(1);
    // 백그라운드 실행 전에 골든셋만 지운다(기록은 남는다)
    await h.db.collection('golden_sets').deleteMany({ goldenSetId: 'G1' });
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    expect(records().map((r) => r.goldenSetId)).toEqual(['G2']);
    expect(records()[0].outcome).toBe('hit');
    expect(goldens().map((g) => g.goldenSetId)).toEqual(['G2']);
    expect(linesOf('evaluation.done')).toHaveLength(0);
  });

  it('T-DEL-5 한 건 다시 평가가 기록을 넣은 뒤 골든셋이 지워지면 RAG 없이 기록이 남지 않는다', async () => {
    await seedFinished(['G1', 'G2']);
    await h.service.evaluateOne('G1');
    await h.db.collection('golden_sets').deleteMany({ goldenSetId: 'G1' });
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    expect(records().map((r) => r.goldenSetId)).toEqual(['G2']);
    expect(linesOf('evaluation.done')).toHaveLength(0);
  });

  it('T-DEL-6 전체 다시 평가가 기록을 넣은 뒤 골든셋이 지워지면 그 건만 RAG 없이 정리하고 나머지는 평가한다', async () => {
    await seedFinished(['G1', 'G2', 'G3'], ['q1', 'q2', 'q3']);
    await h.service.evaluateAll();
    expect(records().filter((r) => r.outcome === 'evaluating')).toHaveLength(3);
    await h.db.collection('golden_sets').deleteMany({ goldenSetId: 'G2' });
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(2);
    expect([0, 1].map((n) => ragRequest(n).query)).toEqual(['q1', 'q3']);
    expect(records().filter((r) => r.goldenSetId === 'G2')).toEqual([]);
    expect(records().filter((r) => r.outcome === 'evaluating')).toEqual([]);
    expect(linesOf('evaluation.done')).toHaveLength(2);
  });

  it('T-PR3-EVR-5 기록 삭제가 실패한 뒤 다시 지우면 404이고 남은 기록이 모두 지워진다', async () => {
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' }), goldenSetRecord({ goldenSetId: 'G2' })],
      [
        evaluationRecord({ recordId: 'r1', goldenSetId: 'G1' }),
        evaluationRecord({ recordId: 'r2', goldenSetId: 'G1' }),
        evaluationRecord({ recordId: 'r3', goldenSetId: 'G2' }),
      ],
    );
    // ★ failNext('deleteMany')는 골든셋 삭제(첫 deleteMany)에 걸리므로, 기록 컬렉션의 삭제만 스파이로 한 번 실패시킨다
    const spy = jest
      .spyOn(h.db.collection('evaluation_records'), 'deleteMany')
      .mockRejectedValueOnce(new Error('db down'));
    try {
      await expect(h.service.remove('G1')).rejects.toThrow('db down');
      expect(goldens().map((g) => g.goldenSetId)).toEqual(['G2']);
      expect(records().filter((r) => r.goldenSetId === 'G1')).toHaveLength(2);
      const error = await h.service.remove('G1').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GoldenSetNotFoundError);
    } finally {
      spy.mockRestore();
    }
    // ★ 골든셋이 이미 없어도 남은 기록은 지운다
    expect(records().map((r) => r.recordId)).toEqual(['r3']);
  });
});

describe('REQ-BE-5.2.1', () => {
  it('T-RUN-2 응답이 나간 뒤에 평가를 시작한다', async () => {
    await h.service.create(body());
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(1);
  });

  it('T-RUN-1 RAG 요청은 네 키뿐이고 topN을 보내지 않는다', async () => {
    await h.service.create(body());
    await h.tasks.drain();
    expect(ragRequest(0)).toEqual({
      query: QUERY_SENT,
      docId: DOC_A,
      answerSpan: SPAN_SENT,
      editionOnly: false,
    });
    expect(Object.keys(ragRequest(0)).sort()).toEqual([
      'answerSpan',
      'docId',
      'editionOnly',
      'query',
    ]);
    await h.service.create(body({ edition_only: true }));
    await h.tasks.drain();
    expect(ragRequest(1).editionOnly).toBe(true);
  });
});

describe('REQ-BE-5.2.2', () => {
  it('T-REC-1 RAG 응답의 N과 지표를 그대로 기록한다', async () => {
    const base = {
      hitAt1: false,
      hitAt3: false,
      hitAt5: true,
      hitAtN: true,
      rank: 5,
      reciprocalRank: 0.2,
      coverage: 0.4,
    };
    const expanded = {
      hitAt1: false,
      hitAt3: true,
      hitAt5: true,
      hitAtN: true,
      rank: 2,
      reciprocalRank: 0.5,
      coverage: 0.75,
    };
    h.rag.evaluate.mockResolvedValue({ n: 7, base, expanded });
    await h.service.create(body());
    await h.tasks.drain();
    const [record] = records();
    expect(record.outcome).toBe('hit');
    expect(record.n).toBe(7);
    expect(record.base).toEqual(base);
    expect(record.expanded).toEqual(expanded);
    expect(record.errorMessage).toBeNull();
    expect(record.evaluatedAt?.getTime()).toBe(h.clock.peek().getTime());
    const page = await h.service.list(listQuery());
    expect(page.items[0].latest).toEqual({
      outcome: 'hit',
      n: 7,
      base: {
        hit_at_1: false,
        hit_at_3: false,
        hit_at_5: true,
        hit_at_n: true,
        rank: 5,
        reciprocal_rank: 0.2,
        coverage: 0.4,
      },
      expanded: {
        hit_at_1: false,
        hit_at_3: true,
        hit_at_5: true,
        hit_at_n: true,
        rank: 2,
        reciprocal_rank: 0.5,
        coverage: 0.75,
      },
      error_message: null,
      evaluated_at: toIsoUtc(record.evaluatedAt as Date),
    });
  });
});

describe('REQ-BE-5.2.3', () => {
  it('T-ERR-1 RAG에 연결할 수 없으면 error 기록과 한국어 사유를 남긴다', async () => {
    h.rag.evaluate.mockRejectedValue(new RagUnavailableError());
    await h.service.create(body());
    await h.tasks.drain();
    const [record] = records();
    expect(record.outcome).toBe('error');
    expect(record.errorMessage).toBe('RAG Server에 연결할 수 없습니다');
    expect(record.n).toBeNull();
    expect(record.base).toBeNull();
    expect(record.expanded).toBeNull();
    expect(record.evaluatedAt).not.toBeNull();
  });

  it('T-ERR-2 RAG가 검색 불가로 거절하면 그 사유를 남긴다', async () => {
    h.rag.evaluate.mockRejectedValue(new RagRequestError(409, 'DOCUMENT_NOT_SEARCHABLE'));
    await h.service.create(body());
    await h.tasks.drain();
    expect(records()[0].errorMessage).toBe('정답 문서가 검색되지 않습니다');
  });

  it('T-ERR-3 예상하지 못한 예외도 사유에 내용을 싣지 않는다', async () => {
    h.rag.evaluate.mockRejectedValue(new Error('boom'));
    await h.service.create(body());
    await h.tasks.drain();
    expect(records()[0].errorMessage).toBe(EVALUATION_MESSAGES.unexpected);
    expect(records()[0].errorMessage).not.toContain('boom');
    // 평가 때의 문서 조회 실패
    h.rag.evaluate.mockResolvedValue(ragEvalResult());
    h.documents.getEvaluationTarget
      .mockResolvedValueOnce(evaluationTarget())
      .mockRejectedValueOnce(new Error('mongo boom'));
    await h.service.create(body());
    await h.tasks.drain();
    expect(records()[1].outcome).toBe('error');
    expect(records()[1].errorMessage).toBe(EVALUATION_MESSAGES.unexpected);
    expect(records()[1].errorMessage).not.toContain('boom');
  });

  it('T-ERR-4 평가 실패는 요청 예외로 나가지 않는다', async () => {
    h.rag.evaluate.mockRejectedValue(new RagUnavailableError());
    const view = await h.service.create(body());
    expect(view.latest.outcome).toBe('evaluating');
    await h.tasks.drain();
  });

  it('T-PR3-EVR-1 평가 중 확인(isEvaluating)이 실패하면 기록을 error로 끝내고 RAG를 부르지 않는다', async () => {
    await h.service.create(body());
    // ★ create 뒤, 백그라운드 평가 전에 건다. 평가의 첫 findOne(isEvaluating)이 실패한다
    h.db.failNext('findOne', new Error('db down'));
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    const [record] = records();
    expect(record.outcome).toBe('error');
    expect(record.errorMessage).toBe(EVALUATION_MESSAGES.unexpected);
    expect(record.errorMessage).not.toContain('db down');
    expect(record.evaluatedAt).not.toBeNull();
    const failed = linesOf('evaluation.task_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].task).toBe('evaluate');
  });

  it('T-PR3-EVR-2 기록 끝내기(finishRecord)가 실패하면 보조 갱신으로 error가 된다', async () => {
    await h.service.create(body());
    h.db.failNext('updateOne', new Error('db down'));
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(1);
    const [record] = records();
    expect(record.outcome).toBe('error');
    expect(record.errorMessage).toBe(EVALUATION_MESSAGES.unexpected);
    expect(linesOf('evaluation.task_failed')).toHaveLength(1);
    expect(linesOf('evaluation.done')).toHaveLength(0);
  });

  it('T-PR3-EVR-3 보조 갱신까지 실패하면 기록은 평가 중으로 남고 처리되지 않은 거부는 없다', async () => {
    const unhandled: unknown[] = [];
    let view!: GoldenSetView;
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      view = await h.service.create(body());
      h.db.failNext('updateOne', new Error('db down 1'));
      h.db.failNext('updateMany', new Error('db down 2'));
      await h.tasks.drain();
      // 거부가 처리되지 않았다면 이벤트 루프를 몇 번 돌려야 보고된다
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      // ★ 리스너는 반드시 해제한다
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(records()[0].outcome).toBe('evaluating');
    // ★ 원래 오류와 보조 갱신 실패가 각각 남는다 — 보조 갱신 실패(fail_records)가 먼저, 원래 오류(evaluate)가 다음이다.
    //   한 건 평가의 보조 갱신이라 둘 다 그 골든셋 ID다
    const failed = linesOf('evaluation.task_failed');
    expect(
      failed.map((line) => ({
        task: line.task,
        goldenSetId: line.goldenSetId,
        errorName: line.errorName,
      })),
    ).toEqual([
      { task: 'fail_records', goldenSetId: view.golden_set_id, errorName: 'Error' },
      { task: 'evaluate', goldenSetId: view.golden_set_id, errorName: 'Error' },
    ]);
  });
});

describe('REQ-BE-5.2.4', () => {
  it('T-ONE-1 한 건 다시 평가는 새 평가 중 기록을 만들고 끝나면 그 기록이 최근이다', async () => {
    await seedFinished(['G1']);
    h.rag.evaluate.mockResolvedValue(
      ragEvalResult({ base: missMetrics(), expanded: missMetrics() }),
    );
    await h.service.evaluateOne('G1');
    expect(records()).toHaveLength(2);
    expect(records()[1].outcome).toBe('evaluating');
    await h.tasks.drain();
    expect(records().map((r) => r.outcome)).toEqual(['hit', 'miss']);
    const page = await h.service.list(listQuery());
    expect(page.items[0].latest.outcome).toBe('miss');
  });

  it('T-ONE-2 없는 골든셋은 404이고 기록을 바꾸지 않는다', async () => {
    await seedFinished(['G1']);
    await expect(h.service.evaluateOne('missing')).rejects.toBeInstanceOf(GoldenSetNotFoundError);
    expect(records()).toHaveLength(1);
  });

  it('T-ONE-3 평가 중인 골든셋의 한 건 다시 평가도 받고 기록마다 따로 끝난다', async () => {
    const pending = ragDeferreds();
    const view = await h.service.create(body());
    await waitUntil(() => pending.length === 1);
    await h.service.evaluateOne(view.golden_set_id);
    await waitUntil(() => pending.length === 2);
    pending[1].resolve(ragEvalResult({ base: missMetrics(), expanded: missMetrics() }));
    pending[0].resolve(ragEvalResult());
    await h.tasks.drain();
    expect(records().map((r) => r.outcome)).toEqual(['hit', 'miss']);
    const page = await h.service.list(listQuery());
    // ★ 늦게 시작한 기록이 최근이다
    expect(page.items[0].latest.outcome).toBe('miss');
  });

  it('T-ALL-1 전체 다시 평가는 응답 전에 모든 골든셋을 평가 중으로 두고 차례로 평가한다', async () => {
    await seedFinished(['G1', 'G2', 'G3'], ['q1', 'q2', 'q3']);
    await h.service.evaluateAll();
    expect(records()).toHaveLength(6);
    expect(records().filter((r) => r.outcome === 'evaluating')).toHaveLength(3);
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    await h.tasks.drain();
    for (const id of ['G1', 'G2', 'G3']) {
      expect(records().filter((r) => r.goldenSetId === id)).toHaveLength(2);
    }
    expect(h.rag.evaluate.mock.calls.map((call) => call[0].query)).toEqual(['q1', 'q2', 'q3']);
  });

  it('T-ALL-2 한 번에 한 건씩만 RAG를 부른다', async () => {
    await seedFinished(['G1', 'G2', 'G3'], ['q1', 'q2', 'q3']);
    const pending = ragDeferreds();
    await h.service.evaluateAll();
    await waitUntil(() => pending.length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(h.rag.evaluate).toHaveBeenCalledTimes(1);
    pending[0].resolve(ragEvalResult());
    await waitUntil(() => pending.length === 2);
    expect(h.rag.evaluate).toHaveBeenCalledTimes(2);
    pending[1].resolve(ragEvalResult());
    await waitUntil(() => pending.length === 3);
    expect(h.rag.evaluate).toHaveBeenCalledTimes(3);
    pending[2].resolve(ragEvalResult());
    await h.tasks.drain();
  });

  it('T-ALL-3 골든셋이 없으면 아무것도 하지 않고 정상 반환한다', async () => {
    await expect(h.service.evaluateAll()).resolves.toBeUndefined();
    expect(h.db.calls.some((call) => call.op === 'insertMany')).toBe(false);
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
  });

  it('T-ALL-4 한 건의 기록 저장이 실패해도 다음 건으로 간다', async () => {
    await seedFinished(['G1', 'G2', 'G3']);
    await h.service.evaluateAll();
    // ★ evaluateAll 뒤, drain 전에 건다. 첫 평가의 finishRecord가 실패한다
    h.db.failNext('updateOne', new Error('db'));
    await h.tasks.drain();
    const failed = linesOf('evaluation.task_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].task).toBe('evaluate_all');
    expect(failed[0].goldenSetId).toBe('G1');
    expect(h.rag.evaluate).toHaveBeenCalledTimes(3);
    const g1New = records().filter((r) => r.goldenSetId === 'G1' && r.recordId !== 'r-G1');
    expect(g1New).toHaveLength(1);
    // ★ 기록 끝내기가 실패해도 보조 갱신이 평가 실패로 끝낸다(평가 중으로 남지 않는다)
    expect(g1New[0].outcome).toBe('error');
    expect(g1New[0].errorMessage).toBe(EVALUATION_MESSAGES.unexpected);
  });

  it('T-ALL-5 종료가 시작되면 남은 건을 평가하지 않는다', async () => {
    await seedFinished(['G1', 'G2', 'G3']);
    const first = deferred<RagEvaluationResult>();
    h.rag.evaluate.mockImplementationOnce(() => first.promise);
    await h.service.evaluateAll();
    await waitUntil(() => h.rag.evaluate.mock.calls.length === 1);
    const stop = h.tasks.beforeApplicationShutdown();
    first.resolve(ragEvalResult());
    await stop;
    expect(h.rag.evaluate).toHaveBeenCalledTimes(1);
    // ★ 남은 건의 새 기록은 평가 중으로 남는다 (다음 기동 때 정리된다)
    expect(
      records()
        .filter((r) => r.outcome === 'evaluating')
        .map((r) => r.goldenSetId)
        .sort(),
    ).toEqual(['G2', 'G3']);
  });

  /** 부분 실패 시나리오의 공통 준비다: 앞 두 건이 들어간 뒤 insertMany가 실패한다. */
  async function failPartialInsert(): Promise<void> {
    await seedFinished(['G1', 'G2', 'G3']);
    // ★ 앞 두 건만 들어간 뒤 실패한다(ordered insertMany)
    h.db.failNext('insertMany', new Error('db down'), { insertFirst: 2 });
  }

  it('T-PR3-EVR-4 기록 저장이 부분 실패하면 이번 요청이 만든 기록을 지워 이전 최근 기록이 그대로이고 다음 전체 다시 평가는 성공한다', async () => {
    await failPartialInsert();
    const seeded = JSON.stringify(records());
    await expect(h.service.evaluateAll()).rejects.toThrow('db down');
    // ★ 시드한 기록 셋뿐이고 값이 그대로다
    expect(records().map((r) => r.recordId)).toEqual(['r-G1', 'r-G2', 'r-G3']);
    expect(JSON.stringify(records())).toBe(seeded);
    expect(records().filter((r) => r.outcome === 'evaluating')).toEqual([]);
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    const page = await h.service.list(listQuery());
    expect(page.items.map((item) => item.latest.outcome)).toEqual(['hit', 'hit', 'hit']);
    // 평가 중 기록이 남지 않았으므로 다음 요청은 409가 아니다
    await expect(h.service.evaluateAll()).resolves.toBeUndefined();
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(3);
  });

  it('T-FU-EVR-6 이번 요청 기록을 지우지 못하면 error로 끝내고 원래 오류로 거부한다', async () => {
    await failPartialInsert();
    h.db.failNext('deleteMany', new Error('delete down'));
    await expect(h.service.evaluateAll()).rejects.toThrow('db down');
    // ★ 기동 때 고아 기록을 지우는 deleteMany와 구별하려고 recordId 조건이 있는 호출을 본다
    expect(
      h.db.calls.some(
        (call) => call.op === 'deleteMany' && JSON.stringify(call.filter).includes('recordId'),
      ),
    ).toBe(true);
    const added = records().filter((r) => !r.recordId.startsWith('r-'));
    expect(added).toHaveLength(2);
    for (const record of added) {
      expect(record.outcome).toBe('error');
      expect(record.errorMessage).toBe(EVALUATION_MESSAGES.unexpected);
    }
    expect(records().filter((r) => r.outcome === 'evaluating')).toEqual([]);
  });

  it('T-FU-EVR-7 지우기와 error 끝내기가 모두 실패하면 기록은 평가 중으로 남고 fail_records 작업 실패 로그가 실패마다 하나씩 남는다', async () => {
    await failPartialInsert();
    h.db.failNext('deleteMany', new Error('delete down'));
    h.db.failNext('updateMany', new Error('update down'));
    await expect(h.service.evaluateAll()).rejects.toThrow('db down');
    const added = records().filter((r) => !r.recordId.startsWith('r-'));
    expect(added).toHaveLength(2);
    expect(added.map((r) => r.outcome)).toEqual(['evaluating', 'evaluating']);
    // ★ 지우기 실패, 끝내기 실패 순서다. 여러 골든셋에 걸친 기록이라 goldenSetId는 null이다
    const failed = linesOf('evaluation.task_failed');
    expect(
      failed.map((line) => ({
        task: line.task,
        goldenSetId: line.goldenSetId,
        errorName: line.errorName,
      })),
    ).toEqual([
      { task: 'fail_records', goldenSetId: null, errorName: 'Error' },
      { task: 'fail_records', goldenSetId: null, errorName: 'Error' },
    ]);
  });

  it('T-FU-EVR-9 지우기만 실패하고 error 끝내기가 성공해도 지우기 실패가 fail_records 작업 실패 로그로 남는다', async () => {
    await failPartialInsert();
    h.db.failNext('deleteMany', new Error('SECRET-DELETE-78'));
    await expect(h.service.evaluateAll()).rejects.toThrow('db down');
    const added = records().filter((r) => !r.recordId.startsWith('r-'));
    expect(added.map((r) => r.outcome)).toEqual(['error', 'error']);
    const failed = linesOf('evaluation.task_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].task).toBe('fail_records');
    expect(failed[0].goldenSetId).toBeNull();
    expect(failed[0].errorName).toBe('Error');
    // ★ 오류 메시지는 남기지 않는다
    for (const line of capture.lines) expect(line).not.toContain('SECRET-DELETE-78');
  });

  it('T-FU-EVR-8 기록 지우기는 이번 요청의 평가 중 기록만 대상으로 한다', async () => {
    await seedFinished(['G1', 'G2']);
    // ★ 골든셋을 시드하지 않은 고아 평가 중 기록이다(전체 다시 평가가 409로 막히지 않게 한다)
    await h.db
      .collection('evaluation_records')
      .insertOne({ ...evaluatingRecord({ recordId: 'r-orphan', goldenSetId: 'GX' }) });
    h.db.failNext('insertMany', new Error('db down'), { insertFirst: 1 });
    await expect(h.service.evaluateAll()).rejects.toThrow('db down');
    expect(records().map((r) => r.recordId)).toEqual(['r-G1', 'r-G2', 'r-orphan']);
    expect(records().find((r) => r.recordId === 'r-orphan')?.outcome).toBe('evaluating');
  });
});

describe('REQ-BE-5.2.5', () => {
  it('T-PROG-1 평가 중인 골든셋이 있으면 전체 다시 평가를 거부한다', async () => {
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' }), goldenSetRecord({ goldenSetId: 'G2' })],
      [
        evaluatingRecord({ recordId: 'r1', goldenSetId: 'G1' }),
        evaluationRecord({ recordId: 'r2', goldenSetId: 'G2' }),
      ],
    );
    const error = await h.service.evaluateAll().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvaluationInProgressError);
    expect((error as EvaluationInProgressError).code).toBe('EVALUATION_IN_PROGRESS');
    expect(records()).toHaveLength(2);
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
  });

  it('T-PROG-2 동시에 온 두 전체 다시 평가 중 하나만 통과한다', async () => {
    await seedFinished(['G1', 'G2']);
    const settled = await Promise.allSettled([h.service.evaluateAll(), h.service.evaluateAll()]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(EvaluationInProgressError);
    // 기존 2개 + 골든셋당 새 기록 하나
    expect(records()).toHaveLength(4);
    await h.tasks.drain();
  });

  it('T-PROG-4 기록 저장이 실패해도 표시가 풀려 다음 전체 다시 평가를 받는다', async () => {
    await seedFinished(['G1', 'G2']);
    h.db.failNext('insertMany', new Error('db'));
    await expect(h.service.evaluateAll()).rejects.toThrow('db');
    await expect(h.service.evaluateAll()).resolves.toBeUndefined();
    await h.tasks.drain();
  });

  it('T-PROG-3 끝난 뒤에는 다시 요청할 수 있다', async () => {
    await seedFinished(['G1', 'G2']);
    await Promise.allSettled([h.service.evaluateAll(), h.service.evaluateAll()]);
    await h.tasks.drain();
    await expect(h.service.evaluateAll()).resolves.toBeUndefined();
    await h.tasks.drain();
  });
});

describe('REQ-BE-5.2.6', () => {
  it('T-HIT-1 확장 후 Hit@N만으로 결과를 정한다', async () => {
    h.rag.evaluate
      .mockResolvedValueOnce(
        ragEvalResult({ base: missMetrics(), expanded: ragMetrics({ rank: 4 }) }),
      )
      .mockResolvedValueOnce(ragEvalResult({ base: ragMetrics(), expanded: missMetrics() }));
    const first = await h.service.create(body());
    const second = await h.service.create(body());
    await h.tasks.drain();
    const outcomeOf = (id: string): string | undefined =>
      records().find((r) => r.goldenSetId === id)?.outcome;
    expect(outcomeOf(first.golden_set_id)).toBe('hit');
    expect(outcomeOf(second.golden_set_id)).toBe('miss');
  });
});

describe('REQ-BE-5.2.7', () => {
  it('T-NS-1 평가 직전 검색 가능이 아니면 RAG를 부르지 않고 error로 기록한다', async () => {
    await seedFinished(['G1']);
    h.documents.getEvaluationTarget.mockResolvedValue(
      evaluationTarget({ searchState: 'replaced' }),
    );
    await h.service.evaluateOne('G1');
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
    const added = records().find((r) => r.recordId !== 'r-G1');
    expect(added?.outcome).toBe('error');
    expect(added?.errorMessage).toBe('정답 문서가 검색되지 않습니다');
  });

  it('T-NS-2 삭제됐거나 없는 문서도 같은 결과다', async () => {
    await seedFinished(['G1']);
    for (const target of [evaluationTarget({ deleted: true }), null]) {
      h.documents.getEvaluationTarget.mockResolvedValue(target);
      await h.service.evaluateOne('G1');
      await h.tasks.drain();
      const last = records()[records().length - 1];
      expect(last.outcome).toBe('error');
      expect(last.errorMessage).toBe('정답 문서가 검색되지 않습니다');
    }
    expect(h.rag.evaluate).toHaveBeenCalledTimes(0);
  });

  it('T-NS-3 전체 다시 평가에서 검색 불가 문서만 error가 되고 나머지는 평가한다', async () => {
    await seedEvaluation(
      h.db,
      [
        goldenSetRecord({
          goldenSetId: 'G1',
          docId: DOC_A,
          createdAt: new Date('2026-10-01T01:00:00Z'),
        }),
        goldenSetRecord({
          goldenSetId: 'G2',
          docId: DOC_B,
          createdAt: new Date('2026-10-01T02:00:00Z'),
        }),
      ],
      [
        evaluationRecord({ recordId: 'r1', goldenSetId: 'G1' }),
        evaluationRecord({ recordId: 'r2', goldenSetId: 'G2' }),
      ],
    );
    h.documents.getEvaluationTarget.mockImplementation(async (docId: string) =>
      docId === DOC_A
        ? evaluationTarget({ docId: DOC_A, searchState: 'replaced' })
        : evaluationTarget({ docId: DOC_B }),
    );
    await h.service.evaluateAll();
    await h.tasks.drain();
    expect(h.rag.evaluate).toHaveBeenCalledTimes(1);
    expect(ragRequest(0).docId).toBe(DOC_B);
    const g1New = records().find((r) => r.goldenSetId === 'G1' && r.recordId !== 'r1');
    expect(g1New?.outcome).toBe('error');
    expect(g1New?.errorMessage).toBe('정답 문서가 검색되지 않습니다');
  });
});

describe('REQ-BE-5.2.8', () => {
  it('T-BOOT-1 기동하면 남은 평가 중 기록을 모두 평가 실패로 바꾸고 경고를 남긴다', async () => {
    await h.close();
    capture.clear();
    h = await buildEvaluationTestModule({ stream: capture.stream, init: false });
    await seedEvaluation(
      h.db,
      [
        goldenSetRecord({ goldenSetId: 'G1' }),
        goldenSetRecord({ goldenSetId: 'G2' }),
        goldenSetRecord({ goldenSetId: 'G3' }),
      ],
      [
        evaluatingRecord({ recordId: 'R1', goldenSetId: 'G1' }),
        evaluatingRecord({ recordId: 'R2', goldenSetId: 'G2' }),
        evaluationRecord({ recordId: 'R3', goldenSetId: 'G3' }),
      ],
    );
    await h.moduleRef.init();
    const byId = (id: string): EvaluationRecord =>
      records().find((r) => r.recordId === id) as EvaluationRecord;
    for (const id of ['R1', 'R2']) {
      expect(byId(id).outcome).toBe('error');
      expect(byId(id).errorMessage).toBe('서버가 다시 시작해 평가하지 못했습니다');
      expect(byId(id).evaluatedAt?.getTime()).toBe(h.clock.peek().getTime());
    }
    expect(byId('R3').outcome).toBe('hit');
    const cleanup = linesOf('evaluation.restart_cleanup');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].level).toBe(40);
    expect(extraKeys(cleanup[0])).toEqual(['count']);
    expect(cleanup[0].count).toBe(2);
  });

  it('T-BOOT-2 정리 뒤에는 전체 다시 평가를 요청할 수 있다', async () => {
    await h.close();
    capture.clear();
    h = await buildEvaluationTestModule({ stream: capture.stream, init: false });
    await seedEvaluation(
      h.db,
      [
        goldenSetRecord({ goldenSetId: 'G1' }),
        goldenSetRecord({ goldenSetId: 'G2' }),
        goldenSetRecord({ goldenSetId: 'G3' }),
      ],
      [
        evaluatingRecord({ recordId: 'R1', goldenSetId: 'G1' }),
        evaluatingRecord({ recordId: 'R2', goldenSetId: 'G2' }),
        evaluationRecord({ recordId: 'R3', goldenSetId: 'G3' }),
      ],
    );
    await h.moduleRef.init();
    await expect(h.service.evaluateAll()).resolves.toBeUndefined();
    expect(records()).toHaveLength(6);
    await h.tasks.drain();
  });

  it('T-BOOT-3 평가 중 기록이 없으면 경고를 남기지 않고 인덱스를 만든다', () => {
    // beforeEach에서 이미 init했다
    expect(linesOf('evaluation.restart_cleanup')).toHaveLength(0);
    expect(h.db.calls.filter((call) => call.op === 'createIndex').length).toBeGreaterThanOrEqual(4);
  });

  it('T-PR3-ORPH-1 기동하면 골든셋이 없는 기록을 지우고 건수를 남기며, 없으면 로그도 없다', async () => {
    await h.close();
    capture.clear();
    h = await buildEvaluationTestModule({ stream: capture.stream, init: false });
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' })],
      [
        evaluationRecord({ recordId: 'R1', goldenSetId: 'G1' }),
        // 골든셋이 없는 기록 둘(하나는 평가 중으로 남은 것)
        evaluationRecord({ recordId: 'RX', goldenSetId: 'GX' }),
        evaluatingRecord({ recordId: 'RY', goldenSetId: 'GY' }),
      ],
    );
    await h.moduleRef.init();
    expect(records().map((r) => r.recordId)).toEqual(['R1']);
    const cleaned = linesOf('evaluation.orphan_cleaned');
    expect(cleaned).toHaveLength(1);
    expect(extraKeys(cleaned[0])).toEqual(['goldenSetId', 'removed']);
    expect(cleaned[0].goldenSetId).toBeNull();
    expect(cleaned[0].removed).toBe(2);

    // 고아가 없는 기동은 로그를 남기지 않는다
    await h.close();
    capture.clear();
    h = await buildEvaluationTestModule({ stream: capture.stream, init: false });
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' })],
      [evaluationRecord({ recordId: 'R1', goldenSetId: 'G1' })],
    );
    await h.moduleRef.init();
    expect(records().map((r) => r.recordId)).toEqual(['R1']);
    expect(linesOf('evaluation.orphan_cleaned')).toHaveLength(0);
  });
});

describe('REQ-BE-5.3.2', () => {
  it('T-LATEST-1 startedAt이 가장 늦은 기록이 최근 기록이다', async () => {
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' })],
      // ★ 최근 기록(r2, miss)은 삽입 순서 가운데이고 recordId 순서로도 처음·끝이 아니다
      [
        evaluationRecord({
          recordId: 'r1',
          goldenSetId: 'G1',
          outcome: 'error',
          n: null,
          base: null,
          expanded: null,
          startedAt: new Date('2026-10-02T00:00:00Z'),
        }),
        evaluationRecord({
          recordId: 'r2',
          goldenSetId: 'G1',
          outcome: 'miss',
          expanded: missMetrics(),
          startedAt: new Date('2026-10-03T00:00:00Z'),
        }),
        evaluationRecord({
          recordId: 'r3',
          goldenSetId: 'G1',
          outcome: 'hit',
          startedAt: new Date('2026-10-01T00:00:00Z'),
        }),
      ],
    );
    const page = await h.service.list(listQuery());
    expect(page.items[0].latest.outcome).toBe('miss');
  });

  it('T-PR3-EVL-1 골든셋마다 시작이 가장 늦은 기록이 latest이고 기록은 aggregate 한 번으로 읽는다', async () => {
    await seedEvaluation(
      h.db,
      [goldenSetRecord({ goldenSetId: 'G1' }), goldenSetRecord({ goldenSetId: 'G2' })],
      [
        evaluationRecord({
          recordId: 'r1',
          goldenSetId: 'G1',
          outcome: 'hit',
          startedAt: new Date('2026-10-01T00:00:00Z'),
        }),
        evaluationRecord({
          recordId: 'r2',
          goldenSetId: 'G1',
          outcome: 'miss',
          expanded: missMetrics(),
          startedAt: new Date('2026-10-03T00:00:00Z'),
        }),
        evaluationRecord({
          recordId: 'r3',
          goldenSetId: 'G1',
          outcome: 'error',
          n: null,
          base: null,
          expanded: null,
          startedAt: new Date('2026-10-02T00:00:00Z'),
        }),
        evaluationRecord({
          recordId: 'r4',
          goldenSetId: 'G2',
          outcome: 'hit',
          startedAt: new Date('2026-10-01T00:00:00Z'),
        }),
      ],
    );
    // ★ 시드 호출 기록을 비운 뒤 목록 조회 한 번만 센다
    h.db.calls.length = 0;
    const page = await h.service.list(listQuery({ sort: 'created_at', order: 'asc' }));
    const latestOf = (id: string): string | undefined =>
      page.items.find((item) => item.golden_set_id === id)?.latest.outcome;
    expect(latestOf('G1')).toBe('miss');
    expect(latestOf('G2')).toBe('hit');
    // ★ golden_sets의 find는 남는다. 평가 기록을 읽는 find(goldenSetId 조건)는 없어야 한다
    const recordFinds = h.db.calls.filter(
      (call) => call.op === 'find' && JSON.stringify(call.filter).includes('goldenSetId'),
    );
    expect(recordFinds).toEqual([]);
    const aggregates = h.db.calls.filter((call) => call.op === 'aggregate');
    expect(aggregates).toHaveLength(1);
    // 골든셋마다 기록 하나씩만 읽는다
    expect(aggregates[0].returned).toBe(2);
  });

  it('T-LATEST-2 페이지 안의 문서만 조회하고 없는 문서·삭제된 문서를 채운다', async () => {
    const sets: GoldenSetRecord[] = [];
    const recs: EvaluationRecord[] = [];
    for (let i = 0; i < 25; i += 1) {
      const id = `G${i}`;
      sets.push(
        goldenSetRecord({
          goldenSetId: id,
          docId: `doc-${i}`,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
        }),
      );
      recs.push(evaluationRecord({ recordId: `r${i}`, goldenSetId: id }));
    }
    await seedEvaluation(h.db, sets, recs);
    h.documents.getRef.mockImplementation(async (docId: string) => {
      if (docId === 'doc-24') return null;
      if (docId === 'doc-23') {
        return {
          docId,
          name: 'DEL-NAME',
          edition: { label: 'DEL-LABEL', editionDate: '2025-02-02' },
          deleted: true,
        };
      }
      return { docId, name: NAME_SENT, edition: null, deleted: false };
    });
    const page = await h.service.list(listQuery({ page: 1, page_size: 20 }));
    // ★ 페이지 안(20건) 문서만 부른다
    expect(h.documents.getRef).toHaveBeenCalledTimes(20);
    expect(page.items[0].answer.name).toBe('알 수 없는 문서');
    expect(page.items[1].answer).toEqual({
      doc_id: 'doc-23',
      name: 'DEL-NAME',
      edition: { label: 'DEL-LABEL', edition_date: '2025-02-02' },
    });
  });
});

/** 목록 공통 행 A~E를 Db에 넣는다. */
async function seedRowsAE(): Promise<void> {
  const at = (hhmm: string): Date => new Date(`2026-10-05T${hhmm}:00Z`);
  const created = (hhmm: string): Date => new Date(`2026-10-05T${hhmm}:00Z`);
  await seedEvaluation(
    h.db,
    [
      goldenSetRecord({ goldenSetId: 'A', createdAt: created('01:00') }),
      goldenSetRecord({ goldenSetId: 'B', createdAt: created('02:00') }),
      goldenSetRecord({ goldenSetId: 'C', createdAt: created('03:00') }),
      goldenSetRecord({ goldenSetId: 'D', createdAt: created('04:00') }),
      goldenSetRecord({ goldenSetId: 'E', createdAt: created('05:00') }),
    ],
    [
      evaluationRecord({
        recordId: 'rA',
        goldenSetId: 'A',
        outcome: 'hit',
        expanded: ragMetrics({ rank: 1, coverage: 1.0 }),
        evaluatedAt: at('10:05'),
      }),
      evaluationRecord({
        recordId: 'rB',
        goldenSetId: 'B',
        outcome: 'hit',
        expanded: ragMetrics({ rank: 3, coverage: 0.5 }),
        evaluatedAt: at('10:03'),
      }),
      evaluationRecord({
        recordId: 'rC',
        goldenSetId: 'C',
        outcome: 'miss',
        expanded: { ...missMetrics(), coverage: 0.2 },
        evaluatedAt: at('10:04'),
      }),
      evaluatingRecord({ recordId: 'rD', goldenSetId: 'D' }),
      evaluationRecord({
        recordId: 'rE',
        goldenSetId: 'E',
        outcome: 'error',
        n: null,
        base: null,
        expanded: null,
        errorMessage: '실패',
        evaluatedAt: at('10:09'),
      }),
    ],
  );
}

/** 목록 항목의 골든셋 ID 순서다. */
function idsOf(items: GoldenSetView[]): string[] {
  return items.map((item) => item.golden_set_id);
}

describe('REQ-BE-5.3.1', () => {
  it('T-SVC-LIST-1 거르기·정렬·페이지를 적용한다', async () => {
    await seedRowsAE();
    const hit = await h.service.list(
      listQuery({ outcome: 'hit', sort: 'created_at', order: 'asc' }),
    );
    expect(hit.total).toBe(2);
    expect(idsOf(hit.items)).toEqual(['A', 'B']);
    const ranked = await h.service.list(listQuery({ sort: 'rank', order: 'asc' }));
    expect(idsOf(ranked.items)).toEqual(['A', 'B', 'E', 'D', 'C']);
    const beyond = await h.service.list(listQuery({ page: 2, page_size: 20 }));
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(5);
    expect(beyond.page).toBe(2);
    expect(beyond.page_size).toBe(20);
  });
});

describe('REQ-BE-5.3.3', () => {
  it('T-SVC-SUM-1 골든셋 없는 기록은 세지 않고 요약을 계산한다', async () => {
    await seedEvaluation(
      h.db,
      [
        goldenSetRecord({ goldenSetId: 'G1' }),
        goldenSetRecord({ goldenSetId: 'G2' }),
        goldenSetRecord({ goldenSetId: 'G3' }),
      ],
      [
        evaluationRecord({
          recordId: 'r1',
          goldenSetId: 'G1',
          outcome: 'hit',
          base: missMetrics(),
          expanded: ragMetrics(),
        }),
        evaluationRecord({
          recordId: 'r2',
          goldenSetId: 'G2',
          outcome: 'miss',
          base: missMetrics(),
          expanded: missMetrics(),
        }),
        evaluationRecord({
          recordId: 'r3',
          goldenSetId: 'G3',
          outcome: 'error',
          n: null,
          base: null,
          expanded: null,
        }),
        evaluationRecord({ recordId: 'r4', goldenSetId: 'G4' }),
      ],
    );
    const summary = await h.service.summary();
    expect(summary.expanded.hit_at_1).toBe(0.5);
    expect(summary.expanded.mrr).toBe(0.5);
    expect(summary.expanded.hit_at_n).toBe(0.5);
    expect(summary.base).toEqual({ hit_at_1: 0, hit_at_3: 0, hit_at_5: 0, hit_at_n: 0, mrr: 0 });
    expect(summary.golden_set_count).toBe(3);
    expect(summary.evaluating_count).toBe(0);
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-LOG-1 평가를 끝내면 evaluation.done 한 줄을 남긴다', async () => {
    h.rag.evaluate.mockResolvedValue(
      ragEvalResult({ expanded: ragMetrics({ hitAt1: false, rank: 2 }) }),
    );
    await h.service.create(body());
    await h.tasks.drain();
    let done = linesOf('evaluation.done');
    expect(done).toHaveLength(1);
    expect(done[0].level).toBe(30);
    expect(done[0].context).toBe('EvaluationService');
    expect(extraKeys(done[0])).toEqual(['elapsedMs', 'goldenSetId', 'outcome', 'rank']);
    expect(done[0].outcome).toBe('hit');
    expect(done[0].rank).toBe(2);
    expect(Number.isInteger(done[0].elapsedMs)).toBe(true);
    expect(done[0].elapsedMs as number).toBeGreaterThanOrEqual(0);

    capture.clear();
    h.rag.evaluate.mockRejectedValue(new RagUnavailableError());
    await h.service.create(body());
    await h.tasks.drain();
    done = linesOf('evaluation.done');
    expect(done).toHaveLength(1);
    expect(extraKeys(done[0])).toEqual(['elapsedMs', 'goldenSetId', 'outcome', 'rank']);
    expect(done[0].outcome).toBe('error');
    expect(done[0].rank).toBeNull();
    expect(Number.isInteger(done[0].elapsedMs)).toBe(true);
  });

  it('T-LOG-2 어느 흐름에서도 질의·정답 구간·문서 정보·RAG 오류 코드를 로그에 남기지 않는다', async () => {
    const view = await h.service.create(body());
    await h.tasks.drain();
    h.rag.evaluate.mockRejectedValue(new RagRequestError(500, 'SECRET-CODE-76'));
    await h.service.evaluateOne(view.golden_set_id);
    await h.tasks.drain();
    await h.service.evaluateAll();
    // 작업 실패 경로(T-ALL-4 방식)
    h.db.failNext('updateOne', new Error('db'));
    await h.tasks.drain();
    // ★ 실패 경로를 실제로 탔는지 확인한다(주입한 실패가 소비되지 않으면 이 검사가 무의미하다)
    expect(linesOf('evaluation.task_failed')).toHaveLength(1);
    await h.service.remove(view.golden_set_id);
    expect(capture.lines.length).toBeGreaterThan(0);
    for (const sentinel of [
      'QUERY-SENT-71',
      'SPAN-SENT-72',
      NAME_SENT,
      LABEL_SENT,
      IDX_SENT,
      'SECRET-CODE-76',
    ]) {
      for (const line of capture.lines) expect(line).not.toContain(sentinel);
    }
    expect(JSON.stringify(h.db.dump('evaluation_records'))).not.toContain('SECRET-CODE-76');
  });

  it('T-LOG-3 작업 실패 로그는 작업 이름·골든셋 ID·오류 이름만 남긴다', async () => {
    await seedFinished(['G1', 'G2', 'G3']);
    await h.service.evaluateAll();
    h.db.failNext('updateOne', new Error('db'));
    await h.tasks.drain();
    const failed = linesOf('evaluation.task_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].level).toBe(40);
    expect(extraKeys(failed[0])).toEqual(['errorName', 'goldenSetId', 'task']);
    expect(failed[0].errorName).toBe('Error');
  });

  it('T-FU-LOG-4 보조 갱신 실패 로그는 작업 이름·골든셋 ID·오류 이름만 남기고 오류 메시지는 남기지 않는다', async () => {
    const view = await h.service.create(body());
    h.db.failNext('updateOne', new Error('db down 1'));
    h.db.failNext('updateMany', new Error('SECRET-UPDATE-77'));
    await h.tasks.drain();
    const failed = linesOf('evaluation.task_failed').filter((line) => line.task === 'fail_records');
    expect(failed).toHaveLength(1);
    expect(failed[0].level).toBe(40);
    expect(extraKeys(failed[0])).toEqual(['errorName', 'goldenSetId', 'task']);
    // ★ 한 건 평가의 보조 갱신이라 그 골든셋 ID다
    expect(failed[0].goldenSetId).toBe(view.golden_set_id);
    for (const line of capture.lines) expect(line).not.toContain('SECRET-UPDATE-77');
  });
});
