import {
  DocumentLockedError,
  DocumentNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
  RagUnavailableError,
  UnsupportedFileError,
} from '../../common';
import type { ProcessingState } from '../../common';
import { RagRequestError } from '../../rag';
import type { RagDocumentChunk, RagJobStage } from '../../rag';
import {
  DATE_SENT,
  DOC_A,
  DOC_B,
  DOC_C,
  DOC_D,
  FAILMSG_SENT,
  FILE_SENT,
  HINT_SENT,
  IDX_SENT,
  LABEL_SENT,
  MD_SENT,
  NAME_SENT,
  buildDocumentsTestModule,
  createFakeClock,
  deferred,
  expectSafeKoreanMessage,
  docOf,
  docRecord,
  jobEvent,
  seed,
  seedDoc as seedDocIn,
  tableView,
  uid,
  ed,
  uploadFile,
  versionOf,
  versionRecord,
  waitUntil,
} from '../../../test/support/documents-fixtures';
import type {
  DocumentsHarness,
  DocumentsTestOptions,
} from '../../../test/support/documents-fixtures';
import { createLogCapture } from '../../../test/support/log-capture';
import {
  DOC_ID_PATTERN,
  DocumentNamesQueryDto,
  EditDocumentDto,
  ListDocumentsQueryDto,
  ReplacementCheckQueryDto,
} from '../interfaces/documents.dto';
import type { DocumentRecord } from '../interfaces/documents.types';

// ★ nestjs-pino 루트 로거는 파일당 하나다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

let h!: DocumentsHarness;
let alive = false;

/** 테스트 모듈을 새로 올린다. 이미 올라 있으면 먼저 닫는다. */
async function boot(opts: Partial<Omit<DocumentsTestOptions, 'stream'>> = {}): Promise<void> {
  if (alive) await h.close();
  capture.clear();
  h = await buildDocumentsTestModule({ stream: capture.stream, ...opts });
  alive = true;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  if (alive) {
    alive = false;
    await h.close();
  }
});

/** 목록 쿼리 객체를 만든다. */
function listQuery(over: Partial<ListDocumentsQueryDto> = {}): ListDocumentsQueryDto {
  return Object.assign(new ListDocumentsQueryDto(), over);
}

/** 편집 본문을 만든다. */
function editBody(over: Partial<EditDocumentDto>): EditDocumentDto {
  return Object.assign(new EditDocumentDto(), over);
}

/** 문서 한 개를 시드한다. */
function seedDoc(over: Partial<DocumentRecord> = {}): Promise<DocumentRecord> {
  return seedDocIn(h.db, over);
}

/** 한 문서에 대해 불린 기록 입력을 순서대로 요약한다. */
function recordsFor(docId: string) {
  return h.logs.record.mock.calls
    .map((call) => call[0])
    .filter((input) => input.docId === docId)
    .map((input) => ({
      kind: input.kind,
      name: input.name,
      editionLabel: input.editionLabel,
      outcome: input.outcome,
      detail: input.detail ?? null,
    }));
}

/** 처리 상태 기록의 (전, 후) 쌍을 모은다. */
function transitionsOf(docId: string): Array<[string | undefined, string | undefined]> {
  return h.logs
    .recordsOf('processing_state')
    .filter((input) => input.docId === docId)
    .map((input) => [input.detail?.fromState, input.detail?.toState]);
}

/** Db 호출 중 find 횟수다. */
function findCalls(): number {
  return h.db.calls.filter((call) => call.op === 'find').length;
}

describe('REQ-BE-1.1.1', () => {
  it('T-UP-1 MD 둘과 이미지 하나로 문서 둘을 만들고 응답 항목은 네 키뿐이다', async () => {
    const png = Buffer.from([1, 2, 3]);
    const result = await h.service.upload(
      [uploadFile('a.md', '# A'), uploadFile('b.md', '# B'), uploadFile('p.png', png, 'image/png')],
      [
        { file_name: 'a.md', name: 'A문서' },
        { file_name: 'b.md', name: 'B문서' },
      ],
    );
    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((doc) => doc.file_name)).toEqual(['a.md', 'b.md']);
    for (const item of result.documents) {
      expect(Object.keys(item).sort()).toEqual(['doc_id', 'file_name', 'name', 'unmatched_images']);
      expect(item.doc_id).toMatch(DOC_ID_PATTERN);
    }
    expect(h.db.dump('documents')).toHaveLength(2);
    const versions = h.db.dump('document_versions');
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.version === '1' && v.origin === 'upload')).toBe(true);
    expect(h.assets.prepareVersion).toHaveBeenCalledTimes(2);
    const first = h.assets.prepareVersion.mock.calls.find((call) => call[2] === '# A');
    expect(first?.[0]).toBe(result.documents[0].doc_id);
    expect(first?.[1]).toBe('1');
    expect(first?.[3]).toEqual([{ fileName: 'p.png', contentType: 'image/png', data: png }]);
    await h.drain();
  });
});

describe('REQ-BE-1.1.5', () => {
  it('T-UP-2 판 정보가 있으면 저장하고 없으면 null이다', async () => {
    const result = await h.service.upload(
      [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')],
      [
        { file_name: 'a.md', name: 'A', edition: { label: ' v1 ', edition_date: '2026-02-03' } },
        { file_name: 'b.md', name: 'B' },
      ],
    );
    expect(docOf(h.db, result.documents[0].doc_id).edition).toEqual({
      label: 'v1',
      editionDate: '2026-02-03',
    });
    expect(docOf(h.db, result.documents[1].doc_id).edition).toBeNull();
    await h.drain();
  });
});

describe('REQ-BE-1.1.7', () => {
  it('T-UP-3 BOM·CRLF MD는 저장한 원본을 UTF-8로 바꾸면 입력 바이트와 같다', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('제목\r\n본문\r\n', 'utf8'),
    ]);
    const result = await h.service.upload(
      [uploadFile('a.md', bytes)],
      [{ file_name: 'a.md', name: 'A' }],
    );
    const stored = versionOf(h.db, result.documents[0].doc_id, '1');
    expect(Buffer.from(stored?.originalMarkdown ?? '', 'utf8').equals(bytes)).toBe(true);
    await h.drain();
  });
});

describe('REQ-BE-1.1.8', () => {
  it('T-UP-4 업로드 직후 문서는 업로드됨·검색 안 됨이고 요약·캡션은 아직 시작하지 않았다', async () => {
    const result = await h.service.upload(
      [uploadFile('a.md', 'a')],
      [{ file_name: 'a.md', name: 'A' }],
    );
    const doc = docOf(h.db, result.documents[0].doc_id);
    expect(doc.processingState).toBe('uploaded');
    expect(doc.searchState).toBe('not_searchable');
    expect(doc.searchableVersion).toBeNull();
    expect(doc.deleted).toBe(false);
    expect(doc.purged).toBe(false);
    expect(doc.pendingRag).toEqual({ deleteChunks: false, metadata: false });
    expect(h.assets.generateHints).not.toHaveBeenCalled();
    await h.drain();
  });
});

