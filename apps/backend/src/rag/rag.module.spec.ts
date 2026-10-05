import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { RagClient, RagModule, RagRequestError } from './index';
import { createLogCapture } from '../../test/support/log-capture';
import { createTestCommonModule } from '../../test/support/test-common.module';
import { startFakeRagServer } from '../../test/support/fake-rag-server';
import type { FakeRagServer } from '../../test/support/fake-rag-server';

const DI_TOKEN = 'di-token-91c2';

// ★ nestjs-pino는 루트 로거를 파일당 하나만 만들어 처음 forRoot의 출력에 고정한다.
//   캡처 stream은 파일 맨 위에서 한 번만 만들고, 모듈은 beforeAll에서 한 번만 compile한다
const capture = createLogCapture();

let server: FakeRagServer;
let moduleRef: TestingModule;
let client: RagClient;

/** getIndexState의 정상 응답이다. */
const STATE_WIRE = {
  doc_id: 'doc-001',
  searchable_version: '2',
  latest_job_id: 'job-7f3a',
  latest_job_state: 'running',
  latest_job_stage: 'storing',
};

beforeAll(async () => {
  server = await startFakeRagServer();
  moduleRef = await Test.createTestingModule({
    imports: [
      createTestCommonModule(
        {
          RAG_SERVER_URL: server.baseUrl,
          RAG_SERVER_API_TOKEN: DI_TOKEN,
          RAG_TIMEOUT_MS: 2000,
          RAG_CAPTION_TIMEOUT_MS: 2000,
        },
        capture.stream,
      ),
      RagModule,
    ],
  }).compile();
  client = moduleRef.get(RagClient);
});

afterAll(async () => {
  await moduleRef.close();
  await server.close();
});

beforeEach(() => {
  capture.clear();
  server.reset();
});

describe('REQ-BE-10.1.1', () => {
  it('T-DI-1 RagModule이 RagClient를 내보내고 DI로 만들어진다', async () => {
    const exported = Reflect.getMetadata('exports', RagModule) as unknown[];
    expect(exported).toContain(RagClient);
    expect(client).toBeInstanceOf(RagClient);
    server.setHandler(() => ({ status: 200, json: STATE_WIRE }));
    await expect(client.getIndexState('doc-001')).resolves.toEqual({
      docId: 'doc-001',
      searchableVersion: '2',
      latestJobId: 'job-7f3a',
      latestJobState: 'running',
      latestJobStage: 'storing',
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe('/v1/documents/doc-001/index-state');
  });
});

describe('REQ-BE-10.1.4', () => {
  it('T-DI-2 설정의 토큰이 ConfigService로 들어간다', async () => {
    server.setHandler(() => ({ status: 200, json: STATE_WIRE }));
    await client.getIndexState('doc-001');
    expect(server.requests[0]?.headers['x-minerva-token']).toBe(DI_TOKEN);
  });
});

describe('REQ-BE-10.1.2', () => {
  it('T-DI-3 실제 PinoLogger로 rag.call_failed 한 줄을 남기고 민감 정보는 없다', async () => {
    server.setHandler(() => ({
      status: 409,
      json: { error: { code: 'DOCUMENT_NOT_SEARCHABLE', message: 'm' } },
    }));
    await expect(
      client.evaluate({ query: 'SECRET-DI-QUERY', docId: 'doc-001', answerSpan: 'SECRET-DI-SPAN' }),
    ).rejects.toBeInstanceOf(RagRequestError);
    const matched = capture
      .parsed()
      .filter(
        (line) =>
          line.msg === 'rag.call_failed' &&
          line.level === 40 &&
          line.operation === 'evaluate' &&
          line.status === 409 &&
          line.code === 'DOCUMENT_NOT_SEARCHABLE' &&
          typeof line.elapsedMs === 'number',
      );
    expect(matched).toHaveLength(1);
    const raw = capture.lines.join('\n');
    expect(raw).not.toContain('SECRET-DI-');
    expect(raw).not.toContain(DI_TOKEN);
  });
});
