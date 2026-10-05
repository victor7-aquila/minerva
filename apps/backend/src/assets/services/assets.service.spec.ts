import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import MarkdownIt from 'markdown-it';
import { AssetNotFoundError, InvalidRequestError, RagUnavailableError } from '../../common';
import { LogsService } from '../../logs';
import { RagClient, RagRequestError } from '../../rag';
import { FILE_STORE, MONGO_DB } from '../../storage';
import { createFakeDb } from '../../../test/support/fake-mongo';
import type { FakeDb } from '../../../test/support/fake-mongo';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import { AssetsCrudService } from './assets-crud.service';
import { AssetsService } from './assets.service';
import type { HintContext, UploadedImage } from '../interfaces/assets.types';
import { extractAssets } from '../helpers/markdown-assets';

// ★ nestjs-pino는 루트 로거를 파일당 하나만 만든다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

/** 로그 비노출 검사용 센티널이다. */
const SENTINELS = {
  cell: 'TBL-SENT-71',
  alt: 'ALT-SENT-72',
  path: 'path-sent-73.png',
  caption: 'CAP-SENT-74',
  name: 'NAME-SENT-75',
};

const TABLE1 = '| 키 | 값 |\n| --- | --- |\n| a | b |';
const TABLE2 = '| x |\n| --- |\n| y |';
const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x01]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x02]);
const ZWSP = String.fromCharCode(0x200b);
/** 표·짝 있는 이미지·표 순서의 문서다. 자리표시 ID는 t1, i1, t2다. */
const HINT_MD = [TABLE1, '![A](a.png)', TABLE2].join('\n\n');
/** pino가 넣는 기본 필드다. 로그 필드 비교에서 뺀다 */
const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
/** 자리표시 정규식(IF-1) */
const IF1_ANYWHERE = /\[\[minerva:(?:table|image):([a-z0-9]+) \| [^\n]*?\]\]/g;

let db: FakeDb;
let store: Map<string, Buffer>;
let moduleRef: TestingModule;
let service: AssetsService;
/** RAG 호출 시점의 updateOne 호출 수를 모은다 */
let updatesAtRagCall: number[];

const fakeFiles = {
  put: jest.fn(async (key: string, data: Buffer): Promise<void> => {
    store.set(key, data);
  }),
  read: jest.fn(async (key: string): Promise<Buffer | null> => store.get(key) ?? null),
  deletePrefix: jest.fn(async (prefix: string): Promise<void> => {
    for (const key of [...store.keys()]) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }),
};
const fakeRag = {
  summarizeTable: jest.fn<Promise<string>, [tableMarkdown: string]>(),
  captionImage: jest.fn<Promise<string>, [image: Buffer, fileName: string]>(),
};
const fakeLogs = { record: jest.fn<Promise<void>, [input: unknown]>() };

beforeEach(async () => {
  db = createFakeDb();
  store = new Map();
  updatesAtRagCall = [];
  capture.clear();
  fakeFiles.put.mockClear();
  fakeFiles.read.mockClear();
  fakeFiles.deletePrefix.mockClear();
  fakeRag.summarizeTable.mockReset();
  fakeRag.captionImage.mockReset();
  fakeLogs.record.mockReset();
  const updates = (): number => db.calls.filter((call) => call.op === 'updateOne').length;
  fakeRag.summarizeTable.mockImplementation(async () => {
    updatesAtRagCall.push(updates());
    return '표 요약';
  });
  fakeRag.captionImage.mockImplementation(async () => {
    updatesAtRagCall.push(updates());
    return '이미지 캡션';
  });
  fakeLogs.record.mockResolvedValue(undefined);
  moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({}, capture.stream)],
    providers: [
      AssetsService,
      AssetsCrudService,
      { provide: MONGO_DB, useValue: db },
      { provide: FILE_STORE, useValue: fakeFiles },
      { provide: RagClient, useValue: fakeRag },
      { provide: LogsService, useValue: fakeLogs },
    ],
  }).compile();
  service = moduleRef.get(AssetsService);
  // ★ 인덱스를 만들어 가짜 Db에도 unique 제약(docId, version, placeholderId)을 건다.
  //   재호출·재시도 흐름이 실제처럼 중복 삽입에 막히는 조건 아래서 돈다
  await service.onModuleInit();
});

afterEach(async () => {
  await moduleRef.close();
});

/** 업로드 이미지를 만든다. */
function up(fileName: string, data: Buffer, contentType = 'image/png'): UploadedImage {
  return { fileName, contentType, data };
}

/** shouldContinue가 차례로 값을 돌려주는 컨텍스트를 만든다. 다 쓰면 true다. */
function ctx(answers: boolean[] = []): HintContext & { shouldContinue: jest.Mock } {
  const queue = [...answers];
  return {
    name: '설계서',
    editionLabel: 'v1',
    shouldContinue: jest.fn(async () => (queue.length > 0 ? (queue.shift() as boolean) : true)),
  };
}

/** HINT_MD 문서를 준비한다. */
async function prepareHintDoc(docId = 'doc-1', version = '1'): Promise<string> {
  const prepared = await service.prepareVersion(docId, version, HINT_MD, [up('a.png', PNG_A)]);
  return prepared.indexingMarkdown;
}