describe('REQ-BE-1.1.9', () => {
  it('T-UP-5 응답 뒤 요약·캡션을 만들고 색인을 요청하며 업로드 기록이 문서마다 하나다', async () => {
    const result = await h.service.upload(
      [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')],
      [
        { file_name: 'a.md', name: 'A', edition: { label: 'v1', edition_date: '2026-01-01' } },
        { file_name: 'b.md', name: 'B' },
      ],
    );
    await h.drain();
    const [a, b] = result.documents;
    const uploads = h.logs.recordsOf('upload');
    expect(uploads).toHaveLength(2);
    expect(uploads.find((u) => u.docId === a.doc_id)).toMatchObject({
      outcome: 'success',
      name: 'A',
      editionLabel: 'v1',
    });
    expect(uploads.find((u) => u.docId === b.doc_id)).toMatchObject({
      outcome: 'success',
      name: 'B',
      editionLabel: null,
    });
    for (const item of [a, b]) {
      const hintIndex = h.assets.generateHints.mock.calls.findIndex((c) => c[0] === item.doc_id);
      expect(hintIndex).toBeGreaterThanOrEqual(0);
      const call = h.assets.generateHints.mock.calls[hintIndex];
      expect(call[1]).toBe('1');
      expect(call[2].name).toBe(item.name);
      expect(typeof call[2].shouldContinue).toBe('function');
      const indexIndex = h.indexing.requestIndex.mock.calls.findIndex(
        (c) => c[0].docId === item.doc_id,
      );
      expect(indexIndex).toBeGreaterThanOrEqual(0);
      expect(h.assets.generateHints.mock.invocationCallOrder[hintIndex]).toBeLessThan(
        h.indexing.requestIndex.mock.invocationCallOrder[indexIndex],
      );
    }
    expect(h.assets.generateHints.mock.calls.find((c) => c[0] === a.doc_id)?.[2].editionLabel).toBe(
      'v1',
    );
  });
});

describe('REQ-BE-1.2.4', () => {
  it('T-UP-6 문서마다 세 시각이 같고 뒤 문서가 더 늦다', async () => {
    await boot({ clock: createFakeClock() });
    const result = await h.service.upload(
      [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')],
      [
        { file_name: 'a.md', name: 'A' },
        { file_name: 'b.md', name: 'B' },
      ],
    );
    const [a, b] = result.documents.map((item) => docOf(h.db, item.doc_id));
    for (const doc of [a, b]) {
      expect(doc.uploadedAt.getTime()).toBe(doc.editionEnteredAt.getTime());
      expect(doc.uploadedAt.getTime()).toBe(doc.updatedAt.getTime());
    }
    expect(b.uploadedAt.getTime()).toBeGreaterThan(a.uploadedAt.getTime());
    await h.drain();
  });
});

describe('REQ-BE-1.1.2', () => {
  it('T-UP-7 검증에 실패하면 아무것도 저장하지 않고 기록도 남기지 않는다', async () => {
    const meta = (names: string[]) => names.map((file_name) => ({ file_name, name: '이름' }));
    const cases: Array<() => Promise<unknown>> = [
      () => h.service.upload([uploadFile('a.md', 'a'), uploadFile('x.pdf', 'x')], meta(['a.md'])),
      () => h.service.upload([uploadFile('a.md', 'a')], meta(['other.md'])),
      () => h.service.upload([uploadFile('big.md', Buffer.alloc(1001, 97))], meta(['big.md'])),
    ];
    for (const run of cases) await expect(run()).rejects.toThrow();
    expect(h.db.dump('documents')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(0);
    expect(h.assets.prepareVersion).not.toHaveBeenCalled();
    expect(h.logs.record).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.1.4', () => {
  it('T-UP-8 짝 없는 이미지 참조는 응답에 그대로 담긴다', async () => {
    h.assets.prepareVersion.mockResolvedValueOnce({
      indexingMarkdown: IDX_SENT,
      unmatchedImages: ['./x.png'],
      assetCount: 0,
    });
    const result = await h.service.upload(
      [uploadFile('a.md', '![x](./x.png)')],
      [{ file_name: 'a.md', name: 'A' }],
    );
    expect(result.documents[0].unmatched_images).toEqual(['./x.png']);
    await h.drain();
  });
});

describe('REQ-BE-1.1.3', () => {
  it('T-UP-9 같은 이름 이미지 오류가 나면 그 오류를 던지고 문서·버전을 남기지 않는다', async () => {
    h.assets.prepareVersion.mockRejectedValueOnce(new InvalidRequestError('같은 이름 이미지'));
    await expect(
      h.service.upload([uploadFile('a.md', 'a')], [{ file_name: 'a.md', name: 'A' }]),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(h.db.dump('documents')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(0);
  });
});

describe('REQ-BE-1.3.6', () => {
  const stage = (id: string): Map<string, RagJobStage> => new Map([[id, 'embedding']]);

  it('T-LIST-1 색인 중인 문서만 모아 한 번 단계를 묻고 단계가 있는 문서만 값을 채운다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'indexing' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'indexing' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'completed' }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C }),
      ],
    );
    h.indexing.getStages.mockResolvedValueOnce(stage(DOC_A));
    const page = await h.service.list(listQuery());
    expect(h.indexing.getStages).toHaveBeenCalledTimes(1);
    expect(new Set(h.indexing.getStages.mock.calls[0][0])).toEqual(new Set([DOC_A, DOC_B]));
    const byId = new Map(page.items.map((item) => [item.doc_id, item]));
    expect(byId.get(DOC_A)?.stage).toBe('embedding');
    expect(byId.get(DOC_B)?.stage).toBeNull();
    expect(byId.get(DOC_C)?.stage).toBeNull();

    // 단계를 하나도 못 받아도 결과는 정상이다
    h.indexing.getStages.mockResolvedValueOnce(new Map());
    const none = await h.service.list(listQuery());
    expect(none.items.every((item) => item.stage === null)).toBe(true);
    expect(none.total).toBe(3);
  });

  it('T-LIST-1 색인 중인 문서가 없으면 단계를 묻지 않는다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord({ docId: DOC_A })]);
    await h.service.list(listQuery());
    expect(h.indexing.getStages).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.3.8', () => {
  it('T-LIST-2 실패 문서의 failure_message는 마지막 버전의 사유다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, processingState: 'failed', latestVersion: '2' })],
      [
        versionRecord({
          docId: DOC_A,
          version: '1',
          failure: { code: 'OLD', message: '옛 사유', headingPath: null, placeholderId: null },
        }),
        versionRecord({
          docId: DOC_A,
          version: '2',
          failure: {
            code: 'PARSE_FAILED',
            message: FAILMSG_SENT,
            headingPath: null,
            placeholderId: null,
          },
        }),
      ],
    );
    const page = await h.service.list(listQuery());
    expect(page.items[0].failure_message).toBe(FAILMSG_SENT);
  });
});

describe('REQ-BE-1.3.5', () => {
  it('T-LIST-3 판 칸은 같은 이름의 검색 가능 판과 자기 판을 날짜 내림차순으로 모은다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'N', edition: ed('v2025', '2025-01-01') }),
        docRecord({ docId: DOC_B, name: 'N', edition: ed('v2024', '2024-01-01') }),
        docRecord({
          docId: DOC_C,
          name: 'N',
          edition: ed('v2022', '2022-01-01'),
          searchState: 'not_searchable',
          searchableVersion: null,
        }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B }),
        versionRecord({ docId: DOC_C }),
      ],
    );
    const page = await h.service.list(listQuery());
    const old = page.items.find((item) => item.doc_id === DOC_C);
    expect(old?.sibling_editions).toEqual([
      { label: 'v2025', edition_date: '2025-01-01' },
      { label: 'v2024', edition_date: '2024-01-01' },
      { label: 'v2022', edition_date: '2022-01-01' },
    ]);
  });
});

describe('REQ-BE-1.2.1', () => {
  it('T-LIST-4 이름 필터는 그 이름의 문서만 남긴다', async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: '같은' }),
      docRecord({ docId: uid(2), name: '같은' }),
      docRecord({ docId: uid(3), name: '같은' }),
      docRecord({ docId: uid(4), name: '다른' }),
    ]);
    const page = await h.service.list(listQuery({ name: '같은' }));
    expect(page.items.map((item) => item.doc_id).sort()).toEqual([uid(1), uid(2), uid(3)]);
    expect(page.total).toBe(3);
  });
});

describe('REQ-BE-1.3.3', () => {
  it('T-LIST-5 최신판만 보기는 최신 검색 가능 판과 판 없는 문서를 남기고 다른 필터와 AND다', async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: 'N', edition: ed('v2022', '2022-01-01') }),
      docRecord({ docId: uid(2), name: 'N', edition: ed('v2025', '2025-01-01') }),
      docRecord({
        docId: uid(3),
        name: 'N',
        edition: ed('v2026', '2026-01-01'),
        searchState: 'not_searchable',
        searchableVersion: null,
      }),
      docRecord({ docId: uid(4), name: 'N', edition: null }),
    ]);
    const latest = await h.service.list(listQuery({ latest_only: true }));
    expect(latest.items.map((item) => item.doc_id).sort()).toEqual([uid(2), uid(4)]);
    const combined = await h.service.list(
      listQuery({ latest_only: true, search_state: ['searchable'], has_edition: true }),
    );
    expect(combined.items.map((item) => item.doc_id)).toEqual([uid(2)]);
  });
});

