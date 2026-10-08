import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import { RagEventDto, toNotification } from './rag-event.dto';

/** 오류 경로를 모은다. 중첩은 `parent.child`다. */
function collectPaths(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix === '' ? error.property : `${prefix}.${error.property}`;
    const own = error.constraints === undefined ? [] : [path];
    return own.concat(collectPaths(error.children ?? [], path));
  });
}

/**
 * 본문을 검증하고 오류 경로를 돌려준다.
 * ★ api createValidationPipe와 같은 옵션이다. 실제 전역 파이프는 T-E2E-VAL-1이 본다(indexing 단위 테스트는 api를 import하지 않는다)
 */
async function validateBody(body: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(RagEventDto, body) as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return collectPaths(errors);
}

/** 정상 본문을 만든다. 호출마다 새 객체다. */
function valid(): Record<string, unknown> {
  return {
    doc_id: 'doc-1',
    job_id: 'job-1',
    version: '3',
    job_state: 'running',
    index_state: {
      searchable_version: null,
      latest_job_id: 'job-1',
      latest_job_state: 'running',
      latest_job_stage: 'embedding',
    },
    sequence: 1,
  };
}

/** 정상 본문의 index_state 일부를 고친 본문을 만든다. */
function withState(over: Record<string, unknown>): Record<string, unknown> {
  const body = valid();
  body.index_state = { ...(body.index_state as Record<string, unknown>), ...over };
  return body;
}

const TOP_FIELDS = ['doc_id', 'job_id', 'version', 'job_state', 'index_state', 'sequence'];
const STATE_FIELDS = [
  'searchable_version',
  'latest_job_id',
  'latest_job_state',
  'latest_job_stage',
];

describe('REQ-BE-3.2.2', () => {
  it('T-DTO-1 정상 본문과 허용 값은 오류가 없다', async () => {
    expect(await validateBody(valid())).toEqual([]);
    expect(await validateBody(withState({ searchable_version: '2' }))).toEqual([]);
    expect(await validateBody(withState({ latest_job_stage: null }))).toEqual([]);
    for (const jobState of ['queued', 'running', 'succeeded', 'failed', 'superseded']) {
      expect(await validateBody({ ...valid(), job_state: jobState })).toEqual([]);
    }
  });

  it.each(TOP_FIELDS)('T-DTO-2 최상위 필드 %s가 빠지면 오류다', async (field) => {
    const body = valid();
    delete body[field];
    expect(await validateBody(body)).toContain(field);
  });

  it.each(STATE_FIELDS)('T-DTO-2 index_state.%s가 빠지면 오류다', async (field) => {
    const body = valid();
    delete (body.index_state as Record<string, unknown>)[field];
    expect(await validateBody(body)).toContain(`index_state.${field}`);
  });

  it('T-DTO-3 정해진 값 밖의 상태·단계는 오류다', async () => {
    expect(await validateBody({ ...valid(), job_state: 'done' })).toContain('job_state');
    expect(await validateBody(withState({ latest_job_state: 'x' }))).toContain(
      'index_state.latest_job_state',
    );
    expect(await validateBody(withState({ latest_job_stage: 'parsing' }))).toContain(
      'index_state.latest_job_stage',
    );
  });

  it('T-DTO-4 sequence는 1 이상의 안전한 정수여야 한다', async () => {
    for (const sequence of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 2]) {
      expect(await validateBody({ ...valid(), sequence })).toContain('sequence');
    }
    expect(await validateBody({ ...valid(), sequence: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });

  it('T-DTO-5 모르는 필드는 오류다', async () => {
    expect(await validateBody({ ...valid(), extra: 1 })).toContain('extra');
    expect(await validateBody(withState({ extra: 1 }))).toContain('index_state.extra');
  });

  it('T-DTO-6 index_state가 객체가 아니면 오류다', async () => {
    for (const value of [null, 'x', []]) {
      expect(await validateBody({ ...valid(), index_state: value })).toContain('index_state');
    }
  });

  it('T-DTO-7 빈 문자열과 문자열이 아닌 ID는 오류다', async () => {
    expect(await validateBody({ ...valid(), doc_id: '' })).toContain('doc_id');
    expect(await validateBody({ ...valid(), job_id: '' })).toContain('job_id');
    expect(await validateBody({ ...valid(), version: '' })).toContain('version');
    expect(await validateBody(withState({ latest_job_id: '' }))).toContain(
      'index_state.latest_job_id',
    );
    expect(await validateBody(withState({ searchable_version: '' }))).toContain(
      'index_state.searchable_version',
    );
    expect(await validateBody({ ...valid(), doc_id: 1 })).toContain('doc_id');
  });

  it('T-DTO-7b null이 허용되지 않는 필드의 null은 오류다', async () => {
    expect(await validateBody({ ...valid(), doc_id: null })).toContain('doc_id');
    expect(await validateBody({ ...valid(), job_state: null })).toContain('job_state');
    expect(await validateBody(withState({ latest_job_id: null }))).toContain(
      'index_state.latest_job_id',
    );
    expect(await validateBody(withState({ latest_job_state: null }))).toContain(
      'index_state.latest_job_state',
    );
  });

  it.each(['chunking', 'embedding', 'storing'])(
    'T-DTO-7c latest_job_stage %s는 허용한다',
    async (stage) => {
      expect(await validateBody(withState({ latest_job_stage: stage }))).toEqual([]);
    },
  );

  it('T-DTO-8 toNotification은 알림 값 여섯 개로 옮긴다', () => {
    const body = withState({ searchable_version: '2' });
    body.sequence = 9;
    const notification = toNotification(plainToInstance(RagEventDto, body));
    expect(notification).toEqual({
      docId: 'doc-1',
      jobId: 'job-1',
      version: '3',
      jobState: 'running',
      searchableVersion: '2',
      sequence: 9,
    });
    expect(Object.keys(notification)).toHaveLength(6);
  });
});
