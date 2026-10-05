import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AssetsService } from '../../assets';
import { RagUnavailableError } from '../../common';
import { DocumentsService } from '../../documents';
import { RagClient, RagRequestError } from '../../rag';
import type { RagSearchRequest, RagSearchResult } from '../../rag';
import {
  countChars,
  keepVisible,
  normalizeNames,
  otherEditionFlags,
  toRagSearchRequest,
  toSearchResultView,
} from '../helpers/search-results';
import { SearchRequestDto } from '../interfaces/search.dto';
import type { RestoredTexts, SearchResponseView } from '../interfaces/search.types';

/** 검색 서비스다. */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AssetsService) private readonly assets: AssetsService,
    @Inject(RagClient) private readonly rag: RagClient,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('SearchService');
  }

  /** 검색하고 결과를 복원해 돌려준다. */
  async search(body: SearchRequestDto): Promise<SearchResponseView> {
    const startedAt = performance.now();
    let docIds: string[] | undefined;
    if (body.names !== undefined && body.names !== null) {
      docIds = await this.documents.resolveNames(normalizeNames(body.names));
      // ★ 이름 범위가 비면 RAG Server를 부르지 않는다
      if (docIds.length === 0) return this.done(body, startedAt, 0, 0, []);
    }

    const ragResults = await this.callRag(toRagSearchRequest(body, docIds));
    const visible =
      ragResults.length === 0
        ? new Set<string>()
        : await this.documents.visibleDocIds([...new Set(ragResults.map((r) => r.docId))]);

    const kept = keepVisible(ragResults, visible);
    const flags = otherEditionFlags(kept);
    const restored = await Promise.all(kept.map((r) => this.restoreResult(r)));
    const results = kept.map((r, i) => toSearchResultView(r, i + 1, restored[i], flags[i]));
    return this.done(body, startedAt, ragResults.length, ragResults.length - kept.length, results);
  }

  /** RAG Server에 검색을 요청한다. 그 밖의 오류 응답은 RagUnavailableError로 바꾼다. */
  private async callRag(request: RagSearchRequest): Promise<RagSearchResult[]> {
    try {
      return await this.rag.search(request);
    } catch (error) {
      // ★ RagRequestError(4xx·5xx)는 그대로 두면 500이 된다
      if (error instanceof RagRequestError) throw new RagUnavailableError();
      throw error;
    }
  }

  /** 결과 하나의 본문을 그 결과의 버전으로 복원한다. */
  private async restoreResult(result: RagSearchResult): Promise<RestoredTexts> {
    // ★ 버전은 늘 그 결과의 version이다
    const restore = (texts: readonly { text: string }[]): Promise<string[]> =>
      Promise.all(texts.map((c) => this.assets.restore(result.docId, result.version, c.text)));
    const [chunks, before, after] = await Promise.all([
      restore(result.chunks),
      restore(result.before),
      restore(result.after),
    ]);
    return { chunks, before, after };
  }

  /** 완료 로그를 남기고 응답을 만든다. 질의·이름·본문은 로그에 넣지 않는다. */
  private done(
    body: SearchRequestDto,
    startedAt: number,
    ragResults: number,
    removed: number,
    results: SearchResponseView['results'],
  ): SearchResponseView {
    this.logger.info(
      {
        queryChars: countChars(body.query),
        names: Array.isArray(body.names) ? body.names.length : null,
        ragResults,
        removed,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      'search.done',
    );
    return { results };
  }
}
