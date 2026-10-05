import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AssetNotFoundError, InvalidRequestError, RagUnavailableError } from '../../common';
import { LogsService } from '../../logs';
import { RagClient, RagRequestError } from '../../rag';
import { FILE_STORE } from '../../storage';
import type { FileStore } from '../../storage';
import { AssetsCrudService } from './assets-crud.service';
import type {
  AssetKind,
  AssetRecord,
  AssetViewData,
  HintContext,
  HintRunResult,
  PreparedVersion,
  UploadedImage,
} from '../interfaces/assets.types';
import { contentTypeOf, extensionOf, indexUploads, matchKeysOfPath } from '../helpers/image-files';
import { extractAssets } from '../helpers/markdown-assets';
import type { ExtractedAsset } from '../helpers/markdown-assets';
import {
  imageUrlOf,
  placeholderIdsIn,
  restoreText,
  unbreakPlaceholderLike,
} from '../helpers/placeholder';
import type { RestoreSource } from '../helpers/placeholder';

/** 요약·캡션 하나의 결과다. */
interface ProducedHint {
  hint: string;
  isTemporary: boolean;
}

/** 짝을 맞춘 이미지 파일 정보다. */
interface MatchedFile {
  fileKey: string;
  contentType: string;
  upload: UploadedImage;
}

/** 표·이미지를 다룬다. */
@Injectable()
export class AssetsService implements OnModuleInit {
  constructor(
    @Inject(AssetsCrudService) private readonly repo: AssetsCrudService,
    @Inject(FILE_STORE) private readonly files: FileStore,
    @Inject(RagClient) private readonly rag: RagClient,
    @Inject(LogsService) private readonly logs: LogsService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('AssetsService');
  }

  /** 기동할 때 assets 컬렉션의 인덱스를 맞춘다. */
  async onModuleInit(): Promise<void> {
    await this.repo.ensureIndexes();
  }

  /** 버전의 표·이미지를 준비한다. */
  async prepareVersion(
    docId: string,
    version: string,
    markdown: string,
    images: readonly UploadedImage[],
  ): Promise<PreparedVersion> {
    // ★ 같은 이름이면 여기서 오류를 내며, 아직 아무것도 쓰지 않았다
    const uploads = indexUploads(images);
    const { assets, indexingMarkdown } = extractAssets(markdown);

    const unmatched = new Set<string>();
    const matched = new Map<string, MatchedFile>();
    for (const asset of assets) {
      if (asset.kind !== 'image') continue;
      const file = matchFile(docId, version, asset, uploads);
      if (file === null) unmatched.add(asset.imagePath ?? '');
      else matched.set(asset.placeholderId, file);
    }

    const records = assets.map((asset) => toRecord(docId, version, asset, matched));

    // ★ 재호출해도 같은 결과가 되도록 이전 파일을 지우고, 파일 → 레코드 순으로 쓴다
    await this.files.deletePrefix(`${docId}/${version}/`);
    for (const file of matched.values()) {
      await this.files.put(file.fileKey, file.upload.data);
    }
    await this.repo.replaceVersion(docId, version, records);

    const tables = records.filter((record) => record.kind === 'table').length;
    this.logger.info(
      { docId, version, tables, images: records.length - tables, unmatched: unmatched.size },
      'assets.prepared',
    );
    return {
      indexingMarkdown,
      unmatchedImages: [...unmatched],
      assetCount: records.length,
    };
  }

  /** 요약·캡션을 만든다. */
  async generateHints(docId: string, version: string, ctx: HintContext): Promise<HintRunResult> {
    const pending = await this.repo.findPending(docId, version);
    let generated = 0;
    let temporary = 0;
    let stopped = false;
    for (const record of pending) {
      if (!(await ctx.shouldContinue())) {
        stopped = true;
        break;
      }
      const { hint, isTemporary } = await this.produceHint(docId, version, record);
      // ★ 하나마다 바로 저장한다 (중간에 멈춰도 만든 것은 남는다)
      await this.repo.saveHint(docId, version, record.placeholderId, hint, isTemporary);
      generated += 1;
      if (isTemporary) temporary += 1;
    }
    this.logger.info({ docId, version, generated, temporary, stopped }, 'assets.hints_done');
    if (!stopped && generated > 0) {
      await this.logs.record({
        kind: 'captioning',
        docId,
        name: ctx.name,
        editionLabel: ctx.editionLabel,
        outcome: 'success',
        detail: { count: generated, failedCount: temporary },
      });
    }
    return { generated, temporary, stopped };
  }

