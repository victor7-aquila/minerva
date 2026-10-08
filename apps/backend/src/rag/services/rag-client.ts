import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { RagUnavailableError } from '../../common';
import type { AppConfig } from '../../common';
import { RagRequestError } from '../interfaces/rag-request-error';
import type {
  RagDocumentChunks,
  RagEdition,
  RagEvaluationRequest,
  RagEvaluationResult,
  RagIndexJob,
  RagIndexJobAccepted,
  RagIndexRequest,
  RagIndexState,
  RagSearchRequest,
  RagSearchResult,
} from '../interfaces/rag.types';
import {
  arrayField,
  fromDocumentChunks,
  fromEvaluationResult,
  fromIndexJob,
  fromIndexJobAccepted,
  fromIndexState,
  fromSearchResult,
  toEditionBody,
  toEvaluationBody,
  toIndexJobBody,
  toSearchBody,
} from '../helpers/rag-wire';

/** 로그의 operation 값이다. 메서드 이름과 같다. */
type RagOperation =
  | 'summarizeTable'
  | 'captionImage'
  | 'submitIndexJob'
  | 'getIndexJob'
  | 'deleteDocument'
  | 'getIndexState'
  | 'getIndexStates'
  | 'updateMetadata'
  | 'getDocumentChunks'
  | 'search'
  | 'evaluate';

/** 요청 하나의 정의다. */
interface RagCall<T> {
  operation: RagOperation;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** '/v1/...' 형태. 경로 변수는 이미 encodeURIComponent 되어 있다 */
  path: string;
  /** JSON 본문. form과 함께 쓰지 않는다 */
  json?: unknown;
  /** multipart 본문 */
  form?: FormData;
  timeoutMs: number;
  /** 성공 본문(최상위 객체)을 결과로 바꾼다. 없으면 본문을 해석하지 않고 undefined를 돌려준다 */
  parse?: (body: Record<string, unknown>) => T;
}

/** getIndexStates 한 번에 보내는 문서 수 한도다 (API.md 1~100개). */
const INDEX_STATES_BATCH = 100;

/** 오류 응답 본문에서 error.code를 꺼낸다. 읽을 수 없으면 undefined다. */
function errorCodeOf(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null) return undefined;
    const error = (body as Record<string, unknown>).error;
    if (typeof error !== 'object' || error === null) return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' && code !== '' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** RAG Server API 클라이언트다. */
