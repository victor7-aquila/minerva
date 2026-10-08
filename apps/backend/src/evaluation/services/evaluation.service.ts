import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toPage } from '../../../libs/utils';
import type { Page } from '../../../libs/utils';
import {
  AnswerSpanNotFoundError,
  DocumentNotFoundError,
  DocumentNotSearchableError,
  EvaluationInProgressError,
  GoldenSetNotFoundError,
  InvalidRequestError,
} from '../../common';
import { DocumentsService } from '../../documents';
import { RagClient } from '../../rag';
import { containsAnswerSpan } from '../helpers/answer-span';
import { failureMessageOf, outcomeOf } from '../helpers/evaluation-outcome';
import { summarize } from '../helpers/evaluation-summary';
import { toAnswerView, toGoldenSetView } from '../helpers/evaluation-views';
import {
  evaluationOrder,
  filterRows,
  joinLatest,
  latestByGoldenSet,
  pageRows,
  sortRows,
} from '../helpers/golden-set-list';
import type { CreateGoldenSetDto, ListGoldenSetsQueryDto } from '../interfaces/evaluation.dto';
import { EVALUATION_MESSAGES } from '../interfaces/evaluation.types';
import type {
  EvaluationRecord,
  EvaluationSummaryView,
  GoldenSetRecord,
  GoldenSetRow,
  GoldenSetView,
  RecordFinish,
} from '../interfaces/evaluation.types';
import { EvaluationClock } from './evaluation-clock';
import { EvaluationCrudService } from './evaluation-crud.service';
import { EvaluationTasks } from './evaluation-tasks';

/** 평가 결과 중 끝낼 때 정하는 값이다. */
type EvaluationResultValues = Omit<RecordFinish, 'evaluatedAt'>;

/** 골든셋과 평가를 다룬다. */
@Injectable()
export class EvaluationService implements OnModuleInit {
  private startingAll = false;

  constructor(
    @Inject(EvaluationCrudService) private readonly repo: EvaluationCrudService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(RagClient) private readonly rag: RagClient,
    @Inject(EvaluationTasks) private readonly tasks: EvaluationTasks,
    @Inject(EvaluationClock) private readonly clock: EvaluationClock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('EvaluationService');
  }

  /** 인덱스를 만들고 남은 평가 중 기록을 평가 실패로 바꾼다. */
  async onModuleInit(): Promise<void> {
    await this.repo.ensureIndexes();
    const count = await this.repo.failEvaluating(EVALUATION_MESSAGES.restarted, this.clock.now());
    if (count > 0) this.logger.warn({ count }, 'evaluation.restart_cleanup');
    // ★ 골든셋 삭제 중 기록 삭제가 실패해 남은 고아 기록을 지운다
    const removed = await this.repo.deleteOrphanRecords(await this.repo.findAllGoldenSetIds());
    if (removed > 0) this.logger.info({ goldenSetId: null, removed }, 'evaluation.orphan_cleaned');
  }

  /** 골든셋을 추가하고 평가를 시작한다. */
  async create(body: CreateGoldenSetDto): Promise<GoldenSetView> {
    const target = await this.documents.getEvaluationTarget(body.doc_id);
    if (target === null || target.deleted) throw new DocumentNotFoundError();
    if (target.searchState !== 'searchable') throw new DocumentNotSearchableError();
    const editionOnly = body.edition_only ?? false;
    if (editionOnly && target.edition === null) {
      throw new InvalidRequestError(EVALUATION_MESSAGES.editionRequired);
    }
    if (
      target.searchableIndexingMarkdown === null ||
      !containsAnswerSpan(target.searchableIndexingMarkdown, body.answer_span)
    ) {
      throw new AnswerSpanNotFoundError();
    }
    // ★ query·answer_span을 다듬지 않고 저장한다
    const goldenSet: GoldenSetRecord = {
      goldenSetId: randomUUID(),
      query: body.query,
      docId: body.doc_id,
      answerSpan: body.answer_span,
      editionOnly,
      createdAt: this.clock.now(),
    };
    const record = this.newRecord(goldenSet.goldenSetId);
    // ★ 기록 먼저, 골든셋 나중 — 보이는 골든셋에는 늘 기록이 있다
    await this.repo.insertRecord(record);
    await this.repo.insertGoldenSet(goldenSet);
    this.tasks.run('evaluate', goldenSet.goldenSetId, () =>
      this.runEvaluation(goldenSet, record.recordId),
    );
    return toGoldenSetView(goldenSet, record, toAnswerView(goldenSet.docId, target));
  }