describe('REQ-BE-1.8.2', () => {
  it('T-LIST-6 삭제된 문서는 목록·이름·같은 판 확인·보이는 문서·상세 어디에도 없다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, name: '지울문서', edition: ed('v1') })],
      [versionRecord({ docId: DOC_A })],
    );
    await h.service.remove(DOC_A);
    await h.drain();
    expect((await h.service.list(listQuery())).items).toHaveLength(0);
    expect((await h.service.names(Object.assign(new DocumentNamesQueryDto(), {}))).items).toEqual(
      [],
    );
    const check = await h.service.replacementCheck(
      Object.assign(new ReplacementCheckQueryDto(), { name: '지울문서', edition_label: 'v1' }),
    );
    expect(check.replaces).toEqual([]);
    expect((await h.service.visibleDocIds([DOC_A])).size).toBe(0);
    await expect(h.service.getDetail(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});

describe('REQ-BE-1.3.7', () => {
  const names = (over: Partial<DocumentNamesQueryDto> = {}): DocumentNamesQueryDto =>
    Object.assign(new DocumentNamesQueryDto(), over);

  beforeEach(async () => {
    await seed(h.db, [
      docRecord({ docId: uid(1), name: '나' }),
      docRecord({ docId: uid(2), name: '가' }),
      docRecord({ docId: uid(3), name: '가나' }),
      docRecord({ docId: uid(4), name: '가' }),
      docRecord({ docId: uid(5), name: '다', deleted: true }),
      docRecord({ docId: uid(6), name: '라', searchState: 'replaced' }),
    ]);
  });

  it('T-LIST-7 이름은 중복 없이 코드 포인트 순이며 삭제된 문서만의 이름은 뺀다', async () => {
    expect((await h.service.names(names())).items).toEqual(['가', '가나', '나', '라']);
  });

  it('T-LIST-7 접두사와 limit을 적용한다', async () => {
    expect((await h.service.names(names({ prefix: '가' }))).items).toEqual(['가', '가나']);
    expect((await h.service.names(names({ limit: 2 }))).items).toHaveLength(2);
  });
});

describe('REQ-BE-1.2.3', () => {
  it('T-RC-1 같은 판 확인은 이름·판 표기가 같은 보이는 문서만 오래된 순으로 준다', async () => {
    const t = (n: number): Date => new Date(Date.UTC(2026, 9, n));
    await seed(h.db, [
      docRecord({ docId: uid(2), name: 'N', edition: ed('v1'), uploadedAt: t(2) }),
      docRecord({ docId: uid(1), name: 'N', edition: ed('v1'), uploadedAt: t(1) }),
      docRecord({ docId: uid(3), name: 'N', edition: ed('v1'), searchState: 'replaced' }),
      docRecord({ docId: uid(4), name: 'N', edition: ed('v1'), deleted: true }),
      docRecord({ docId: uid(5), name: 'N', edition: ed('v2') }),
      docRecord({ docId: uid(6), name: 'N', edition: null }),
      docRecord({ docId: uid(7), name: 'N', edition: null }),
    ]);
    const query = (over: Record<string, unknown>) =>
      Object.assign(new ReplacementCheckQueryDto(), over);
    const result = await h.service.replacementCheck(query({ name: 'N', edition_label: 'v1' }));
    expect(result.replaces.map((item) => item.doc_id)).toEqual([uid(1), uid(2)]);
    expect(Object.keys(result.replaces[0]).sort()).toEqual(['doc_id', 'edition', 'name']);

    const excluded = await h.service.replacementCheck(
      query({ name: 'N', edition_label: 'v1', exclude_doc_id: uid(1) }),
    );
    expect(excluded.replaces.map((item) => item.doc_id)).toEqual([uid(2)]);

    const noEdition = await h.service.replacementCheck(query({ name: 'N' }));
    expect(noEdition.replaces.map((item) => item.doc_id).sort()).toEqual([uid(6), uid(7)]);
  });
});

describe('REQ-BE-1.4.1', () => {
  it('T-GET-1 상세는 이름·판·마지막 버전 파일 이름·시각·상태를 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, name: '문서', edition: ed('v1'), latestVersion: '2' })],
      [
        versionRecord({ docId: DOC_A, version: '1', fileName: 'old.md' }),
        versionRecord({ docId: DOC_A, version: '2', fileName: 'new.md' }),
      ],
    );
    const detail = await h.service.getDetail(DOC_A);
    expect(detail.doc_id).toBe(DOC_A);
    expect(detail.name).toBe('문서');
    expect(detail.edition).toEqual({ label: 'v1', edition_date: '2025-01-01' });
    expect(detail.file_name).toBe('new.md');
    expect(detail.search_state).toBe('searchable');
    expect(detail.processing_state).toBe('completed');
    expect(detail.uploaded_at).toBe('2026-10-01T00:00:00Z');
    expect(detail.updated_at).toBe('2026-10-01T00:00:00Z');
  });

  it('T-GET-1 삭제된 문서와 없는 ID는 DocumentNotFoundError다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A, deleted: true })], [versionRecord()]);
    await expect(h.service.getDetail(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(h.service.getDetail(DOC_B)).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});

describe('REQ-BE-1.4.2', () => {
  it('T-GET-2 색인 중이면 단계, 완료면 결과, 실패면 마지막 버전의 사유를 준다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, name: 'a', processingState: 'indexing' }),
        docRecord({ docId: DOC_B, name: 'b', processingState: 'completed' }),
        docRecord({ docId: DOC_C, name: 'c', processingState: 'failed', latestVersion: '2' }),
      ],
      [
        versionRecord({ docId: DOC_A }),
        versionRecord({ docId: DOC_B, result: { chunkCount: 9, fallbackUsed: true } }),
        versionRecord({ docId: DOC_C, version: '1' }),
        versionRecord({
          docId: DOC_C,
          version: '2',
          result: null,
          failure: { code: 'X', message: '실패', headingPath: ['H'], placeholderId: 't1' },
        }),
      ],
    );
    h.indexing.getStages.mockResolvedValueOnce(
      new Map<string, RagJobStage>([[DOC_A, 'embedding']]),
    );
    expect((await h.service.getDetail(DOC_A)).stage).toBe('embedding');
    expect((await h.service.getDetail(DOC_B)).result).toEqual({
      chunk_count: 9,
      fallback_used: true,
    });
    expect((await h.service.getDetail(DOC_C)).failure).toEqual({
      code: 'X',
      message: '실패',
      heading_path: ['H'],
      placeholder_id: 't1',
    });
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-GET-3 표·이미지 목록은 마지막 버전의 assets 조회 값을 순서대로 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '3' })],
      [1, 2, 3].map((v) => versionRecord({ docId: DOC_A, version: String(v) })),
    );
    h.assets.listViews.mockResolvedValue([tableView('t1', '가'), tableView('t2', '나')]);
    const detail = await h.service.getDetail(DOC_A);
    expect(h.assets.listViews).toHaveBeenCalledWith(DOC_A, '3');
    expect(detail.assets.map((asset) => asset.placeholder_id)).toEqual(['t1', 't2']);
  });
});

describe('REQ-BE-1.4.3', () => {
  it('T-GET-4 원본은 마지막 버전의 원본 MD와 이미지 주소를 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '2' })],
      [
        versionRecord({ docId: DOC_A, version: '1', originalMarkdown: '옛' }),
        versionRecord({ docId: DOC_A, version: '2', originalMarkdown: '새' }),
      ],
    );
    h.assets.imageUrls.mockResolvedValue({ './a.png': '/v1/x', 'miss.png': null });
    const original = await h.service.getOriginal(DOC_A);
    expect(original.markdown).toBe('새');
    expect(original.images).toEqual({ './a.png': '/v1/x', 'miss.png': null });
    expect(h.assets.imageUrls).toHaveBeenCalledWith(DOC_A, '2');
  });
});

describe('REQ-BE-1.4.5', () => {
  /** RAG 청크 하나를 만든다. */
  function chunk(order: number): RagDocumentChunk {
    return {
      chunkId: `c${order}`,
      order,
      kind: 'text',
      headingPath: ['H'],
      title: null,
      summary: null,
      text: `본문${order}`,
      placeholderIds: [],
      splitIndex: null,
      splitTotal: null,
    };
  }

  it('T-GET-5 검색 가능이 아닌 문서는 빈 목록이고 RAG Server를 부르지 않는다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, searchState: 'not_searchable', searchableVersion: null })],
      [versionRecord()],
    );
    expect(await h.service.getChunks(DOC_A)).toEqual({ items: [] });
    expect(h.rag.getDocumentChunks).not.toHaveBeenCalled();
  });

  it('T-GET-6 RAG가 알려 준 버전으로 복원하고 order 오름차순으로 준다', async () => {
    await seed(
      h.db,
      [docRecord({ docId: DOC_A, latestVersion: '3', processingState: 'indexing' })],
      [1, 2, 3].map((v) => versionRecord({ docId: DOC_A, version: String(v) })),
    );
    h.rag.getDocumentChunks.mockResolvedValue({ version: '2', items: [chunk(2), chunk(1)] });
    const result = await h.service.getChunks(DOC_A);
    expect(result.items.map((item) => item.order)).toEqual([1, 2]);
    expect(result.items[0].markdown).toBe('R[2]본문1');
    expect(h.assets.restore).toHaveBeenCalledWith(DOC_A, '2', '본문1');
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'heading_path',
      'kind',
      'markdown',
      'order',
      'split_index',
      'split_total',
      'summary',
      'title',
    ]);
  });

  it('T-GET-7 RAG Server 호출이 실패하면 RagUnavailableError다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord()]);
    h.rag.getDocumentChunks.mockRejectedValueOnce(new RagUnavailableError());
    await expect(h.service.getChunks(DOC_A)).rejects.toBeInstanceOf(RagUnavailableError);
    h.rag.getDocumentChunks.mockRejectedValueOnce(new RagRequestError(500, 'X'));
    await expect(h.service.getChunks(DOC_A)).rejects.toBeInstanceOf(RagUnavailableError);
  });

  it('T-GET-8 RAG가 검색되는 버전이 없다고 하면 빈 목록이다', async () => {
    await seed(h.db, [docRecord({ docId: DOC_A })], [versionRecord()]);
    h.rag.getDocumentChunks.mockResolvedValue({ version: null, items: [] });
    expect(await h.service.getChunks(DOC_A)).toEqual({ items: [] });
  });
});