/** 버전의 레코드를 order 순으로 꺼낸다. */
function records(version = '1', docId = 'doc-1'): Array<Record<string, unknown>> {
  return db
    .dump('assets')
    .filter((row) => row.docId === docId && row.version === version)
    .sort((a, b) => (a.order as number) - (b.order as number));
}

/** 자리표시 ID로 레코드 하나를 꺼낸다. */
function record(id: string, version = '1', docId = 'doc-1'): Record<string, unknown> {
  const found = records(version, docId).find((row) => row.placeholderId === id);
  if (found === undefined) throw new Error(`레코드 없음: ${id}`);
  return found;
}

/** 이벤트명이 msg인 로그 줄들이다. */
function eventLines(event: string): Array<Record<string, unknown>> {
  return capture.parsed().filter((line) => line.msg === event);
}

/** 로그 줄의 필드 키(기본 필드 제외)를 정렬해 돌려준다. */
function fieldKeys(line: Record<string, unknown>): string[] {
  return Object.keys(line)
    .filter((key) => !PINO_BASE.includes(key))
    .sort();
}

/** 문장을 Markdown으로 파싱해 이미지 src들을 돌려준다. */
function imageSrcs(markdown: string): string[] {
  const srcs: string[] = [];
  for (const token of new MarkdownIt().parse(markdown, {})) {
    for (const child of token.children ?? []) {
      if (child.type === 'image') srcs.push(child.attrGet('src') ?? '');
    }
  }
  return srcs;
}

describe('REQ-BE-2.1.1', () => {
  it('T-PREP-1 표 둘·이미지 셋(짝 없음 하나)과 업로드 둘을 등록하고 파일 둘을 저장한다', async () => {
    const md = [TABLE1, '![A](img/a.png)', TABLE2, '![B](b.jpg)', '![C](missing.png)'].join('\n\n');
    const result = await service.prepareVersion('doc-1', '1', md, [
      up('a.png', PNG_A),
      up('b.jpg', PNG_B, 'image/jpeg'),
    ]);
    expect(result.assetCount).toBe(5);
    expect(db.dump('assets')).toHaveLength(5);
    expect(fakeFiles.put).toHaveBeenCalledTimes(2);
    expect(result.unmatchedImages).toEqual(['missing.png']);
  });

  it('T-PREP-2 짝 레코드는 파일 키·바이트·contentType을 갖고 경로 표기 차이를 흡수한다', async () => {
    const nfdName = '한글.png'.normalize('NFD');
    const md = [
      '![a](./img/a.png)',
      '![p](img/my%20pic.png)',
      `![k](${'한글.png'.normalize('NFC')})`,
      '![c](Case.png)',
      '![d](a.png)',
    ].join('\n\n');
    const data = {
      a: Buffer.from('aaa'),
      pic: Buffer.from('pic'),
      kor: Buffer.from('kor'),
      lower: Buffer.from('low'),
    };
    await service.prepareVersion('doc-1', '1', md, [
      up('a.png', data.a, 'application/octet-stream'),
      up('my pic.png', data.pic),
      up(nfdName, data.kor),
      up('case.png', data.lower),
    ]);
    const i1 = record('i1');
    expect(i1.fileKey).toBe('doc-1/1/i1.png');
    expect(i1.contentType).toBe('image/png');
    expect(store.get('doc-1/1/i1.png')).toEqual(data.a);
    expect(record('i2').fileKey).toBe('doc-1/1/i2.png');
    expect(store.get('doc-1/1/i2.png')).toEqual(data.pic);
    expect(record('i3').fileKey).toBe('doc-1/1/i3.png');
    expect(store.get('doc-1/1/i3.png')).toEqual(data.kor);
    // 대소문자가 다르면 짝이 아니다
    expect(record('i4').fileKey).toBeNull();
    // 같은 업로드를 두 이미지가 가리키면 파일이 둘이다
    expect(record('i5').fileKey).toBe('doc-1/1/i5.png');
    expect(store.get('doc-1/1/i5.png')).toEqual(data.a);
    expect([...store.keys()].sort()).toEqual([
      'doc-1/1/i1.png',
      'doc-1/1/i2.png',
      'doc-1/1/i3.png',
      'doc-1/1/i5.png',
    ]);
  });

  it('T-PREP-4 업로드에 같은 이름이 둘이면 InvalidRequestError이고 아무것도 쓰지 않는다', async () => {
    const attempt = service.prepareVersion('doc-1', '1', '![a](a.png)', [
      up('a.png', PNG_A),
      up('a.png', PNG_B),
    ]);
    await expect(attempt).rejects.toBeInstanceOf(InvalidRequestError);
    expect(db.dump('assets')).toEqual([]);
    expect(fakeFiles.put).not.toHaveBeenCalled();
    expect(fakeFiles.deletePrefix).not.toHaveBeenCalled();
  });

  it('T-PREP-6 레코드 초기값과 키 집합이 MODULE.md 데이터 계약과 같다', async () => {
    await service.prepareVersion('doc-1', '1', HINT_MD, [up('a.png', PNG_A)]);
    const rows = records();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'alt',
        'contentType',
        'description',
        'docId',
        'fileKey',
        'hint',
        'hintStatus',
        'imagePath',
        'isTemporary',
        'kind',
        'order',
        'placeholderId',
        'tableMarkdown',
        'version',
      ]);
      expect(row.hint).toBeNull();
      expect(row.hintStatus).toBe('pending');
      expect(row.isTemporary).toBe(false);
    }
    const t1 = record('t1');
    expect(t1.kind).toBe('table');
    expect(t1.tableMarkdown).toBe(TABLE1);
    expect([t1.imagePath, t1.alt, t1.fileKey, t1.contentType]).toEqual([null, null, null, null]);
    const i1 = record('i1');
    expect(i1.kind).toBe('image');
    expect(i1.tableMarkdown).toBeNull();
    expect(i1.imagePath).toBe('a.png');
    expect(i1.alt).toBe('A');
  });
});

