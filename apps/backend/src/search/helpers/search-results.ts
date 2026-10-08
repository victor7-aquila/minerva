import type { RagSearchRequest, RagSearchResult } from '../../rag';
import type { SearchRequestDto } from '../interfaces/search.dto';
import type { RestoredTexts, SearchResultView } from '../interfaces/search.types';

/** 이름마다 앞뒤 공백을 뗀다. */
export function normalizeNames(names: readonly string[]): string[] {
  return names.map((name) => name.trim());
}

/** 요청 본문을 RAG Server 검색 요청으로 바꾼다. docIds가 undefined면 이름 범위가 없다. */
export function toRagSearchRequest(
  body: SearchRequestDto,
  docIds: readonly string[] | undefined,
): RagSearchRequest {
  const editionScope = body.edition_scope ?? 'all';
  // ★ 값이 없는 키는 undefined로도 두지 않고 조건부로 더한다
  const request: RagSearchRequest = {
    query: body.query,
    editionScope,
    expandNeighbors: body.expand_neighbors ?? false,
  };
  if (typeof body.top_n === 'number') request.topN = body.top_n;
  if (docIds !== undefined) request.docIds = [...docIds];
  if (editionScope === 'specific' && body.edition) {
    request.edition = { name: body.edition.name.trim(), label: body.edition.label.trim() };
  }
  return request;
}

/** RAG 순위 순으로 정렬하고 보이는 문서의 결과만 남긴다. */
export function keepVisible(
  results: readonly RagSearchResult[],
  visible: ReadonlySet<string>,
): RagSearchResult[] {
  // ★ sort는 안정 정렬이라 같은 rank는 받은 순서를 지킨다
  return [...results].sort((a, b) => a.rank - b.rank).filter((r) => visible.has(r.docId));
}

/** 두 결과가 같은 판인지 본다. 판 정보가 없으면 같은 판으로 치지 않는다. */
function sameEdition(a: RagSearchResult, b: RagSearchResult): boolean {
  return a.edition !== null && b.edition !== null && a.edition.label === b.edition.label;
}

/** 남은 결과마다 같은 이름의 다른 판 결과가 함께 있는지 다시 계산한다. */
export function otherEditionFlags(results: readonly RagSearchResult[]): boolean[] {
  return results.map((r, i) => {
    if (r.edition === null || !r.otherEditionsInResults) return false;
    return results.some((s, j) => j !== i && s.name === r.name && !sameEdition(r, s));
  });
}

/** RAG 결과 하나를 응답 형태로 바꾼다. */
export function toSearchResultView(
  result: RagSearchResult,
  rank: number,
  restored: RestoredTexts,
  otherEditions: boolean,
): SearchResultView {
  return {
    rank,
    score: result.score,
    doc_id: result.docId,
    name: result.name,
    edition:
      result.edition === null
        ? null
        : {
            label: result.edition.label,
            edition_date: result.edition.editionDate,
            // ★ RAG 값 그대로 쓴다
            is_latest: result.edition.isLatest,
            other_editions_in_results: otherEditions,
          },
    heading_path: [...result.headingPath],
    // ★ 줄바꿈 하나로 잇는다
    markdown: restored.chunks.join('\n'),
    before: [...restored.before],
    after: [...restored.after],
  };
}

/** 문자열의 글자(코드 포인트) 수를 센다. */
export function countChars(text: string): number {
  return [...text].length;
}