  /** 이전 버전의 표·이미지를 이어받는다. */
  async inheritVersion(
    docId: string,
    fromVersion: string,
    toVersion: string,
    changedHints: ReadonlyMap<string, string>,
  ): Promise<void> {
    const from = await this.repo.findByVersion(docId, fromVersion);
    const known = new Set(from.map((record) => record.placeholderId));
    const unknown = [...changedHints.keys()].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new InvalidRequestError('없는 표·이미지의 요약·캡션은 바꿀 수 없습니다');
    }
    if ([...changedHints.values()].some((text) => text.trim() === '')) {
      throw new InvalidRequestError('요약·캡션은 비울 수 없습니다');
    }
    const records = from.map((record): AssetRecord => {
      const changed = changedHints.get(record.placeholderId);
      if (changed !== undefined) {
        return {
          ...record,
          version: toVersion,
          hint: changed,
          isTemporary: false,
          hintStatus: 'done',
        };
      }
      return {
        ...record,
        version: toVersion,
        hint: record.hint ?? record.description,
        isTemporary: record.hint === null ? true : record.isTemporary,
        hintStatus: 'done',
      };
    });
    // ★ 파일은 복사하지 않고 fileKey를 그대로 이어받는다
    await this.repo.replaceVersion(docId, toVersion, records);
  }

  /** 임시 설명을 다시 만들도록 표시한다. */
  markTemporaryForRegeneration(docId: string, version: string): Promise<number> {
    return this.repo.markTemporaryPending(docId, version);
  }

  /** 색인에 넘길 요약·캡션 문장을 준다. */
  async hintsFor(
    docId: string,
    version: string,
  ): Promise<Array<{ placeholderId: string; text: string }>> {
    const records = await this.repo.findByVersion(docId, version);
    return records.map((record) => ({
      placeholderId: record.placeholderId,
      text: record.hint ?? record.description,
    }));
  }

  /** 표·이미지 조회용 목록을 준다. */
  async listViews(docId: string, version: string): Promise<AssetViewData[]> {
    const records = await this.repo.findByVersion(docId, version);
    return records.map((record) => ({
      placeholderId: record.placeholderId,
      kind: record.kind,
      tableMarkdown: record.kind === 'table' ? record.tableMarkdown : null,
      imageUrl: imageUrlFor(docId, version, record),
      text: record.hint ?? record.description,
      isTemporary: record.isTemporary,
    }));
  }

  /** 이미지 경로별 주소를 준다. */
  async imageUrls(docId: string, version: string): Promise<Record<string, string | null>> {
    const records = await this.repo.findByVersion(docId, version);
    const urls = new Map<string, string | null>();
    for (const record of records) {
      if (record.imagePath === null || urls.has(record.imagePath)) continue;
      urls.set(record.imagePath, imageUrlFor(docId, version, record));
    }
    // ★ 경로가 `__proto__`여도 안전하도록 fromEntries로 만든다
    return Object.fromEntries(urls);
  }

  /** 이미지 파일을 읽는다. */
  async readImage(
    docId: string,
    version: string,
    placeholderId: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const record = await this.repo.findOne(docId, version, placeholderId);
    if (record === null || record.kind !== 'image' || record.fileKey === null) {
      throw new AssetNotFoundError();
    }
    const data = await this.files.read(record.fileKey);
    if (data === null) throw new AssetNotFoundError();
    return { data, contentType: record.contentType ?? 'application/octet-stream' };
  }

  /** 본문의 자리표시를 원래 표·이미지로 복원한다. */
  async restore(docId: string, version: string, text: string): Promise<string> {
    const ids = placeholderIdsIn(text);
    if (ids.length === 0) return unbreakPlaceholderLike(text);
    const records = await this.repo.findByIds(docId, version, ids);
    const sources = new Map<string, RestoreSource>(
      records.map((record) => [
        record.placeholderId,
        {
          kind: record.kind,
          tableMarkdown: record.tableMarkdown,
          text: record.hint ?? record.description,
          imageUrl: imageUrlFor(docId, version, record),
        },
      ]),
    );
    return restoreText(text, sources);
  }

  /** 문서의 표·이미지를 모두 지운다. */
  async deleteDocument(docId: string): Promise<void> {
    // ★ 둘 다 멱등이라 중간에 실패해도 다시 부를 수 있다
    await this.repo.deleteByDoc(docId);
    await this.files.deletePrefix(`${docId}/`);
  }

  /** 표·이미지 하나의 요약·캡션을 만든다. RAG 요청 실패는 임시 설명으로 바꾼다. */
  private async produceHint(
    docId: string,
    version: string,
    record: AssetRecord,
  ): Promise<ProducedHint> {
    const fallback = (code: string): ProducedHint => {
      this.logger.warn(
        { docId, version, placeholderId: record.placeholderId, code },
        'assets.hint_failed',
      );
      return { hint: record.description, isTemporary: true };
    };

    let call: () => Promise<string>;
    if (record.kind === 'image') {
      // 짝 없는 이미지는 요청 없이 임시 설명으로 둔다
      if (record.fileKey === null) return { hint: record.description, isTemporary: true };
      const data = await this.files.read(record.fileKey);
      if (data === null) return fallback('FILE_MISSING');
      const fileName = fileNameOfKey(record.fileKey);
      call = () => this.rag.captionImage(data, fileName);
    } else {
      call = () => this.rag.summarizeTable(record.tableMarkdown ?? '');
    }

    let text: unknown;
    try {
      text = await call();
    } catch (error) {
      if (error instanceof RagRequestError) return fallback(error.code);
      if (error instanceof RagUnavailableError) return fallback('RAG_UNAVAILABLE');
      throw error;
    }
    if (typeof text !== 'string' || text.trim() === '') return fallback('EMPTY_RESULT');
    // ★ 다듬지 않고 그대로 저장한다
    return { hint: text, isTemporary: false };
  }
}