describe('REQ-BE-1.1.4', () => {
  it('T-PREP-3 같은 짝 없는 경로가 두 번 나와도 unmatchedImages에는 한 번이고 레코드의 파일 정보는 null이다', async () => {
    const result = await service.prepareVersion(
      'doc-1',
      '1',
      ['![a](gone.png)', '![b](gone.png)'].join('\n\n'),
      [],
    );
    expect(result.unmatchedImages).toEqual(['gone.png']);
    for (const row of records()) {
      expect(row.fileKey).toBeNull();
      expect(row.contentType).toBeNull();
    }
  });
});

describe('REQ-BE-2.1.3', () => {
  it('T-PREP-5 같은 버전을 다시 준비하면 두 번째 결과만 남고 이전 파일은 지워진다', async () => {
    await service.prepareVersion('doc-1', '1', ['![a](a.png)', '![b](b.png)'].join('\n\n'), [
      up('a.png', PNG_A),
      up('b.png', PNG_B),
    ]);
    await service.prepareVersion('doc-1', '1', '![b](b.png)', [up('b.png', PNG_B)]);
    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0].placeholderId).toBe('i1');
    expect(new Set(db.dump('assets').map((row) => row.placeholderId)).size).toBe(1);
    expect(fakeFiles.deletePrefix).toHaveBeenCalledWith('doc-1/1/');
    expect([...store.keys()]).toEqual(['doc-1/1/i1.png']);
    expect(store.get('doc-1/1/i1.png')).toEqual(PNG_B);
  });
});

describe('REQ-BE-2.2.1', () => {
  it('T-PREP-7 반환 indexingMarkdown이 extractAssets의 결과와 같다', async () => {
    const result = await service.prepareVersion('doc-1', '1', HINT_MD, [up('a.png', PNG_A)]);
    expect(result.indexingMarkdown).toBe(extractAssets(HINT_MD).indexingMarkdown);
  });
});