describe('REQ-BE-1.5.1', () => {
  it('T-EDIT-1 이름만 고치면 새 버전·재색인 없이 이름과 updatedAt만 바뀌고 기록이 남는다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름', edition: ed('v1') });
    const result = await h.service.edit(DOC_A, editBody({ name: '새이름' }));
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.name).toBe('새이름');
    expect(doc.edition).toEqual(ed('v1'));
    expect(doc.latestVersion).toBe('1');
    expect(doc.updatedAt.getTime()).toBeGreaterThan(new Date('2026-10-01T00:00:00Z').getTime());
    expect(h.db.dump('document_versions')).toHaveLength(1);
    expect(h.assets.inheritVersion).not.toHaveBeenCalled();
    expect(h.indexing.requestIndex).not.toHaveBeenCalled();
    expect(h.logs.recordsOf('edit')).toHaveLength(1);
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['name']);
    expect(h.logs.recordsOf('edit')[0].name).toBe('새이름');
    expect(result.name).toBe('새이름');
  });

  it('T-EDIT-7 같은 이름·빈 본문·같은 문장은 아무것도 바꾸지 않는다', async () => {
    await seedDoc({ docId: DOC_A, name: '이름' });
    h.assets.listViews.mockResolvedValue([tableView('t1', '지금 문장')]);
    const before = docOf(h.db, DOC_A);
    for (const body of [
      editBody({ name: '이름' }),
      editBody({}),
      editBody({ assets: [{ placeholder_id: 't1', text: '지금 문장' }] }),
    ]) {
      const result = await h.service.edit(DOC_A, body);
      expect(result.name).toBe('이름');
    }
    await h.drain();
    expect(docOf(h.db, DOC_A).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(h.logs.recordsOf('edit')).toHaveLength(0);
    expect(h.db.dump('document_versions')).toHaveLength(1);
  });

  it('T-EDIT-8 모르는 placeholder_id는 InvalidRequestError이고 아무것도 바뀌지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.listViews.mockResolvedValue([tableView('t1', '문장')]);
    const error = await h.service
      .edit(DOC_A, editBody({ assets: [{ placeholder_id: 't9', text: HINT_SENT }] }))
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as Error).message).toContain('t9');
    expect(docOf(h.db, DOC_A).latestVersion).toBe('1');
    expect(docOf(h.db, DOC_A).processingState).toBe('completed');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
  });

  it('T-EDIT-14 판을 null로 보내면 판 정보가 지워지고 기록은 edition이다', async () => {
    await seedDoc({ docId: DOC_A, edition: ed('v1') });
    await h.service.edit(DOC_A, editBody({ edition: null }));
    expect(docOf(h.db, DOC_A).edition).toBeNull();
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['edition']);
  });
});

describe('REQ-BE-1.5.2', () => {
  it('T-EDIT-2 검색 가능 문서의 이름 변경은 표시를 쓰고 백그라운드로 RAG에 보내 지운다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름' });
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(true);
    await h.drain();
    expect(h.indexing.updateMetadata).toHaveBeenCalledTimes(1);
    expect(h.indexing.updateMetadata).toHaveBeenCalledWith(DOC_A, '새 이름', null);
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);
  });

  it('T-EDIT-2 RAG 요청이 실패하면 표시가 남는다', async () => {
    await seedDoc({ docId: DOC_A, name: '옛이름' });
    h.indexing.updateMetadata.mockResolvedValue(false);
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    await h.drain();
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(true);
  });

  it('T-EDIT-3 검색되는 버전이 없는 문서는 RAG에 보내지 않고 표시도 켜지 않는다', async () => {
    await seedDoc({
      docId: DOC_A,
      searchState: 'not_searchable',
      processingState: 'failed',
      searchableVersion: null,
    });
    await h.service.edit(DOC_A, editBody({ name: '새 이름' }));
    await h.drain();
    expect(docOf(h.db, DOC_A).pendingRag.metadata).toBe(false);
    expect(h.indexing.updateMetadata).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.2.4', () => {
  it('T-EDIT-4 이름·판 표기·판 지우기는 판에 들어온 시각을 바꾸고 판 날짜만 바꾸면 그대로다', async () => {
    await boot({ clock: createFakeClock('2026-10-04T00:00:00Z') });
    const entered = new Date('2026-10-01T00:00:00Z');
    await seedDoc({ docId: DOC_A, name: 'A', edition: ed('v1'), editionEnteredAt: entered });
    await seedDoc({ docId: DOC_B, name: 'B', edition: ed('v1'), editionEnteredAt: entered });
    await seedDoc({ docId: DOC_C, name: 'C', edition: ed('v1'), editionEnteredAt: entered });
    await seedDoc({ docId: DOC_D, name: 'D', edition: ed('v1'), editionEnteredAt: entered });

    await h.service.edit(DOC_A, editBody({ name: 'A2' }));
    await h.service.edit(DOC_B, editBody({ edition: { label: 'v2', edition_date: '2025-01-01' } }));
    await h.service.edit(DOC_C, editBody({ edition: { label: 'v1', edition_date: '2030-01-01' } }));
    await h.service.edit(DOC_D, editBody({ edition: null }));
    await h.drain();

    for (const id of [DOC_A, DOC_B, DOC_D]) {
      const doc = docOf(h.db, id);
      expect(doc.editionEnteredAt.getTime()).toBe(doc.updatedAt.getTime());
      expect(doc.editionEnteredAt.getTime()).toBeGreaterThan(entered.getTime());
    }
    const dateOnly = docOf(h.db, DOC_C);
    expect(dateOnly.editionEnteredAt.getTime()).toBe(entered.getTime());
    expect(dateOnly.updatedAt.getTime()).toBeGreaterThan(entered.getTime());
    expect(dateOnly.edition).toEqual(ed('v1', '2030-01-01'));
  });
});