  /** 골든셋과 그 기록을 지운다. */
  async remove(goldenSetId: string): Promise<void> {
    const deleted = await this.repo.deleteGoldenSet(goldenSetId);
    // ★ 골든셋 먼저, 기록 나중. 앞선 삭제가 기록 삭제에서 실패했으면 다시 부를 때 남은 기록을 지운다
    await this.repo.deleteRecordsOf(goldenSetId);
    if (!deleted) throw new GoldenSetNotFoundError();
  }

  /** 골든셋 한 건을 다시 평가한다. */
  async evaluateOne(goldenSetId: string): Promise<void> {
    const goldenSet = await this.repo.findGoldenSet(goldenSetId);
    if (goldenSet === null) throw new GoldenSetNotFoundError();
    // 평가 중인 골든셋도 받는다. 새 기록이 최근 기록이 된다
    const record = this.newRecord(goldenSetId);
    await this.repo.insertRecord(record);
    this.tasks.run('evaluate', goldenSetId, () => this.runEvaluation(goldenSet, record.recordId));
  }

  /** 모든 골든셋을 다시 평가한다. */
  async evaluateAll(): Promise<void> {
    // ★ 같은 프로세스에서 동시에 온 두 요청이 둘 다 통과하지 않게 한다
    if (this.startingAll) throw new EvaluationInProgressError();
    this.startingAll = true;
    try {
      const rows = await this.loadRows();
      if (rows.some((row) => row.latest.outcome === 'evaluating')) {
        throw new EvaluationInProgressError();
      }
      const items = evaluationOrder(rows).map((row) => ({
        goldenSet: row.goldenSet,
        record: this.newRecord(row.goldenSet.goldenSetId),
      }));
      // ★ 응답 전에 모두 평가 중으로 둔다 — 바로 뒤의 전체 다시 평가가 409를 받는다
      try {
        await this.repo.insertRecords(items.map((item) => item.record));
      } catch (error) {
        // ★ 일부만 들어갔을 수 있다. 이번 요청이 만든 평가 중 기록을 지워 골든셋마다 이전 최근 기록을 그대로 두고,
        //   지우지 못하면 평가 중으로 남지 않게 실패로 끝내 본다 (REQ-BE-5.2.4). 원래 오류가 우선이다
        await this.discardStarted(items.map((item) => item.record.recordId));
        throw error;
      }
      if (items.length > 0) this.tasks.run('evaluate_all', null, () => this.runAll(items));
    } finally {
      this.startingAll = false;
    }
  }

  /** 골든셋 목록을 준다. */
  async list(query: ListGoldenSetsQueryDto): Promise<Page<GoldenSetView>> {
    const rows = sortRows(
      filterRows(await this.loadRows(), query.outcome),
      query.sort ?? 'created_at',
      query.order ?? 'desc',
    );
    const pageItems = pageRows(rows, query.page ?? 1, query.page_size ?? 20);
    const refs = await Promise.all(
      pageItems.map((row) => this.documents.getRef(row.goldenSet.docId)),
    );
    const items = pageItems.map((row, i) =>
      toGoldenSetView(
        row.goldenSet,
        row.latest,
        toAnswerView(row.goldenSet.docId, refs[i] ?? null),
      ),
    );
    return toPage(items, rows.length, query);
  }

  /** 요약 지표를 준다. */
  async summary(): Promise<EvaluationSummaryView> {
    return summarize(await this.loadRows());
  }

  /** 새 평가 중 기록을 만든다. */
  private newRecord(goldenSetId: string): EvaluationRecord {
    return {
      recordId: randomUUID(),
      goldenSetId,
      outcome: 'evaluating',
      n: null,
      base: null,
      expanded: null,
      errorMessage: null,
      startedAt: this.clock.now(),
      evaluatedAt: null,
    };
  }

  /** 골든셋 전체와 그 최근 기록을 읽는다. */
  private async loadRows(): Promise<GoldenSetRow[]> {
    const goldenSets = await this.repo.findAllGoldenSets();
    const records = await this.repo.findLatestRecordsOf(goldenSets.map((g) => g.goldenSetId));
    return joinLatest(goldenSets, latestByGoldenSet(records));
  }