describe('REQ-BE-2.3.1', () => {
  it('T-HINT-1 RAG 호출은 원본 순서이고 각 호출은 앞 호출의 저장 뒤에 일어난다', async () => {
    await prepareHintDoc();
    const result = await service.generateHints('doc-1', '1', ctx());
    expect(result).toEqual({ generated: 3, temporary: 0, stopped: false });
    const order = [
      fakeRag.summarizeTable.mock.invocationCallOrder[0],
      fakeRag.captionImage.mock.invocationCallOrder[0],
      fakeRag.summarizeTable.mock.invocationCallOrder[1],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 호출 시점의 저장 수가 0, 1, 2다
    expect(updatesAtRagCall).toEqual([0, 1, 2]);
  });

  it('T-HINT-2 summarizeTable에는 표 원문을, captionImage에는 저장 바이트와 키의 마지막 조각을 넘긴다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx());
    expect(fakeRag.summarizeTable.mock.calls.map((call) => call[0])).toEqual([TABLE1, TABLE2]);
    expect(fakeRag.captionImage).toHaveBeenCalledTimes(1);
    const [data, fileName] = fakeRag.captionImage.mock.calls[0];
    expect(data).toEqual(PNG_A);
    expect(fileName).toBe('i1.png');
  });

  it('T-HINT-3 shouldContinue가 false가 되면 멈추고 남은 레코드는 pending이다', async () => {
    await prepareHintDoc();
    const result = await service.generateHints('doc-1', '1', ctx([true, true, false]));
    expect(result).toEqual({ generated: 2, temporary: 0, stopped: true });
    expect(fakeRag.summarizeTable).toHaveBeenCalledTimes(1);
    expect(fakeRag.captionImage).toHaveBeenCalledTimes(1);
    expect(record('t2').hintStatus).toBe('pending');
  });

  it('T-HINT-3 첫 항목 전에도 shouldContinue를 묻는다', async () => {
    await prepareHintDoc();
    const context = ctx([false]);
    const result = await service.generateHints('doc-1', '1', context);
    expect(context.shouldContinue).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ generated: 0, temporary: 0, stopped: true });
    expect(fakeRag.summarizeTable).not.toHaveBeenCalled();
    expect(fakeRag.captionImage).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-2.3.2', () => {
  it.each([
    ['RagRequestError', new RagRequestError(502, 'CAPTION_FAILED'), 'CAPTION_FAILED'],
    ['RagUnavailableError', new RagUnavailableError(), 'RAG_UNAVAILABLE'],
  ])('T-HINT-4 %s는 임시 설명으로 저장하고 경고 로그를 남긴다', async (_label, error, code) => {
    await prepareHintDoc();
    fakeRag.captionImage.mockRejectedValue(error);
    await service.generateHints('doc-1', '1', ctx());
    const i1 = record('i1');
    expect(i1.hint).toBe(i1.description);
    expect(i1.isTemporary).toBe(true);
    expect(i1.hintStatus).toBe('done');
    const lines = eventLines('assets.hint_failed');
    expect(lines).toHaveLength(1);
    expect(fieldKeys(lines[0])).toEqual(['code', 'docId', 'placeholderId', 'version']);
    expect(lines[0]).toMatchObject({ docId: 'doc-1', version: '1', placeholderId: 'i1', code });
    // pino warn 수준
    expect(lines[0].level).toBe(40);
  });

  it('T-HINT-5 저장소에 파일이 없으면 FILE_MISSING 임시 설명이다', async () => {
    await prepareHintDoc();
    store.delete('doc-1/1/i1.png');
    await service.generateHints('doc-1', '1', ctx());
    const i1 = record('i1');
    expect(i1.hint).toBe(i1.description);
    expect(i1.isTemporary).toBe(true);
    expect(eventLines('assets.hint_failed')[0]).toMatchObject({ code: 'FILE_MISSING' });
    expect(fakeRag.captionImage).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('T-HINT-5 응답이 %j이면 EMPTY_RESULT 임시 설명이다', async (empty) => {
    await prepareHintDoc();
    fakeRag.captionImage.mockResolvedValue(empty);
    await service.generateHints('doc-1', '1', ctx());
    const i1 = record('i1');
    expect(i1.hint).toBe(i1.description);
    expect(i1.isTemporary).toBe(true);
    expect(eventLines('assets.hint_failed')[0]).toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('T-HINT-11 RAG가 일반 Error를 던지면 임시 설명으로 바꾸지 않고 그 오류로 실패한다', async () => {
    await prepareHintDoc();
    fakeRag.captionImage.mockRejectedValue(new Error('plain-failure'));
    await expect(service.generateHints('doc-1', '1', ctx())).rejects.toThrow('plain-failure');
    expect(record('i1').hintStatus).toBe('pending');
  });
});

describe('REQ-BE-2.3.3', () => {
  it.each([
    ['대체 텍스트가 있으면 대체 텍스트', '![대체](gone.png)', '대체'],
    ['대체 텍스트가 없으면 파일 이름', '![](gone.png)', 'gone.png'],
  ])('T-HINT-6 짝 없는 이미지는 RAG 호출 없이 임시 설명이다(%s)', async (_label, md, expected) => {
    await service.prepareVersion('doc-1', '1', md, []);
    await service.generateHints('doc-1', '1', ctx());
    const i1 = record('i1');
    expect(i1.hint).toBe(expected);
    expect(i1.isTemporary).toBe(true);
    expect(i1.hintStatus).toBe('done');
    expect(fakeRag.captionImage).not.toHaveBeenCalled();
    expect(fakeFiles.read).not.toHaveBeenCalled();
    expect(eventLines('assets.hint_failed')).toEqual([]);
  });
});

describe('REQ-BE-2.3.4', () => {
  it('T-HINT-7 가운데가 실패해도 나머지를 요청하고 예외 없이 끝난다', async () => {
    await prepareHintDoc();
    fakeRag.captionImage.mockRejectedValue(new RagRequestError(502, 'CAPTION_FAILED'));
    const result = await service.generateHints('doc-1', '1', ctx());
    expect(result).toEqual({ generated: 3, temporary: 1, stopped: false });
    expect(fakeRag.summarizeTable).toHaveBeenCalledTimes(2);
  });
});

describe('REQ-BE-2.3.5', () => {
  it('T-HINT-8 끝나면 모든 레코드가 done이고 hintsFor가 모든 자리표시 ID를 order 순으로 준다', async () => {
    const indexing = await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx());
    for (const row of records()) expect(row.hintStatus).toBe('done');
    const hints = await service.hintsFor('doc-1', '1');
    expect(hints.map((hint) => hint.placeholderId)).toEqual(['t1', 'i1', 't2']);
    expect(hints.map((hint) => hint.text)).toEqual(['표 요약', '이미지 캡션', '표 요약']);
    // IF-1: 색인용 MD의 자리표시 ID 집합과 같다
    const ids = [...indexing.matchAll(IF1_ANYWHERE)].map((match) => match[1]);
    expect(new Set(hints.map((hint) => hint.placeholderId))).toEqual(new Set(ids));
  });

  it('T-HINT-8 pending이 남은 버전의 hintsFor는 그 항목에 description을 준다', async () => {
    await prepareHintDoc();
    const hints = await service.hintsFor('doc-1', '1');
    expect(hints.map((hint) => hint.text)).toEqual(records().map((row) => row.description));
  });
});

describe('REQ-BE-2.3.6', () => {
  it('T-HINT-9 멈춘 버전에 다시 실행하면 남은 것부터만 요청한다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx([true, true, false]));
    const before =
      fakeRag.summarizeTable.mock.calls.length + fakeRag.captionImage.mock.calls.length;
    const result = await service.generateHints('doc-1', '1', ctx());
    const after = fakeRag.summarizeTable.mock.calls.length + fakeRag.captionImage.mock.calls.length;
    expect(after - before).toBe(1);
    expect(result.generated).toBe(1);
  });

  it('T-HINT-9 이어서 해도 이미 저장된 문장은 그대로다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx([true, true, false]));
    const saved = [record('t1').hint, record('i1').hint];
    fakeRag.summarizeTable.mockResolvedValue('다른 요약');
    fakeRag.captionImage.mockResolvedValue('다른 캡션');
    await service.generateHints('doc-1', '1', ctx());
    expect([record('t1').hint, record('i1').hint]).toEqual(saved);
  });

  it('T-HINT-10 저장이 실패하면 예외가 그대로 나오고 그 전 항목의 저장은 남는다', async () => {
    await prepareHintDoc();
    // 이미지 캡션을 만든 뒤 그 저장(updateOne)이 실패하게 한다
    fakeRag.captionImage.mockImplementationOnce(async () => {
      db.failNext('updateOne', new Error('boom'));
      return '이미지 캡션';
    });
    await expect(service.generateHints('doc-1', '1', ctx())).rejects.toThrow('boom');
    expect(record('t1').hintStatus).toBe('done');
    expect(record('t1').hint).toBe('표 요약');
    expect(record('i1').hintStatus).toBe('pending');
  });

  it('T-INH-1 이어받은 버전은 ID·order가 같고 바꾼 문장만 새 값이며 파일은 복사하지 않는다', async () => {
    await prepareHintDoc();
    fakeRag.captionImage.mockRejectedValue(new RagRequestError(502, 'CAPTION_FAILED'));
    await service.generateHints('doc-1', '1', ctx());
    const v1Before = records('1');
    fakeFiles.put.mockClear();

    await service.inheritVersion('doc-1', '1', '2', new Map([['t1', '새 요약']]));

    const v2 = records('2');
    expect(v2.map((row) => [row.placeholderId, row.order])).toEqual(
      v1Before.map((row) => [row.placeholderId, row.order]),
    );
    expect(record('t1', '2').hint).toBe('새 요약');
    expect(record('t1', '2').isTemporary).toBe(false);
    expect(record('i1', '2').hint).toBe(record('i1', '1').hint);
    expect(record('i1', '2').isTemporary).toBe(true);
    expect(record('t2', '2').hint).toBe('표 요약');
    expect(record('t2', '2').isTemporary).toBe(false);
    for (const row of v2) expect(row.hintStatus).toBe('done');
    expect(records('1')).toEqual(v1Before);
    expect(fakeFiles.put).not.toHaveBeenCalled();
  });

  it('T-INH-1 이어받은 버전에서는 문장을 다시 만들지 않는다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx());
    await service.inheritVersion('doc-1', '1', '2', new Map());
    fakeRag.summarizeTable.mockClear();
    fakeRag.captionImage.mockClear();
    const result = await service.generateHints('doc-1', '2', ctx());
    expect(result.generated).toBe(0);
    expect(fakeRag.summarizeTable).not.toHaveBeenCalled();
    expect(fakeRag.captionImage).not.toHaveBeenCalled();
  });

  it.each([
    ['모르는 ID', new Map([['t9', '문장']])],
    ['공백뿐인 문장', new Map([['t1', '   ']])],
  ])(
    'T-INH-3 %s는 InvalidRequestError이고 새 버전 레코드를 만들지 않는다',
    async (_label, hints) => {
      await prepareHintDoc();
      await service.generateHints('doc-1', '1', ctx());
      await expect(service.inheritVersion('doc-1', '1', '2', hints)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(records('2')).toEqual([]);
    },
  );

  it('T-INH-3 같은 인자로 두 번 부르면 한 번 부른 것과 결과가 같다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx());
    const changed = new Map([['t1', '새 요약']]);
    await service.inheritVersion('doc-1', '1', '2', changed);
    const once = records('2');
    await service.inheritVersion('doc-1', '1', '2', changed);
    expect(records('2')).toEqual(once);
    expect(once).toHaveLength(3);
  });

  it('T-INH-3 이전 버전에 pending이 남았으면 새 버전에서는 description을 임시 설명으로 done 처리한다', async () => {
    await prepareHintDoc();
    await service.inheritVersion('doc-1', '1', '2', new Map());
    for (const row of records('2')) {
      expect(row.hint).toBe(row.description);
      expect(row.isTemporary).toBe(true);
      expect(row.hintStatus).toBe('done');
    }
  });
});