@Injectable()
export class RagClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly captionTimeoutMs: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('RagClient');
    this.baseUrl = config.get('RAG_SERVER_URL', { infer: true }).replace(/\/+$/, '');
    // ★ 토큰을 로그나 오류에 넣지 않는다
    this.token = config.get('RAG_SERVER_API_TOKEN', { infer: true });
    this.timeoutMs = config.get('RAG_TIMEOUT_MS', { infer: true });
    this.captionTimeoutMs = config.get('RAG_CAPTION_TIMEOUT_MS', { infer: true });
  }

  /** 표 마크다운을 한 문장으로 요약한다. */
  summarizeTable(tableMarkdown: string): Promise<string> {
    return this.call({
      operation: 'summarizeTable',
      method: 'POST',
      path: '/v1/captions/table',
      json: { table_markdown: tableMarkdown },
      timeoutMs: this.captionTimeoutMs,
      parse: (b) => b.summary as string,
    });
  }

  /** 이미지 캡션을 만든다. */
  captionImage(image: Buffer, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([image]), fileName);
    return this.call({
      operation: 'captionImage',
      method: 'POST',
      path: '/v1/captions/image',
      form,
      timeoutMs: this.captionTimeoutMs,
      parse: (b) => b.caption as string,
    });
  }

  /** 색인 작업을 요청한다. */
  submitIndexJob(req: RagIndexRequest): Promise<RagIndexJobAccepted> {
    return this.call({
      operation: 'submitIndexJob',
      method: 'POST',
      path: '/v1/index-jobs',
      json: toIndexJobBody(req),
      timeoutMs: this.timeoutMs,
      parse: fromIndexJobAccepted,
    });
  }

  /** 색인 작업 상태를 조회한다. */
  getIndexJob(jobId: string): Promise<RagIndexJob> {
    return this.call({
      operation: 'getIndexJob',
      method: 'GET',
      path: `/v1/index-jobs/${encodeURIComponent(jobId)}`,
      timeoutMs: this.timeoutMs,
      parse: fromIndexJob,
    });
  }

  /** 문서를 RAG Server에서 지운다. */
  deleteDocument(docId: string): Promise<void> {
    return this.call<void>({
      operation: 'deleteDocument',
      method: 'DELETE',
      path: `/v1/documents/${encodeURIComponent(docId)}`,
      timeoutMs: this.timeoutMs,
    });
  }

  /** 문서 하나의 색인 상태를 조회한다. */
  getIndexState(docId: string): Promise<RagIndexState> {
    return this.call({
      operation: 'getIndexState',
      method: 'GET',
      path: `/v1/documents/${encodeURIComponent(docId)}/index-state`,
      timeoutMs: this.timeoutMs,
      parse: fromIndexState,
    });
  }

  /** 여러 문서의 색인 상태를 조회한다. */
  async getIndexStates(docIds: readonly string[]): Promise<RagIndexState[]> {
    if (docIds.length === 0) return [];
    const states: RagIndexState[] = [];
    for (let start = 0; start < docIds.length; start += INDEX_STATES_BATCH) {
      const batch = docIds.slice(start, start + INDEX_STATES_BATCH);
      // ★ 묶음을 차례로 부르고 받은 순서대로 잇는다
      const items = await this.call({
        operation: 'getIndexStates',
        method: 'POST',
        path: '/v1/documents/index-states',
        json: { doc_ids: batch },
        timeoutMs: this.timeoutMs,
        parse: (b) => arrayField(b, 'items').map(fromIndexState),
      });
      // ★ 응답 크기는 외부 서버가 정하므로 펼침 push 대신 반복문으로 넣는다
      for (const item of items) states.push(item);
    }
    return states;
  }

  /** 문서의 이름·판 정보를 고친다. */
  updateMetadata(docId: string, name: string, edition: RagEdition | null): Promise<void> {
    return this.call<void>({
      operation: 'updateMetadata',
      method: 'PUT',
      path: `/v1/documents/${encodeURIComponent(docId)}/metadata`,
      json: { name, edition: edition === null ? null : toEditionBody(edition) },
      timeoutMs: this.timeoutMs,
    });
  }

  /** 문서의 지금 검색되는 청크를 조회한다. */
  getDocumentChunks(docId: string): Promise<RagDocumentChunks> {
    return this.call({
      operation: 'getDocumentChunks',
      method: 'GET',
      path: `/v1/documents/${encodeURIComponent(docId)}/chunks`,
      timeoutMs: this.timeoutMs,
      parse: fromDocumentChunks,
    });
  }

  /** 검색한다. */
  search(req: RagSearchRequest): Promise<RagSearchResult[]> {
    return this.call({
      operation: 'search',
      method: 'POST',
      path: '/v1/search',
      json: toSearchBody(req),
      timeoutMs: this.timeoutMs,
      parse: (b) => arrayField(b, 'results').map(fromSearchResult),
    });
  }

  /** 골든셋 한 건을 평가한다. */
  evaluate(req: RagEvaluationRequest): Promise<RagEvaluationResult> {
    return this.call({
      operation: 'evaluate',
      method: 'POST',
      path: '/v1/evaluations',
      json: toEvaluationBody(req),
      timeoutMs: this.timeoutMs,
      parse: fromEvaluationResult,
    });
  }

  /** 요청을 보내고 응답을 결과로 바꾼다. 실패는 RagUnavailableError 또는 RagRequestError로 바꾼다. */
  private async call<T>(spec: RagCall<T>): Promise<T> {
    const headers: Record<string, string> = {
      'X-Minerva-Token': this.token,
      Accept: 'application/json',
    };
    let body: string | FormData | undefined;
    if (spec.form) {
      // ★ Content-Type을 넣지 않는다 (multipart 경계는 fetch가 만든다)
      body = spec.form;
    } else if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }

    const signal = AbortSignal.timeout(spec.timeoutMs);
    const startedAt = performance.now();

    // ★ try 범위는 fetch와 본문 읽기뿐이다. 오류 종류는 가르지 않는다 (Jest 교차 realm)
    let status: number | null = null;
    let text: string;
    try {
      const res = await fetch(this.baseUrl + spec.path, {
        method: spec.method,
        headers,
        body,
        signal,
        redirect: 'error',
      });
      status = res.status;
      text = await res.text();
    } catch {
      this.fail(
        spec.operation,
        status,
        signal.aborted ? 'TIMEOUT' : 'CONNECTION_FAILED',
        startedAt,
      );
      // ★ 원래 오류를 cause로 붙이지 않는다 (호스트·포트 노출)
      throw new RagUnavailableError();
    }

    if (status === 503) {
      this.fail(spec.operation, 503, errorCodeOf(text) ?? 'UNKNOWN', startedAt);
      throw new RagUnavailableError();
    }
    if (status < 200 || status >= 300) {
      const code = errorCodeOf(text) ?? 'UNKNOWN';
      this.fail(spec.operation, status, code, startedAt);
      throw new RagRequestError(status, code);
    }
    if (!spec.parse) return undefined as T;

    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('invalid');
      }
      return spec.parse(parsed as Record<string, unknown>);
    } catch {
      this.fail(spec.operation, status, 'INVALID_RESPONSE', startedAt);
      throw new RagUnavailableError();
    }
  }

  /** 실패를 로그 한 줄로 남긴다. ★ 필드는 넷뿐이다 (본문·주소·토큰 금지). */
  private fail(
    operation: RagOperation,
    status: number | null,
    code: string,
    startedAt: number,
  ): void {
    this.logger.warn(
      { operation, status, code, elapsedMs: Math.round(performance.now() - startedAt) },
      'rag.call_failed',
    );
  }
}