describe('REQ-BE-1.5.4', () => {
  /** 요약·캡션 편집용 시드다. t1의 지금 문장은 '기존'이다. */
  async function seedWithHints(over: Partial<DocumentRecord> = {}): Promise<void> {
    await seedDoc({ docId: DOC_A, name: '문서', ...over });
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: HINT_SENT }]);
  }

  it('T-EDIT-5 요약·캡션 편집은 같은 내용의 새 버전을 만들어 색인 대기로 두고 재색인한다', async () => {
    await seedWithHints();
    const result = await h.service.edit(
      DOC_A,
      editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }),
    );
    expect(result.processing_state).toBe('queued');
    const v1 = versionOf(h.db, DOC_A, '1');
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.origin).toBe('hints');
    expect(v2?.originalMarkdown).toBe(v1?.originalMarkdown);
    expect(v2?.indexingMarkdown).toBe(v1?.indexingMarkdown);
    expect(v2?.fileName).toBe(v1?.fileName);
    const call = h.assets.inheritVersion.mock.calls[0];
    expect(call.slice(0, 3)).toEqual([DOC_A, '1', '2']);
    expect(call[3]).toEqual(new Map([['t1', HINT_SENT]]));

    await h.drain();
    const request = h.indexing.requestIndex.mock.calls[0][0];
    expect(request.version).toBe('2');
    expect(request.hints).toEqual([{ placeholderId: 't1', text: HINT_SENT }]);
    expect(request.force).toBe(false);
    expect(h.assets.hintsFor).toHaveBeenCalledWith(DOC_A, '2');
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['hints']);
    expect(transitionsOf(DOC_A)).toContainEqual(['completed', 'queued']);
  });

  it('T-EDIT-6 이름과 요약·캡션을 함께 고치면 새 이름으로 색인하고 RAG 이름도 바꾼다', async () => {
    await seedWithHints();
    await h.service.edit(
      DOC_A,
      editBody({ name: '새 이름', assets: [{ placeholder_id: 't1', text: HINT_SENT }] }),
    );
    await h.drain();
    expect(h.indexing.requestIndex.mock.calls[0][0].name).toBe('새 이름');
    expect(h.indexing.updateMetadata).toHaveBeenCalled();
    expect(h.logs.recordsOf('edit')[0].detail?.changedFields).toEqual(['name', 'hints']);
  });

  it('T-EDIT-13 새 버전 만들기가 실패하면 읽은 값으로 되돌리고 기록을 남기지 않는다', async () => {
    await seedWithHints({ name: '옛이름' });
    const before = docOf(h.db, DOC_A);
    h.assets.inheritVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(
      h.service.edit(
        DOC_A,
        editBody({ name: '새 이름', assets: [{ placeholder_id: 't1', text: HINT_SENT }] }),
      ),
    ).rejects.toThrow('boom');
    const after = docOf(h.db, DOC_A);
    expect(after.latestVersion).toBe('1');
    expect(after.processingState).toBe('completed');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.name).toBe('옛이름');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
    expect(h.logs.record).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-1.5.5', () => {
  /**
   * 요청들이 모두 문서를 읽은 뒤에야 다음으로 가게 해, 같은 값을 읽은 요청끼리의 경합을 결정적으로 만든다.
   * ★ 읽기가 몰리지 않는 구현이어도 멈추지 않도록 0.5초 뒤에는 풀어 준다.
   */
  function readTogether(parties = 2): void {
    const original = h.repo.findDocument.bind(h.repo);
    const gate = deferred();
    let arrived = 0;
    const timer = setTimeout(() => gate.resolve(), 500);
    timer.unref();
    jest.spyOn(h.repo, 'findDocument').mockImplementation(async (docId) => {
      const row = await original(docId);
      arrived += 1;
      if (arrived >= parties) {
        clearTimeout(timer);
        gate.resolve();
      }
      await gate.promise;
      return row;
    });
  }

  /** 첫 번째 문서 읽기 직후, 선점 전에 다른 요청이 문서를 바꾼 것처럼 Db에 직접 쓴다. */
  function changeAfterFirstRead(set: Record<string, unknown>): void {
    const original = h.repo.findDocument.bind(h.repo);
    let done = false;
    jest.spyOn(h.repo, 'findDocument').mockImplementation(async (docId) => {
      const row = await original(docId);
      if (!done) {
        done = true;
        await h.db.collection('documents').updateOne({ docId }, { $set: set });
      }
      return row;
    });
  }

  /** 정확히 하나만 성공하고 나머지는 잠김 오류인지 본다. */
  function expectOneWinner(results: PromiseSettledResult<unknown>[]): void {
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DocumentLockedError);
  }

  const versionCount = (docId: string): number =>
    h.db.dump('document_versions').filter((v) => v.docId === docId).length;

  it('T-EDIT-15 같은 문서를 동시에 재색인하면 하나만 새 버전을 만든다', async () => {
    await seedDoc({ docId: DOC_A });
    readTogether();
    const results = await Promise.allSettled([h.service.reindex(DOC_A), h.service.reindex(DOC_A)]);
    expectOneWinner(results);
    expect(h.assets.inheritVersion).toHaveBeenCalledTimes(1);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionCount(DOC_A)).toBe(2);
    await h.drain();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-EDIT-16 재색인과 요약·캡션 편집이 동시에 오면 하나만 새 버전을 만든다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서' });
    h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
    h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: 'x' }]);
    readTogether();
    const results = await Promise.allSettled([
      h.service.reindex(DOC_A),
      h.service.edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] })),
    ]);
    expectOneWinner(results);
    expect(h.assets.inheritVersion).toHaveBeenCalledTimes(1);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('2');
    expect(versionCount(DOC_A)).toBe(2);
    await h.drain();
    expect(h.indexing.requestIndex).toHaveBeenCalledTimes(1);
  });

  it('T-EDIT-17 내용 다시 올리기와 이름 편집이 동시에 오면 하나만 반영된다', async () => {
    await seedDoc({ docId: DOC_A, name: '원래' });
    readTogether();
    const results = await Promise.allSettled([
      h.service.uploadContents(DOC_A, [md]),
      h.service.edit(DOC_A, editBody({ name: '새이름' })),
    ]);
    expectOneWinner(results);
    const doc = docOf(h.db, DOC_A);
    const uploadWon = results[0].status === 'fulfilled';
    // ★ 이긴 쪽의 결과만 남고 진 쪽의 흔적은 없어야 한다
    expect(doc.latestVersion).toBe(uploadWon ? '2' : '1');
    expect(doc.name).toBe(uploadWon ? '원래' : '새이름');
    expect(h.assets.prepareVersion).toHaveBeenCalledTimes(uploadWon ? 1 : 0);
    expect(versionCount(DOC_A)).toBe(uploadWon ? 2 : 1);
    await h.drain();
  });

  const ops: Array<[string, () => Promise<unknown>]> = [
    ['재색인', () => h.service.reindex(DOC_A)],
    ['내용 다시 올리기', () => h.service.uploadContents(DOC_A, [md])],
    [
      '요약·캡션 편집',
      () =>
        h.service.edit(DOC_A, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] })),
    ],
  ];

  it.each(ops)(
    'T-EDIT-18 %s: 읽은 뒤 선점 전에 삭제되면 없는 문서 오류이고 새 버전을 남기지 않는다',
    async (_label, run) => {
      await seedDoc({ docId: DOC_A });
      h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
      changeAfterFirstRead({ deleted: true });
      await expect(run()).rejects.toBeInstanceOf(DocumentNotFoundError);
      expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
      expect(h.assets.inheritVersion).not.toHaveBeenCalled();
      expect(h.assets.prepareVersion).not.toHaveBeenCalled();
    },
  );

  it.each(ops)(
    'T-EDIT-19 %s: 읽은 뒤 선점 전에 처리 중이 되면 잠김 오류이고 새 버전을 남기지 않는다',
    async (_label, run) => {
      await seedDoc({ docId: DOC_A });
      h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
      changeAfterFirstRead({ processingState: 'indexing' });
      await expect(run()).rejects.toBeInstanceOf(DocumentLockedError);
      expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
      expect(h.assets.inheritVersion).not.toHaveBeenCalled();
      expect(h.assets.prepareVersion).not.toHaveBeenCalled();
      expect(docOf(h.db, DOC_A).processingState).toBe('indexing');
    },
  );

  it('T-EDIT-9 같은 문서에 동시에 편집하면 하나만 반영되고 나머지는 잠김 오류다', async () => {
    await seedDoc({ docId: DOC_A, name: '원래' });
    readTogether();
    const results = await Promise.allSettled([
      h.service.edit(DOC_A, editBody({ name: '이름1' })),
      h.service.edit(DOC_A, editBody({ name: '이름2' })),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DocumentLockedError);
    expectSafeKoreanMessage((rejected[0].reason as Error).message);
    expect(h.logs.recordsOf('edit')).toHaveLength(1);
    await h.drain();
  });

  it('T-EDIT-10 처리 중인 문서는 편집·재색인·내용 다시 올리기가 모두 잠김 오류다', async () => {
    const states: ProcessingState[] = ['uploaded', 'captioning', 'queued', 'indexing'];
    for (const state of states) {
      await boot();
      await seedDoc({ docId: DOC_A, processingState: state });
      const docBefore = h.db.dump('documents');
      const versionsBefore = h.db.dump('document_versions');
      await expect(h.service.edit(DOC_A, editBody({ name: '새이름' }))).rejects.toBeInstanceOf(
        DocumentLockedError,
      );
      await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
      await expect(
        h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')]),
      ).rejects.toBeInstanceOf(DocumentLockedError);
      expect(h.db.dump('documents')).toEqual(docBefore);
      expect(h.db.dump('document_versions')).toEqual(versionsBefore);
    }
  });
});

describe('REQ-BE-1.5.6', () => {
  it('T-EDIT-11 교체된 문서는 처리가 끝났어도 세 요청 모두 잠김 오류다', async () => {
    for (const state of ['completed', 'failed'] as const) {
      await boot();
      await seedDoc({ docId: DOC_A, searchState: 'replaced', processingState: state });
      await expect(h.service.edit(DOC_A, editBody({ name: '새이름' }))).rejects.toBeInstanceOf(
        DocumentLockedError,
      );
      await expect(h.service.reindex(DOC_A)).rejects.toBeInstanceOf(DocumentLockedError);
      await expect(
        h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')]),
      ).rejects.toBeInstanceOf(DocumentLockedError);
    }
  });
});