describe('REQ-BE-1.6.3', () => {
  it('T-INH-2 이어받은 이미지는 원래 버전의 파일 키를 가리키고 읽으면 원래 바이트다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx());
    await service.inheritVersion('doc-1', '1', '2', new Map());
    expect(record('i1', '2').fileKey).toBe('doc-1/1/i1.png');
    const image = await service.readImage('doc-1', '2', 'i1');
    expect(image.data).toEqual(PNG_A);
  });
});

describe('REQ-BE-1.7.1', () => {
  it('T-INH-4 임시이면서 다시 만들 수 있는 것만 pending으로 되돌리고 개수를 준다', async () => {
    const md = [TABLE1, '![A](a.png)', '![B](gone.png)', TABLE2].join('\n\n');
    await service.prepareVersion('doc-1', '1', md, [up('a.png', PNG_A)]);
    // t1 요약 실패, 이미지 캡션 실패, 짝 없는 이미지는 임시 설명이다. t2는 성공
    fakeRag.summarizeTable.mockRejectedValueOnce(new RagRequestError(502, 'SUMMARY_FAILED'));
    fakeRag.captionImage.mockRejectedValueOnce(new RagRequestError(502, 'CAPTION_FAILED'));
    await service.generateHints('doc-1', '1', ctx());
    expect(['t1', 'i1', 'i2', 't2'].map((id) => record(id).isTemporary)).toEqual([
      true,
      true,
      true,
      false,
    ]);

    expect(await service.markTemporaryForRegeneration('doc-1', '1')).toBe(2);
    expect(['t1', 'i1', 'i2', 't2'].map((id) => record(id).hintStatus)).toEqual([
      'pending',
      'pending',
      'done',
      'done',
    ]);
    // 재시도로 다시 불러도 같다
    expect(await service.markTemporaryForRegeneration('doc-1', '1')).toBe(2);

    const summarizeBefore = fakeRag.summarizeTable.mock.calls.length;
    const captionBefore = fakeRag.captionImage.mock.calls.length;
    const result = await service.generateHints('doc-1', '1', ctx());
    expect(result.generated).toBe(2);
    expect(fakeRag.summarizeTable.mock.calls.length - summarizeBefore).toBe(1);
    expect(fakeRag.captionImage.mock.calls.length - captionBefore).toBe(1);
  });
});

