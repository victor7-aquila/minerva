import 'reflect-metadata';
import { LogsModule } from '../logs';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import { AssetsController } from './controllers/assets.controller';
import * as barrel from './index';
import { AssetsModule, AssetsService } from './index';
import type {
  AssetKind,
  AssetViewData,
  HintContext,
  HintRunResult,
  PreparedVersion,
  UploadedImage,
} from './index';

/** 두 타입이 정확히 같은지 본다. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

/** AssetsService의 열 가지 메서드 시그니처를 assets MODULE.md 「기능 그룹별 요구사항」의 AssetsService 시그니처와 같은 함수 타입에 대입한다. 컴파일되면 통과다. */
function signatureChecks(svc: AssetsService): unknown[] {
  const prepare: (
    docId: string,
    version: string,
    markdown: string,
    images: readonly UploadedImage[],
  ) => Promise<PreparedVersion> = svc.prepareVersion.bind(svc);
  const generate: (docId: string, version: string, ctx: HintContext) => Promise<HintRunResult> =
    svc.generateHints.bind(svc);
  const inherit: (
    docId: string,
    fromVersion: string,
    toVersion: string,
    changedHints: ReadonlyMap<string, string>,
  ) => Promise<void> = svc.inheritVersion.bind(svc);
  const mark: (docId: string, version: string) => Promise<number> =
    svc.markTemporaryForRegeneration.bind(svc);
  const hints: (
    docId: string,
    version: string,
  ) => Promise<Array<{ placeholderId: string; text: string }>> = svc.hintsFor.bind(svc);
  const views: (docId: string, version: string) => Promise<AssetViewData[]> =
    svc.listViews.bind(svc);
  const urls: (docId: string, version: string) => Promise<Record<string, string | null>> =
    svc.imageUrls.bind(svc);
  const read: (
    docId: string,
    version: string,
    placeholderId: string,
  ) => Promise<{ data: Buffer; contentType: string }> = svc.readImage.bind(svc);
  const restore: (docId: string, version: string, text: string) => Promise<string> =
    svc.restore.bind(svc);
  const remove: (docId: string) => Promise<void> = svc.deleteDocument.bind(svc);
  return [prepare, generate, inherit, mark, hints, views, urls, read, restore, remove];
}

describe('REQ-BE-2.4.1', () => {
  // ★ contract·unused 도구가 없어 공개 표면을 여기서 보완 검증한다
  it('T-SURF-1 배럴의 값 export는 AssetsModule·AssetsService뿐이다', () => {
    expect(Object.keys(barrel).sort()).toEqual(['AssetsModule', 'AssetsService']);
  });

  it('T-SURF-3 AssetsModule은 storage·rag·logs를 가져오고 컨트롤러와 AssetsService를 노출한다', () => {
    const imports = Reflect.getMetadata('imports', AssetsModule) as unknown[];
    expect(imports).toEqual(expect.arrayContaining([StorageModule, RagModule, LogsModule]));
    expect(Reflect.getMetadata('controllers', AssetsModule)).toEqual([AssetsController]);
    expect(Reflect.getMetadata('exports', AssetsModule)).toEqual([AssetsService]);
  });
});

describe('REQ-BE-2.1.1', () => {
  it('T-SURF-2 AssetsService의 열 메서드 시그니처와 공개 타입의 필드가 고정이다', () => {
    // 시그니처 대입은 컴파일 단계에서 검증된다
    expect(typeof signatureChecks).toBe('function');
    expect(
      assertType<
        Equals<
          AssetsService['prepareVersion'],
          (
            docId: string,
            version: string,
            markdown: string,
            images: readonly UploadedImage[],
          ) => Promise<PreparedVersion>
        >
      >(),
    ).toBe(true);
    expect(assertType<Equals<AssetKind, 'table' | 'image'>>()).toBe(true);

    // 필드 전부를 가진 리터럴은 컴파일되고, 필드가 하나 더 있으면 컴파일 오류다
    const image: UploadedImage = {
      fileName: 'a.png',
      contentType: 'image/png',
      data: Buffer.alloc(0),
    };
    const prepared: PreparedVersion = { indexingMarkdown: '', unmatchedImages: [], assetCount: 0 };
    const run: HintRunResult = { generated: 0, temporary: 0, stopped: false };
    const context: HintContext = {
      name: 'n',
      editionLabel: null,
      shouldContinue: async () => true,
    };
    const view: AssetViewData = {
      placeholderId: 't1',
      kind: 'table',
      tableMarkdown: '',
      imageUrl: null,
      text: '',
      isTemporary: false,
    };
    // @ts-expect-error 필드가 하나 더 있다
    const image2: UploadedImage = { ...image, extra: 1 };
    // @ts-expect-error 필드가 하나 더 있다
    const prepared2: PreparedVersion = { ...prepared, extra: 1 };
    // @ts-expect-error 필드가 하나 더 있다
    const run2: HintRunResult = { ...run, extra: 1 };
    // @ts-expect-error 필드가 하나 더 있다
    const context2: HintContext = { ...context, extra: 1 };
    // @ts-expect-error 필드가 하나 더 있다
    const view2: AssetViewData = { ...view, extra: 1 };
    expect([image2, prepared2, run2, context2, view2]).toHaveLength(5);

    const names = Object.getOwnPropertyNames(AssetsService.prototype);
    expect(names).toEqual(
      expect.arrayContaining([
        'constructor',
        'onModuleInit',
        'prepareVersion',
        'generateHints',
        'inheritVersion',
        'markTemporaryForRegeneration',
        'hintsFor',
        'listViews',
        'imageUrls',
        'readImage',
        'restore',
        'deleteDocument',
      ]),
    );
  });

  // ★ contract 도구가 없어 공개 메서드가 몰래 사라지거나 함수가 아니게 되지 않는지 여기서 보완 검증한다.
  // 공개 메서드 11개만 본다 — private 내부 메서드 이름은 구현 자유라 고정하지 않는다
  it('T-PR3-SURF-1 AssetsService 프로토타입에 계획한 공개 메서드 11개가 모두 함수로 있다', () => {
    const publicMethods = [
      'prepareVersion',
      'generateHints',
      'inheritVersion',
      'markTemporaryForRegeneration',
      'hintsFor',
      'listViews',
      'imageUrls',
      'readImage',
      'restore',
      'deleteDocument',
      'onModuleInit',
    ];
    const proto = AssetsService.prototype as unknown as Record<string, unknown>;
    const missing = publicMethods.filter((name) => typeof proto[name] !== 'function');
    expect(missing).toEqual([]);
  });
});

describe('REQ-BE-1.4.4', () => {
  it('T-PR3-SURF-2 AssetViewData와 PreparedVersion의 키 집합이 그대로다', () => {
    // 타입 단언은 컴파일 단계에서 검증된다 — 키가 늘거나 줄면 컴파일 오류다
    expect(
      assertType<
        Equals<
          keyof AssetViewData,
          'placeholderId' | 'kind' | 'tableMarkdown' | 'imageUrl' | 'text' | 'isTemporary'
        >
      >(),
    ).toBe(true);
    expect(
      assertType<
        Equals<keyof PreparedVersion, 'indexingMarkdown' | 'unmatchedImages' | 'assetCount'>
      >(),
    ).toBe(true);
  });
});
