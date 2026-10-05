import type {
  RagDocumentChunk,
  RagDocumentChunks,
  RagEdition,
  RagEvaluationMetrics,
  RagEvaluationRequest,
  RagEvaluationResult,
  RagIndexJob,
  RagIndexJobAccepted,
  RagIndexRequest,
  RagIndexState,
  RagJobFailure,
  RagJobResult,
  RagResultChunk,
  RagResultEdition,
  RagSearchRequest,
  RagSearchResult,
} from '../interfaces/rag.types';

/** 본문 객체 타입이다. */
type Body = Record<string, unknown>;

/** 판 정보를 전송 형식으로 바꾼다. */
export function toEditionBody(edition: RagEdition): { label: string; edition_date: string } {
  return { label: edition.label, edition_date: edition.editionDate };
}

/** 색인 요청을 전송 본문으로 바꾼다. edition이 null이면 키를 뺀다. */
export function toIndexJobBody(req: RagIndexRequest): Body {
  const body: Body = {
    doc_id: req.docId,
    version: req.version,
    markdown: req.markdown,
    assets: req.assets.map((a) => ({ placeholder_id: a.placeholderId, text: a.text })),
    name: req.name,
    chunking: req.chunking,
    force: req.force,
  };
  // ★ null이면 키 자체를 뺀다 (JSON.stringify는 null을 그대로 내보낸다)
  if (req.edition !== null) body.edition = toEditionBody(req.edition);
  return body;
}

/** 검색 요청을 전송 본문으로 바꾼다. */
export function toSearchBody(req: RagSearchRequest): Body {
  return {
    query: req.query,
    top_n: req.topN,
    doc_ids: req.docIds ? [...req.docIds] : undefined,
    edition_scope: req.editionScope,
    edition: req.edition ? { name: req.edition.name, label: req.edition.label } : undefined,
    expand_neighbors: req.expandNeighbors,
  };
}

/** 평가 요청을 전송 본문으로 바꾼다. */
export function toEvaluationBody(req: RagEvaluationRequest): Body {
  return {
    query: req.query,
    doc_id: req.docId,
    answer_span: req.answerSpan,
    edition_only: req.editionOnly,
    top_n: req.topN,
  };
}

/** 응답 본문의 배열 필드를 꺼낸다. 배열이 아니면 Error를 던진다. 호출 흐름이 RagUnavailableError로 바꾼다. */
export function arrayField(body: Body, key: string): Body[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error('응답 필드가 배열이 아니다');
  return value as Body[];
}

/** 색인 요청 접수 응답을 공개 형태로 바꾼다. */
export function fromIndexJobAccepted(body: Body): RagIndexJobAccepted {
  return {
    outcome: body.outcome as RagIndexJobAccepted['outcome'],
    jobId: body.job_id as string,
    docId: body.doc_id as string,
    version: body.version as string,
  };
}

/** 작업 실패 사유를 공개 형태로 바꾼다. */
function fromJobFailure(body: Body): RagJobFailure {
  return {
    code: body.code as string,
    message: body.message as string,
    headingPath: (body.heading_path as string[] | null | undefined) ?? null,
    placeholderId: (body.placeholder_id as string | null | undefined) ?? null,
  };
}

/** 작업 결과를 공개 형태로 바꾼다. */
function fromJobResult(body: Body): RagJobResult {
  return { chunkCount: body.chunk_count as number, fallbackUsed: body.fallback_used as boolean };
}

/** 색인 작업 상태를 공개 형태로 바꾼다. */
export function fromIndexJob(body: Body): RagIndexJob {
  const failure = body.failure as Body | null | undefined;
  const result = body.result as Body | null | undefined;
  return {
    jobId: body.job_id as string,
    docId: body.doc_id as string,
    version: body.version as string,
    state: body.state as RagIndexJob['state'],
    stage: (body.stage as RagIndexJob['stage'] | undefined) ?? null,
    failure: failure ? fromJobFailure(failure) : null,
    result: result ? fromJobResult(result) : null,
  };
}