describe('REQ-BE-6.1.1', () => {
  it('T-LOG-1 끝까지 하나 이상 저장하면 captioning 기록을 정확히 한 번 남긴다', async () => {
    await prepareHintDoc();
    fakeRag.captionImage.mockRejectedValue(new RagRequestError(502, 'CAPTION_FAILED'));
    await service.generateHints('doc-1', '1', ctx());
    expect(fakeLogs.record).toHaveBeenCalledTimes(1);
    expect(fakeLogs.record).toHaveBeenCalledWith({
      kind: 'captioning',
      docId: 'doc-1',
      name: '설계서',
      editionLabel: 'v1',
      outcome: 'success',
      detail: { count: 3, failedCount: 1 },
    });
    const arg = fakeLogs.record.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual([
      'detail',
      'docId',
      'editionLabel',
      'kind',
      'name',
      'outcome',
    ]);
    expect(Object.keys(arg.detail as object).sort()).toEqual(['count', 'failedCount']);
  });

  it('T-LOG-1 stopped이거나 저장한 것이 없으면 기록을 남기지 않는다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx([true, false]));
    expect(fakeLogs.record).not.toHaveBeenCalled();

    await service.prepareVersion('doc-2', '1', '그냥 문단', []);
    await service.generateHints('doc-2', '1', ctx());
    expect(fakeLogs.record).not.toHaveBeenCalled();
  });
});

describe('REQ-BE-2.3', () => {
  it('T-LOG-2 prepared·hints_done 로그는 정해진 필드만 개수로 남긴다', async () => {
    const md = [TABLE1, '![A](img/a.png)', TABLE2, '![B](b.jpg)', '![C](missing.png)'].join('\n\n');
    await service.prepareVersion('doc-1', '1', md, [
      up('a.png', PNG_A),
      up('b.jpg', PNG_B, 'image/jpeg'),
    ]);
    const prepared = eventLines('assets.prepared');
    expect(prepared).toHaveLength(1);
    expect(fieldKeys(prepared[0])).toEqual(['docId', 'images', 'tables', 'unmatched', 'version']);
    expect(prepared[0]).toMatchObject({
      docId: 'doc-1',
      version: '1',
      tables: 2,
      images: 3,
      unmatched: 1,
    });
    expect(prepared[0].level).toBe(30);

    await service.generateHints('doc-1', '1', ctx());
    const done = eventLines('assets.hints_done');
    expect(done).toHaveLength(1);
    expect(fieldKeys(done[0])).toEqual(['docId', 'generated', 'stopped', 'temporary', 'version']);
    expect(done[0]).toMatchObject({
      docId: 'doc-1',
      version: '1',
      generated: 5,
      temporary: 1,
      stopped: false,
    });
    expect(done[0].level).toBe(30);
  });

  it('T-LOG-2 멈춘 실행의 hints_done은 stopped true와 저장한 개수를 남긴다', async () => {
    await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx([true, true, false]));
    const done = eventLines('assets.hints_done');
    expect(done).toHaveLength(1);
    expect(fieldKeys(done[0])).toEqual(['docId', 'generated', 'stopped', 'temporary', 'version']);
    expect(done[0]).toMatchObject({ generated: 2, stopped: true });
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-VIEW-1 listViews는 order 순으로 조회용 모양을 준다', async () => {
    const md = [TABLE1, '![A](a.png)', '![C](missing.png)'].join('\n\n');
    await service.prepareVersion('doc-1', '1', md, [up('a.png', PNG_A)]);
    await service.generateHints('doc-1', '1', ctx());
    const views = await service.listViews('doc-1', '1');
    expect(views.map((view) => view.placeholderId)).toEqual(['t1', 'i1', 'i2']);
    for (const view of views) {
      expect(Object.keys(view).sort()).toEqual([
        'imageUrl',
        'isTemporary',
        'kind',
        'placeholderId',
        'tableMarkdown',
        'text',
      ]);
    }
    expect(views[0]).toEqual({
      placeholderId: 't1',
      kind: 'table',
      tableMarkdown: TABLE1,
      imageUrl: null,
      text: '표 요약',
      isTemporary: false,
    });
    expect(views[1]).toEqual({
      placeholderId: 'i1',
      kind: 'image',
      tableMarkdown: null,
      imageUrl: '/v1/documents/doc-1/versions/1/assets/i1',
      text: '이미지 캡션',
      isTemporary: false,
    });
    expect(views[2]).toEqual({
      placeholderId: 'i2',
      kind: 'image',
      tableMarkdown: null,
      imageUrl: null,
      text: 'C',
      isTemporary: true,
    });
  });
});