/** 파일 키의 마지막 조각(파일 이름)을 돌려준다. */
function fileNameOfKey(fileKey: string): string {
  return fileKey.slice(fileKey.lastIndexOf('/') + 1);
}

/** 이미지 주소를 돌려준다. 파일이 있는 이미지만 주소가 있다. */
function imageUrlFor(docId: string, version: string, record: AssetRecord): string | null {
  const kind: AssetKind = record.kind;
  return kind === 'image' && record.fileKey !== null
    ? imageUrlOf(docId, version, record.placeholderId)
    : null;
}

/** 이미지 하나의 업로드 파일 짝을 찾는다. 없으면 null이다. */
function matchFile(
  docId: string,
  version: string,
  asset: ExtractedAsset,
  uploads: ReadonlyMap<string, UploadedImage>,
): MatchedFile | null {
  const key = matchKeysOfPath(asset.imagePath ?? '').find((candidate) => uploads.has(candidate));
  const upload = key === undefined ? undefined : uploads.get(key);
  if (upload === undefined) return null;
  const ext = extensionOf(upload.fileName);
  return {
    fileKey: `${docId}/${version}/${asset.placeholderId}.${ext}`,
    contentType: contentTypeOf(ext, upload.contentType),
    upload,
  };
}

/** 추출한 표·이미지를 저장용 레코드로 만든다. */
function toRecord(
  docId: string,
  version: string,
  asset: ExtractedAsset,
  matched: ReadonlyMap<string, MatchedFile>,
): AssetRecord {
  const file = matched.get(asset.placeholderId);
  return {
    docId,
    version,
    placeholderId: asset.placeholderId,
    kind: asset.kind,
    order: asset.order,
    tableMarkdown: asset.kind === 'table' ? asset.tableMarkdown : null,
    imagePath: asset.kind === 'image' ? asset.imagePath : null,
    alt: asset.kind === 'image' ? asset.alt : null,
    fileKey: file?.fileKey ?? null,
    contentType: file?.contentType ?? null,
    description: asset.description,
    hint: null,
    hintStatus: 'pending',
    isTemporary: false,
  };
}