/** 문서 색인 상태를 공개 형태로 바꾼다. */
export function fromIndexState(body: Body): RagIndexState {
  return {
    docId: body.doc_id as string,
    searchableVersion: (body.searchable_version as string | null | undefined) ?? null,
    latestJobId: (body.latest_job_id as string | null | undefined) ?? null,
    latestJobState: (body.latest_job_state as RagIndexState['latestJobState'] | undefined) ?? null,
    latestJobStage: (body.latest_job_stage as RagIndexState['latestJobStage'] | undefined) ?? null,
  };
}

/** 문서 청크 하나를 공개 형태로 바꾼다. */
function fromDocumentChunk(body: Body): RagDocumentChunk {
  return {
    chunkId: body.chunk_id as string,
    order: body.order as number,
    kind: body.kind as RagDocumentChunk['kind'],
    headingPath: body.heading_path as string[],
    title: (body.title as string | null | undefined) ?? null,
    summary: (body.summary as string | null | undefined) ?? null,
    text: body.text as string,
    placeholderIds: body.placeholder_ids as string[],
    splitIndex: (body.split_index as number | null | undefined) ?? null,
    splitTotal: (body.split_total as number | null | undefined) ?? null,
  };
}

/** 문서 청크 조회 응답을 공개 형태로 바꾼다. */
export function fromDocumentChunks(body: Body): RagDocumentChunks {
  return {
    version: (body.version as string | null | undefined) ?? null,
    items: arrayField(body, 'items').map(fromDocumentChunk),
  };
}

/** 검색 결과 청크 하나를 공개 형태로 바꾼다. */
function fromResultChunk(body: Body): RagResultChunk {
  return {
    chunkId: body.chunk_id as string,
    kind: body.kind as RagResultChunk['kind'],
    text: body.text as string,
    placeholderIds: body.placeholder_ids as string[],
    splitIndex: (body.split_index as number | null | undefined) ?? null,
    splitTotal: (body.split_total as number | null | undefined) ?? null,
  };
}

/** 검색 결과의 판 정보를 공개 형태로 바꾼다. */
function fromResultEdition(body: Body): RagResultEdition {
  return {
    label: body.label as string,
    editionDate: body.edition_date as string,
    isLatest: body.is_latest as boolean,
  };
}

/** 검색 결과 하나를 공개 형태로 바꾼다. */
export function fromSearchResult(body: Body): RagSearchResult {
  const edition = body.edition as Body | null | undefined;
  return {
    rank: body.rank as number,
    score: body.score as number,
    docId: body.doc_id as string,
    version: body.version as string,
    headingPath: body.heading_path as string[],
    name: body.name as string,
    edition: edition ? fromResultEdition(edition) : null,
    otherEditionsInResults: body.other_editions_in_results as boolean,
    chunks: arrayField(body, 'chunks').map(fromResultChunk),
    before: arrayField(body, 'before').map(fromResultChunk),
    after: arrayField(body, 'after').map(fromResultChunk),
  };
}

/** 평가 지표를 공개 형태로 바꾼다. */
function fromMetrics(body: Body): RagEvaluationMetrics {
  return {
    hitAt1: body.hit_at_1 as boolean,
    hitAt3: body.hit_at_3 as boolean,
    hitAt5: body.hit_at_5 as boolean,
    hitAtN: body.hit_at_n as boolean,
    rank: (body.rank as number | null | undefined) ?? null,
    reciprocalRank: body.reciprocal_rank as number,
    coverage: body.coverage as number,
  };
}

/** 평가 결과를 공개 형태로 바꾼다. */
export function fromEvaluationResult(body: Body): RagEvaluationResult {
  return {
    n: body.n as number,
    base: fromMetrics(body.base as Body),
    expanded: fromMetrics(body.expanded as Body),
  };
}
