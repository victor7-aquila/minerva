/** 표·이미지 종류다. */
export type AssetKind = 'table' | 'image';

/** 업로드로 받은 이미지 파일이다. */
export interface UploadedImage {
  fileName: string;
  contentType: string;
  data: Buffer;
}

/** 버전 준비 결과다. */
export interface PreparedVersion {
  indexingMarkdown: string;
  unmatchedImages: string[];
  assetCount: number;
}

/** 요약·캡션 생성 결과다. generated는 이번 실행에서 저장한 수(임시 설명 포함), temporary는 그중 임시 설명 수다. */
export interface HintRunResult {
  generated: number;
  temporary: number;
  stopped: boolean;
}

/** 요약·캡션 생성 중 진행 여부와 기록에 쓰는 문서 정보다. */
export interface HintContext {
  name: string;
  editionLabel: string | null;
  shouldContinue(): Promise<boolean>;
}

/** 표·이미지 하나의 조회용 모양이다. API.md AssetView의 원천이다. */
export interface AssetViewData {
  placeholderId: string;
  kind: AssetKind;
  tableMarkdown: string | null;
  imageUrl: string | null;
  text: string;
  isTemporary: boolean;
}

// ── 아래는 내부용. 배럴로 내보내지 않는다 ──

/** assets 컬렉션 이름이다. */
export const ASSETS_COLLECTION = 'assets';

/** 요약·캡션 상태다. */
export type HintStatus = 'pending' | 'done';

/** 글자 위치 범위다. UTF-16 오프셋이고 end는 제외한다. */
export interface TextRange {
  start: number;
  end: number;
}

/** MongoDB assets에 저장하는 표·이미지 하나다. MODULE.md 「데이터 계약」과 같다. */
export interface AssetRecord {
  docId: string;
  version: string;
  placeholderId: string;
  kind: AssetKind;
  /** 원본에 나오는 차례. 1부터 */
  order: number;
  tableMarkdown: string | null;
  imagePath: string | null;
  alt: string | null;
  fileKey: string | null;
  contentType: string | null;
  description: string;
  hint: string | null;
  hintStatus: HintStatus;
  isTemporary: boolean;
  /** 표 안 이미지면 그 표의 placeholderId, 아니면 null이다. ★ 저장된 옛 레코드에는 없다 — null로 읽는다 */
  tableId: string | null;
  /** 표 안 이미지 경로 글자의 그 표 tableMarkdown 기준 위치다. 모르거나 표 밖이면 null이다 */
  pathInTable: TextRange | null;
}