describe('REQ-BE-1.5.3', () => {
  it('T-EDIT-12a 검색 가능 문서를 같은 판으로 고치면 먼저 들어온 문서가 바로 교체된다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seedDoc({
      docId: DOC_B,
      name: 'B',
      edition: ed('v9'),
      editionEnteredAt: new Date('2026-10-02T00:00:00Z'),
    });
    await h.service.edit(
      DOC_B,
      editBody({ name: 'N', edition: { label: 'v1', edition_date: '2026-01-01' } }),
    );
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    expect(h.logs.recordsOf('replace')).toHaveLength(1);
    expect(h.logs.recordsOf('replace')[0].docId).toBe(DOC_A);
    await h.drain();
  });

  it('T-EDIT-12b 검색 안 되는 문서를 같은 판으로 고치면 검색 가능이 된 뒤에 교체된다', async () => {
    await seedDoc({
      docId: DOC_A,
      name: 'N',
      edition: ed('v1'),
      editionEnteredAt: new Date('2026-10-01T00:00:00Z'),
    });
    await seed(
      h.db,
      [
        docRecord({
          docId: DOC_C,
          name: 'C',
          edition: ed('v9'),
          searchState: 'not_searchable',
          processingState: 'failed',
          searchableVersion: null,
        }),
      ],
      [
        versionRecord({
          docId: DOC_C,
          result: null,
          failure: {
            code: 'RAG_UNREACHABLE',
            message: 'x',
            headingPath: null,
            placeholderId: null,
          },
        }),
      ],
    );
    await h.service.edit(
      DOC_C,
      editBody({ name: 'N', edition: { label: 'v1', edition_date: '2026-01-01' } }),
    );
    expect(docOf(h.db, DOC_A).searchState).toBe('searchable');
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId: DOC_C, jobState: 'succeeded', searchableVersion: '1' }),
    );
    expect(docOf(h.db, DOC_A).searchState).toBe('replaced');
    await h.drain();
  });
});

/** 내용 다시 올리기에 쓰는 새 MD 파일이다. */
const md = uploadFile('new.md', '# 새 내용');

describe('REQ-BE-1.9.1', () => {
  it('T-CONT-1 내용 다시 올리기는 새 원본으로 버전 2를 만들고 업로드됨으로 둔다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서' });
    const result = await h.service.uploadContents(DOC_A, [md]);
    expect(Object.keys(result).sort()).toEqual(['doc_id', 'file_name', 'name', 'unmatched_images']);
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.origin).toBe('content');
    expect(v2?.originalMarkdown).toBe('# 새 내용');
    expect(v2?.fileName).toBe('new.md');
    expect(h.assets.prepareVersion.mock.calls[0].slice(0, 3)).toEqual([DOC_A, '2', '# 새 내용']);
    expect(docOf(h.db, DOC_A).processingState).toBe('uploaded');
    expect(h.logs.recordsOf('content_upload')).toHaveLength(1);
    expect(transitionsOf(DOC_A)).toEqual([['completed', 'uploaded']]);
    await h.drain();
  });
});

describe('REQ-BE-1.6.2', () => {
  it('T-CONT-2 처리하는 동안에도 이전 버전이 계속 검색된다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.uploadContents(DOC_A, [md]);
    await h.drain();
    const hintIndex = h.assets.generateHints.mock.calls.findIndex((c) => c[1] === '2');
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    expect(h.indexing.requestIndex.mock.calls[0][0].version).toBe('2');
    expect(h.assets.generateHints.mock.invocationCallOrder[hintIndex]).toBeLessThan(
      h.indexing.requestIndex.mock.invocationCallOrder[0],
    );
    const doc = docOf(h.db, DOC_A);
    expect(doc.searchState).toBe('searchable');
    expect(doc.searchableVersion).toBe('1');
  });
});

describe('REQ-BE-1.6.1', () => {
  it('T-CONT-3 형식·크기·MD 개수가 맞지 않으면 오류이고 마지막 버전은 그대로다', async () => {
    await seedDoc({ docId: DOC_A });
    await expect(
      h.service.uploadContents(DOC_A, [uploadFile('x.pdf', 'x')]),
    ).rejects.toBeInstanceOf(UnsupportedFileError);
    await expect(
      h.service.uploadContents(DOC_A, [uploadFile('big.md', Buffer.alloc(1001, 97))]),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a'), uploadFile('b.md', 'b')]),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(docOf(h.db, DOC_A).latestVersion).toBe('1');
  });

  it('T-CONT-4 준비가 실패하면 상태·마지막 버전·updatedAt을 되돌리고 버전 2를 남기지 않는다', async () => {
    await seedDoc({ docId: DOC_A });
    const before = docOf(h.db, DOC_A);
    h.assets.prepareVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')])).rejects.toThrow(
      'boom',
    );
    const after = docOf(h.db, DOC_A);
    expect(after.processingState).toBe('completed');
    expect(after.latestVersion).toBe('1');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
  });

  it('T-CONT-5 앞선 실패가 남긴 버전 2 레코드가 있어도 다시 올리면 새 내용 하나만 남는다', async () => {
    await seedDoc({ docId: DOC_A });
    await seed(
      h.db,
      [],
      [versionRecord({ docId: DOC_A, version: '2', originalMarkdown: '찌꺼기' })],
    );
    await h.service.uploadContents(DOC_A, [uploadFile('a.md', '새 내용')]);
    const twos = h.db.dump('document_versions').filter((v) => v.version === '2');
    expect(twos).toHaveLength(1);
    expect(twos[0].originalMarkdown).toBe('새 내용');
    await h.drain();
  });
});

describe('REQ-BE-1.4.1', () => {
  it('T-CONT-6 삭제된 문서와 없는 ID는 DocumentNotFoundError다', async () => {
    await seedDoc({ docId: DOC_A, deleted: true });
    await expect(h.service.uploadContents(DOC_A, [uploadFile('a.md', 'a')])).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    await expect(h.service.uploadContents(DOC_B, [uploadFile('a.md', 'a')])).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });
});

describe('REQ-BE-1.7.1', () => {
  it('T-RIX-1 임시 설명이 있으면 captioning으로 두고 요약·캡션 뒤 강제 색인한다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.markTemporaryForRegeneration.mockResolvedValue(2);
    await h.service.reindex(DOC_A);
    expect(docOf(h.db, DOC_A).processingState).toBe('captioning');
    expect(transitionsOf(DOC_A)).toEqual([['completed', 'captioning']]);
    await h.drain();
    const hintIndex = h.assets.generateHints.mock.calls.findIndex((c) => c[1] === '2');
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    const request = h.indexing.requestIndex.mock.calls[0][0];
    expect(request.version).toBe('2');
    expect(request.force).toBe(true);
    expect(h.assets.generateHints.mock.invocationCallOrder[hintIndex]).toBeLessThan(
      h.indexing.requestIndex.mock.invocationCallOrder[0],
    );
  });

  it('T-RIX-2 임시 설명이 없으면 색인 대기로 두고 요약·캡션 없이 강제 색인한다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.markTemporaryForRegeneration.mockResolvedValue(0);
    await h.service.reindex(DOC_A);
    expect(docOf(h.db, DOC_A).processingState).toBe('queued');
    expect(transitionsOf(DOC_A)).toEqual([['completed', 'queued']]);
    await h.drain();
    expect(h.indexing.requestIndex.mock.calls[0][0]).toMatchObject({ version: '2', force: true });
    expect(h.assets.generateHints).not.toHaveBeenCalled();
  });

  it('T-RIX-4 새 버전 만들기가 실패하면 상태와 마지막 버전을 되돌린다', async () => {
    await seedDoc({ docId: DOC_A });
    h.assets.inheritVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(h.service.reindex(DOC_A)).rejects.toThrow('boom');
    const doc = docOf(h.db, DOC_A);
    expect(doc.latestVersion).toBe('1');
    expect(doc.processingState).toBe('completed');
    expect(versionOf(h.db, DOC_A, '2')).toBeUndefined();
  });
});