describe('REQ-BE-1.4.3', () => {
  it('T-URL-2 imageUrls는 이미지 경로마다 주소나 null을 주고 같은 경로는 키 하나다', async () => {
    const md = [TABLE1, '![a](a.png)', '![d](a.png)', '![x](missing.png)', '![p](__proto__)'].join(
      '\n\n',
    );
    await service.prepareVersion('doc-1', '1', md, [up('a.png', PNG_A)]);
    const urls = await service.imageUrls('doc-1', '1');
    expect(Object.keys(urls).sort()).toEqual(['__proto__', 'a.png', 'missing.png']);
    // 같은 파일을 가리키는 두 자리표시(i1, i2) 중 어느 주소여도 된다
    expect([
      '/v1/documents/doc-1/versions/1/assets/i1',
      '/v1/documents/doc-1/versions/1/assets/i2',
    ]).toContain(urls['a.png']);
    expect(urls['missing.png']).toBeNull();
    // ★ 경로가 __proto__여도 자기 속성이고 프로토타입은 그대로다
    expect(Object.prototype.hasOwnProperty.call(urls, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(urls, '__proto__')?.value).toBeNull();
    expect(Object.getPrototypeOf(urls)).toBe(Object.prototype);
  });
});

describe('REQ-BE-2.4.1', () => {
  /** t1, i1(짝 있음), i2(짝 없음)가 있는 문서를 준비한다. */
  async function prepareImageDoc(): Promise<void> {
    const md = [TABLE1, '![A](a.png)', '![B](gone.png)'].join('\n\n');
    await service.prepareVersion('doc-1', '1', md, [up('a.png', PNG_A)]);
  }

  it('T-IMG-1 readImage는 짝 있는 이미지의 바이트와 contentType을 준다', async () => {
    await prepareImageDoc();
    const image = await service.readImage('doc-1', '1', 'i1');
    expect(image.data).toEqual(PNG_A);
    expect(image.contentType).toBe('image/png');
  });

  it.each([
    ['없는 ID', 'doc-1', '1', 'i99'],
    ['표 ID', 'doc-1', '1', 't1'],
    ['짝 없는 이미지 ID', 'doc-1', '1', 'i2'],
    ['다른 버전', 'doc-1', '9', 'i1'],
  ])('T-IMG-1 %s는 AssetNotFoundError이고 메시지에 키·경로가 없다', async (_l, docId, ver, id) => {
    await prepareImageDoc();
    let caught: unknown;
    try {
      await service.readImage(docId, ver, id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AssetNotFoundError);
    const error = caught as AssetNotFoundError;
    expect(error.code).toBe('ASSET_NOT_FOUND');
    expect(error.message).not.toContain('doc-1/1');
    expect(error.message).not.toContain('a.png');
    expect(error.message).not.toContain('gone.png');
  });

  it('T-IMG-1 파일이 지워진 이미지는 AssetNotFoundError다', async () => {
    await prepareImageDoc();
    store.delete('doc-1/1/i1.png');
    await expect(service.readImage('doc-1', '1', 'i1')).rejects.toBeInstanceOf(AssetNotFoundError);
  });
});

describe('REQ-BE-2.5.1', () => {
  it('T-RST-1 색인용 MD를 복원하면 표 자리에 원본 표가 들어간다', async () => {
    const indexing = await prepareHintDoc();
    await service.generateHints('doc-1', '1', ctx());
    const restored = await service.restore('doc-1', '1', indexing);
    expect(restored).toContain(TABLE1);
    expect(restored).toContain(TABLE2);
    expect(restored).not.toContain('[[minerva:table');
  });
});

describe('REQ-BE-2.5.2', () => {
  it('T-RST-2 짝 있는 이미지는 이스케이프한 ![캡션](주소)이고 이미지 하나로 파싱된다', async () => {
    const indexing = await prepareHintDoc();
    fakeRag.captionImage.mockResolvedValue('a [b] c');
    await service.generateHints('doc-1', '1', ctx());
    const restored = await service.restore('doc-1', '1', indexing);
    const url = '/v1/documents/doc-1/versions/1/assets/i1';
    expect(restored).toContain(`![a \\[b\\] c](${url})`);
    expect(imageSrcs(restored)).toEqual([url]);
  });

  it('T-RST-2 짝 없는 이미지는 캡션 문장만으로 복원된다', async () => {
    const prepared = await service.prepareVersion('doc-1', '1', '앞 ![대체](gone.png) 뒤', []);
    await service.generateHints('doc-1', '1', ctx());
    expect(await service.restore('doc-1', '1', prepared.indexingMarkdown)).toBe('앞 대체 뒤');
  });
});

describe('REQ-BE-2.5.3', () => {
  it('T-RST-3 같은 본문·버전은 같은 결과이고 버전마다 그 버전의 캡션·주소를 쓴다', async () => {
    const indexing = await prepareHintDoc();
    fakeRag.captionImage.mockResolvedValue('첫 캡션');
    await service.generateHints('doc-1', '1', ctx());
    const first = await service.restore('doc-1', '1', indexing);
    expect(await service.restore('doc-1', '1', indexing)).toBe(first);

    await service.inheritVersion('doc-1', '1', '2', new Map([['i1', '바뀐 캡션']]));
    const second = await service.restore('doc-1', '2', indexing);
    expect(first).toContain('![첫 캡션](/v1/documents/doc-1/versions/1/assets/i1)');
    expect(second).toContain('![바뀐 캡션](/v1/documents/doc-1/versions/2/assets/i1)');
  });

  it('T-RST-3 자리표시가 없는 본문은 깨뜨린 문자열만 되돌린다', async () => {
    await prepareHintDoc();
    const restored = await service.restore('doc-1', '1', `일반 문단 [[${ZWSP}minerva:x`);
    expect(restored).toBe('일반 문단 [[minerva:x');
  });
});

describe('REQ-BE-2.2.2', () => {
  it('T-RST-4 원본에 있던 자리표시 모양 문자열은 복원하면 원문 그대로다', async () => {
    const md = ['문단 [[minerva:table:x | y]] 끝', '![a](a.png)'].join('\n\n');
    const prepared = await service.prepareVersion('doc-1', '1', md, [up('a.png', PNG_A)]);
    await service.generateHints('doc-1', '1', ctx());
    const restored = await service.restore('doc-1', '1', prepared.indexingMarkdown);
    expect(restored).toContain('문단 [[minerva:table:x | y]] 끝');
    expect(restored).not.toContain(ZWSP);
  });
});

describe('REQ-BE-1.8.5', () => {
  it('T-DEL-1 deleteDocument는 그 문서의 레코드와 파일만 지우고 다시 불러도 예외가 없다', async () => {
    await prepareHintDoc('doc-1');
    await prepareHintDoc('doc-2');
    await service.deleteDocument('doc-1');
    expect(db.dump('assets').filter((row) => row.docId === 'doc-1')).toEqual([]);
    expect(fakeFiles.deletePrefix).toHaveBeenCalledWith('doc-1/');
    expect(db.dump('assets').filter((row) => row.docId === 'doc-2')).toHaveLength(3);
    expect([...store.keys()]).toEqual(['doc-2/1/i1.png']);
    await expect(service.deleteDocument('doc-1')).resolves.toBeUndefined();
  });

  it('T-DEL-1 레코드 삭제가 실패하면 예외가 나온다', async () => {
    await prepareHintDoc('doc-1');
    db.failNext('deleteMany', new Error('db-down'));
    await expect(service.deleteDocument('doc-1')).rejects.toThrow('db-down');
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-LOG-3 표 칸·대체 텍스트·경로·캡션·문서 이름이 로그에 나오지 않는다', async () => {
    const md = [
      `| h |\n| --- |\n| ${SENTINELS.cell} |`,
      `![${SENTINELS.alt}](${SENTINELS.path})`,
      `![${SENTINELS.alt}b](gone-${SENTINELS.path})`,
    ].join('\n\n');
    const prepared = await service.prepareVersion('doc-1', '1', md, [up(SENTINELS.path, PNG_A)]);
    // 표는 성공(캡션 센티널 응답), 이미지는 RAG 실패로 임시 설명
    fakeRag.summarizeTable.mockResolvedValue(SENTINELS.caption);
    fakeRag.captionImage.mockRejectedValue(new RagRequestError(502, 'CAPTION_FAILED'));
    const context: HintContext = { ...ctx(), name: SENTINELS.name };
    await service.generateHints('doc-1', '1', context);
    await service.restore('doc-1', '1', prepared.indexingMarkdown);

    expect(capture.lines.length).toBeGreaterThan(0);
    const all = capture.lines.join('\n');
    for (const sentinel of [
      SENTINELS.cell,
      SENTINELS.alt,
      'path-sent-73',
      SENTINELS.caption,
      SENTINELS.name,
    ]) {
      expect(all).not.toContain(sentinel);
    }
  });
});