  /** 골든셋을 하나씩 차례로 평가한다. 한 건이 실패해도 다음 건으로 간다. */
  private async runAll(
    items: readonly { goldenSet: GoldenSetRecord; record: EvaluationRecord }[],
  ): Promise<void> {
    for (const { goldenSet, record } of items) {
      // ★ 종료 중이면 남은 건을 돌지 않는다. 남은 평가 중 기록은 다음 기동 때 정리된다
      if (this.tasks.stopping) return;
      try {
        await this.runEvaluation(goldenSet, record.recordId);
      } catch (error) {
        this.tasks.logFailure('evaluate_all', goldenSet.goldenSetId, error);
      }
    }
  }

  /** 평가 한 건을 실행해 기록을 끝낸다. 평가 실패는 예외로 내보내지 않는다. */
  private async runEvaluation(goldenSet: GoldenSetRecord, recordId: string): Promise<void> {
    if (this.tasks.stopping) return;
    const started = performance.now();
    try {
      // ★ 골든셋이 지워졌으면 RAG Server를 부르지 않는다
      if (!(await this.repo.isEvaluating(recordId))) return;
      // ★ 골든셋 삭제와 겹쳐 뒤늦게 만들어진 고아 기록이면 RAG 호출 없이 정리하고 끝낸다
      if ((await this.repo.findGoldenSet(goldenSet.goldenSetId)) === null) {
        const removed = await this.repo.deleteRecordsOf(goldenSet.goldenSetId);
        // ★ 질의·정답 구간은 로그에 넣지 않는다
        this.logger.info(
          { goldenSetId: goldenSet.goldenSetId, removed },
          'evaluation.orphan_cleaned',
        );
        return;
      }
      const result = await this.evaluateGoldenSet(goldenSet);
      const finished = await this.repo.finishRecord(recordId, {
        ...result,
        evaluatedAt: this.clock.now(),
      });
      if (!finished) return;
      this.logger.info(
        {
          goldenSetId: goldenSet.goldenSetId,
          outcome: result.outcome,
          rank: result.expanded?.rank ?? null,
          elapsedMs: Math.round(performance.now() - started),
        },
        'evaluation.done',
      );
    } catch (error) {
      // ★ 평가 중으로 남지 않게 실패로 한 번 더 끝내 본다. 이것도 실패하면 기동 정리가 맡는다
      await this.failQuietly([recordId]);
      throw error;
    }
  }

  /** 기록들을 예상하지 못한 오류로 끝내 본다. ★ 실패는 삼킨다 — 원래 오류가 우선이다 */
  private async failQuietly(recordIds: readonly string[]): Promise<void> {
    try {
      await this.repo.failRecords(recordIds, EVALUATION_MESSAGES.unexpected, this.clock.now());
    } catch (error) {
      // ★ 삼키되 남긴다 — 기록이 평가 중으로 남았을 수 있다. 원래 오류가 우선이다
      this.tasks.logFailure('fail_records', null, error);
    }
  }

  /** 이번 요청이 만든 평가 중 기록을 지운다. 지우지 못하면 실패로 끝내 본다. ★ 실패는 삼킨다 — 원래 오류가 우선이다 */
  private async discardStarted(recordIds: readonly string[]): Promise<void> {
    try {
      await this.repo.deleteEvaluatingRecords(recordIds);
    } catch {
      // ★ 지우기가 실패하면 남았을 수 있는 기록을 error로 끝낸다
      await this.failQuietly(recordIds);
    }
  }

  /** 정답 문서를 확인하고 RAG Server로 평가한다. 실패는 사유로 바꿔 돌려준다. */
  private async evaluateGoldenSet(goldenSet: GoldenSetRecord): Promise<EvaluationResultValues> {
    const failed = (errorMessage: string): EvaluationResultValues => ({
      outcome: 'error',
      n: null,
      base: null,
      expanded: null,
      errorMessage,
    });
    try {
      const target = await this.documents.getEvaluationTarget(goldenSet.docId);
      // ★ 삭제된 문서도 searchState가 searchable일 수 있다 — deleted를 따로 본다
      if (target === null || target.deleted || target.searchState !== 'searchable') {
        return failed(EVALUATION_MESSAGES.notSearchable);
      }
      // ★ topN을 보내지 않는다 — RAG Server 기본 개수를 쓴다
      const result = await this.rag.evaluate({
        query: goldenSet.query,
        docId: goldenSet.docId,
        answerSpan: goldenSet.answerSpan,
        editionOnly: goldenSet.editionOnly,
      });
      return {
        outcome: outcomeOf(result),
        n: result.n,
        base: { ...result.base },
        expanded: { ...result.expanded },
        errorMessage: null,
      };
    } catch (error) {
      return failed(failureMessageOf(error));
    }
  }
}