describe('REQ-BE-1.6.3', () => {
  it('T-RIX-3 재색인 버전은 이전 버전과 같은 내용에 origin reindex이고 updatedAt은 그대로다', async () => {
    await seedDoc({ docId: DOC_A });
    const before = docOf(h.db, DOC_A);
    await h.service.reindex(DOC_A);
    const v1 = versionOf(h.db, DOC_A, '1');
    const v2 = versionOf(h.db, DOC_A, '2');
    expect(v2?.origin).toBe('reindex');
    expect(v2?.originalMarkdown).toBe(v1?.originalMarkdown);
    expect(v2?.indexingMarkdown).toBe(v1?.indexingMarkdown);
    expect(v2?.fileName).toBe(v1?.fileName);
    const call = h.assets.inheritVersion.mock.calls[0];
    expect(call.slice(0, 3)).toEqual([DOC_A, '1', '2']);
    expect(call[3]).toEqual(new Map());
    expect(docOf(h.db, DOC_A).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    await h.drain();
  });
});

describe('REQ-BE-1.8.1', () => {
  it('T-DEL-1 청크 삭제가 끝나지 않아도 remove는 돌아오고 삭제 표시와 기록이 남는다', async () => {
    await seedDoc({ docId: DOC_A, name: '지울것', edition: ed('v1') });
    const gate = deferred<boolean>();
    h.indexing.deleteChunks.mockReturnValue(gate.promise);
    await h.service.remove(DOC_A);
    const doc = docOf(h.db, DOC_A);
    expect(doc.deleted).toBe(true);
    expect(doc.pendingRag.deleteChunks).toBe(true);
    const deletes = h.logs.recordsOf('delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ outcome: 'success', name: '지울것', editionLabel: 'v1' });
    gate.resolve(true);
    await h.drain();
  });

  it('T-DEL-4 같은 문서를 두 번 지우면 둘째는 DocumentNotFoundError이고 기록은 하나다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.remove(DOC_A);
    await expect(h.service.remove(DOC_A)).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(h.logs.recordsOf('delete')).toHaveLength(1);
    await h.drain();
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-DEL-2 청크 삭제가 성공하면 표시를 지우고 데이터를 지우며 문서 레코드는 남긴다', async () => {
    await seedDoc({ docId: DOC_A });
    await h.service.remove(DOC_A);
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(false);
    expect(h.assets.deleteDocument).toHaveBeenCalledWith(DOC_A);
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(0);
    expect(doc.purged).toBe(true);
  });

  it('T-DEL-3 청크 삭제가 실패하면 표시와 데이터가 남는다', async () => {
    await seedDoc({ docId: DOC_A });
    h.indexing.deleteChunks.mockResolvedValue(false);
    await h.service.remove(DOC_A);
    await h.drain();
    const doc = docOf(h.db, DOC_A);
    expect(doc.pendingRag.deleteChunks).toBe(true);
    expect(h.assets.deleteDocument).not.toHaveBeenCalled();
    expect(h.db.dump('document_versions').filter((v) => v.docId === DOC_A)).toHaveLength(1);
    expect(doc.purged).toBe(false);
  });
});

describe('REQ-BE-1.8.6', () => {
  it('T-DEL-5 삭제·데이터 삭제 뒤에도 getRef는 이름·판과 삭제 여부를 준다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서', edition: ed('v1') });
    await h.service.remove(DOC_A);
    await h.drain();
    expect(await h.service.getRef(DOC_A)).toEqual({
      docId: DOC_A,
      name: '문서',
      edition: ed('v1'),
      deleted: true,
    });
  });

  it('T-Q-3 없는 문서는 null이고 삭제된 문서는 deleted 참으로 준다', async () => {
    await seedDoc({ docId: DOC_A, name: '문서', deleted: true });
    expect(await h.service.getRef(DOC_B)).toBeNull();
    expect(await h.service.getRef(DOC_A)).toMatchObject({ deleted: true, name: '문서' });
  });
});

describe('REQ-BE-4.1.2', () => {
  it('T-Q-1 이름들로 보이는 문서 ID만 중복 없이 준다', async () => {
    await seed(h.db, [
      docRecord({ docId: DOC_A, name: '가', uploadedAt: new Date('2026-10-01T00:00:00Z') }),
      docRecord({ docId: DOC_B, name: '가', searchState: 'replaced' }),
      docRecord({ docId: DOC_C, name: '가', deleted: true }),
      docRecord({ docId: DOC_D, name: '나', uploadedAt: new Date('2026-10-02T00:00:00Z') }),
    ]);
    const ids = await h.service.resolveNames(['가', '가', '나']);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([DOC_A, DOC_D]));
    const before = findCalls();
    expect(await h.service.resolveNames([])).toEqual([]);
    expect(findCalls()).toBe(before);
  });
});

describe('REQ-BE-4.2.2', () => {
  it('T-Q-2 받은 ID 중 삭제됨·교체됨·없는 ID를 뺀다', async () => {
    await seed(h.db, [
      docRecord({ docId: DOC_A }),
      docRecord({ docId: DOC_B, deleted: true }),
      docRecord({ docId: DOC_C, searchState: 'replaced' }),
    ]);
    expect(await h.service.visibleDocIds([DOC_A, DOC_B, DOC_C, DOC_D])).toEqual(new Set([DOC_A]));
    expect(await h.service.visibleDocIds([])).toEqual(new Set());
  });
});

describe('REQ-BE-5.1.5', () => {
  it('T-Q-4 평가 대상은 검색되는 버전의 색인용 MD를 준다', async () => {
    await seed(
      h.db,
      [
        docRecord({ docId: DOC_A, latestVersion: '3', searchableVersion: '2' }),
        docRecord({
          docId: DOC_B,
          searchState: 'not_searchable',
          searchableVersion: null,
          processingState: 'uploaded',
        }),
      ],
      [
        versionRecord({ docId: DOC_A, version: '1', indexingMarkdown: 'IDX1' }),
        versionRecord({ docId: DOC_A, version: '2', indexingMarkdown: 'IDX2' }),
        versionRecord({ docId: DOC_A, version: '3', indexingMarkdown: 'IDX3' }),
        versionRecord({ docId: DOC_B }),
      ],
    );
    const target = await h.service.getEvaluationTarget(DOC_A);
    expect(target?.searchableIndexingMarkdown).toBe('IDX2');
    expect(target?.searchState).toBe('searchable');
    expect((await h.service.getEvaluationTarget(DOC_B))?.searchableIndexingMarkdown).toBeNull();
    expect(await h.service.getEvaluationTarget(DOC_C)).toBeNull();
  });
});

/** 기록·로그 흐름이 만든 문서 ID들이다. */
interface FlowIds {
  first: string;
  second: string;
  third: string;
  fourth: string;
}

/**
 * 업로드 → 완료 → 이름 편집 → 요약·캡션 편집 → 내용 다시 올리기 → 같은 판 교체 → 삭제 → 거부 → 실패를 돌린다.
 * 센티널(이름·판 표기·판 날짜·MD·파일 이름·요약·캡션·실패 사유)을 모두 쓴다.
 */
async function runLogFlow(): Promise<FlowIds> {
  const done = async (docId: string, version: string): Promise<void> => {
    await h.drain();
    await h.lifecycle.onJobStateChanged(
      jobEvent({ docId, version, jobState: 'succeeded', searchableVersion: version }),
    );
  };
  h.assets.listViews.mockResolvedValue([tableView('t1', '기존')]);
  h.assets.hintsFor.mockResolvedValue([{ placeholderId: 't1', text: HINT_SENT }]);
  const edition = { label: LABEL_SENT, edition_date: DATE_SENT };
  const renamed = `${NAME_SENT}-b`;

  // 1. 첫 문서 업로드와 완료
  const up1 = await h.service.upload(
    [uploadFile(FILE_SENT, MD_SENT)],
    [{ file_name: FILE_SENT, name: NAME_SENT, edition }],
  );
  const first = up1.documents[0].doc_id;
  await done(first, '1');
  // 2. 이름 편집, 요약·캡션 편집
  await h.service.edit(first, editBody({ name: renamed }));
  await h.drain();
  await h.service.edit(first, editBody({ assets: [{ placeholder_id: 't1', text: HINT_SENT }] }));
  await done(first, '2');
  // 3. 내용 다시 올리기
  await h.service.uploadContents(first, [uploadFile(FILE_SENT, `${MD_SENT} 둘째`)]);
  await done(first, '3');
  // 4. 같은 판 문서가 검색 가능해져 첫 문서가 교체된다
  const up2 = await h.service.upload(
    [uploadFile('second.md', MD_SENT)],
    [{ file_name: 'second.md', name: renamed, edition }],
  );
  const second = up2.documents[0].doc_id;
  await done(second, '1');
  // 5. 삭제
  await h.service.remove(second);
  await h.drain();
  // 6. 거부되는 요청(기록이 없어야 한다)
  const third = (
    await h.service.upload(
      [uploadFile('third.md', MD_SENT)],
      [{ file_name: 'third.md', name: `${NAME_SENT}-c` }],
    )
  ).documents[0].doc_id;
  await expect(
    h.service.upload([uploadFile('bad.pdf', 'x')], [{ file_name: 'bad.pdf', name: 'x' }]),
  ).rejects.toBeInstanceOf(UnsupportedFileError);
  await expect(h.service.edit(third, editBody({ name: '잠김' }))).rejects.toBeInstanceOf(
    DocumentLockedError,
  );
  await h.drain();
  // 7. 실패 이벤트
  const fourth = (
    await h.service.upload(
      [uploadFile('fourth.md', MD_SENT)],
      [{ file_name: 'fourth.md', name: `${NAME_SENT}-d` }],
    )
  ).documents[0].doc_id;
  await h.drain();
  await h.lifecycle.onJobStateChanged(
    jobEvent({
      docId: fourth,
      jobState: 'failed',
      searchableVersion: null,
      result: null,
      failure: {
        code: 'PARSE_FAILED',
        message: FAILMSG_SENT,
        headingPath: null,
        placeholderId: null,
      },
    }),
  );
  await h.drain();
  return { first, second, third, fourth };
}

describe('REQ-BE-6.1.1', () => {
  it('T-LOGR-1 단계마다 기록 종류·결과·상세가 명세와 같고 거부된 요청은 기록이 없다', async () => {
    const ids = await runLogFlow();
    const success = 'success' as const;
    const state = (from: string, to: string) => ({ fromState: from, toState: to });
    const rec = (
      kind: string,
      name: string,
      detail: Record<string, unknown> | null,
      outcome: 'success' | 'failure' = success,
    ) => ({ kind, name, editionLabel: LABEL_SENT, outcome, detail });
    const renamed = `${NAME_SENT}-b`;

    // ★ 서로 다른 종류의 기록 사이 순서는 정하지 않는다. 문서·종류별로 걸러 비교한다
    const ofKind = (docId: string, kind: string) =>
      recordsFor(docId).filter((record) => record.kind === kind);
    expect(ofKind(ids.first, 'upload')).toEqual([rec('upload', NAME_SENT, null)]);
    expect(ofKind(ids.first, 'processing_state')).toEqual([
      rec('processing_state', NAME_SENT, state('uploaded', 'captioning')),
      rec('processing_state', NAME_SENT, state('captioning', 'queued')),
      rec('processing_state', NAME_SENT, state('queued', 'completed')),
      rec('processing_state', renamed, state('completed', 'queued')),
      rec('processing_state', renamed, state('queued', 'completed')),
      rec('processing_state', renamed, state('completed', 'uploaded')),
      rec('processing_state', renamed, state('uploaded', 'captioning')),
      rec('processing_state', renamed, state('captioning', 'queued')),
      rec('processing_state', renamed, state('queued', 'completed')),
    ]);
    expect(ofKind(ids.first, 'edit')).toEqual([
      rec('edit', renamed, { changedFields: ['name'] }),
      rec('edit', renamed, { changedFields: ['hints'] }),
    ]);
    expect(ofKind(ids.first, 'content_upload')).toEqual([rec('content_upload', renamed, null)]);
    expect(ofKind(ids.first, 'replace')).toEqual([
      rec('replace', renamed, { replacedByDocId: ids.second }),
    ]);
    expect(recordsFor(ids.first)).toHaveLength(14);
    const secondKinds = recordsFor(ids.second).map((r) => r.kind);
    expect(secondKinds.filter((kind) => kind === 'upload')).toHaveLength(1);
    expect(secondKinds.filter((kind) => kind === 'processing_state')).toHaveLength(3);
    expect(secondKinds.filter((kind) => kind === 'delete')).toHaveLength(1);
    expect(secondKinds).toHaveLength(5);
    // 거부된 요청(형식 오류·잠금)은 기록이 없다. 셋째 문서는 업로드 기록뿐이다
    expect(recordsFor(ids.third).filter((r) => r.kind !== 'processing_state')).toEqual([
      {
        kind: 'upload',
        name: `${NAME_SENT}-c`,
        editionLabel: null,
        outcome: success,
        detail: null,
      },
    ]);
    expect(h.logs.recordsOf('edit').filter((r) => r.docId === ids.third)).toHaveLength(0);
    // 실패 이벤트는 실패 기록과 사유 코드를 남긴다
    const failed = recordsFor(ids.fourth).at(-1);
    expect(failed).toMatchObject({
      kind: 'processing_state',
      outcome: 'failure',
      detail: { fromState: 'queued', toState: 'failed', reasonCode: 'PARSE_FAILED' },
    });
  });
});

describe('REQ-BE-8.2.1', () => {
  /** pino가 넣는 기본 필드다. */
  const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
  /** MODULE.md 「로그」 표의 이벤트별 허용 필드다. 줄은 이 안의 부분집합이어야 한다. */
  const ALLOWED_KEYS: Record<string, string[]> = {
    'documents.state_changed': ['docId', 'version', 'from', 'to', 'searchState'],
    'documents.replaced': ['docId', 'replacedBy'],
    'documents.processing_stopped': ['docId', 'version', 'reason'],
    'documents.resume': ['captioning', 'requeued', 'reconciled', 'recovered'],
    'documents.task_failed': ['task', 'docId', 'errorName'],
  };
  const STOP_REASONS = ['deleted', 'replaced', 'superseded', 'shutdown', 'state_changed'];
  const TASKS = [
    'process',
    'index',
    'delete_chunks',
    'metadata',
    'resume',
    'reconcile',
    'rag_retry',
  ];

  const SENTINELS = [
    NAME_SENT,
    LABEL_SENT,
    MD_SENT,
    HINT_SENT,
    FILE_SENT,
    FAILMSG_SENT,
    IDX_SENT,
    DATE_SENT,
  ];

  /** documents 로그 줄만 모은다. */
  const documentLines = () =>
    capture
      .parsed()
      .filter((line) => typeof line.msg === 'string' && line.msg.startsWith('documents.'));

  /** 줄의 키가 그 이벤트의 허용 필드 안에 있는지 본다. */
  function expectAllowedKeys(line: Record<string, unknown>): void {
    const msg = line.msg as string;
    expect(Object.keys(ALLOWED_KEYS)).toContain(msg);
    const keys = Object.keys(line).filter((key) => !PINO_BASE.includes(key));
    expect([msg, keys.filter((key) => !ALLOWED_KEYS[msg].includes(key))]).toEqual([msg, []]);
  }

  it('T-LOGH-1 센티널이 로그에 없고 documents 로그는 허용 필드 안의 값만 담는다', async () => {
    await runLogFlow();
    for (const sentinel of SENTINELS) expect(capture.lines.join('\n')).not.toContain(sentinel);
    const docLines = documentLines();
    expect(docLines.length).toBeGreaterThan(0);
    for (const line of docLines) expectAllowedKeys(line);
    expect(docLines.some((line) => line.msg === 'documents.state_changed')).toBe(true);
    expect(docLines.some((line) => line.msg === 'documents.replaced')).toBe(true);
  });

  it('T-LOGH-2 기동 처리·처리 중단·작업 실패 줄도 허용 필드만 담고 센티널이 없다', async () => {
    // 기동 처리: 표·이미지 처리를 이을 문서가 있는 경우
    await seed(
      h.db,
      [docRecord({ docId: DOC_B, name: NAME_SENT, processingState: 'captioning' })],
      [versionRecord({ docId: DOC_B, jobId: null })],
    );
    await h.scheduler.resume();
    await h.drain();
    // 작업 실패: 요약·캡션 만들기가 센티널 문장의 오류로 실패한다
    h.assets.generateHints.mockRejectedValueOnce(new Error(FAILMSG_SENT));
    await h.service.upload(
      [uploadFile(FILE_SENT, MD_SENT)],
      [
        {
          file_name: FILE_SENT,
          name: NAME_SENT,
          edition: { label: LABEL_SENT, edition_date: DATE_SENT },
        },
      ],
    );
    await h.drain();
    // 처리 중단: 요약·캡션을 만드는 동안 삭제한다
    const gate = deferred<{ generated: number; temporary: number; stopped: boolean }>();
    const calls = h.assets.generateHints.mock.calls.length;
    h.assets.generateHints.mockImplementationOnce(() => gate.promise);
    const second = await h.service.upload(
      [uploadFile('stop.md', MD_SENT)],
      [{ file_name: 'stop.md', name: `${NAME_SENT}-s` }],
    );
    await waitUntil(() => h.assets.generateHints.mock.calls.length > calls);
    await h.service.remove(second.documents[0].doc_id);
    gate.resolve({ generated: 0, temporary: 0, stopped: false });
    await h.drain();

    for (const sentinel of SENTINELS) expect(capture.lines.join('\n')).not.toContain(sentinel);
    const lines = documentLines();
    for (const line of lines) expectAllowedKeys(line);
    const of = (msg: string) => lines.filter((line) => line.msg === msg);
    expect(of('documents.resume')).toHaveLength(1);
    expect(of('documents.task_failed').length).toBeGreaterThan(0);
    for (const line of of('documents.task_failed')) {
      expect(TASKS).toContain(line.task);
      expect(line.errorName).toBe('Error');
    }
    expect(of('documents.processing_stopped').length).toBeGreaterThan(0);
    for (const line of of('documents.processing_stopped')) {
      expect(STOP_REASONS).toContain(line.reason);
    }
  });
});
