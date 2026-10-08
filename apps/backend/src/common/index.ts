// common 모듈의 공개 표면이다. 다른 모듈은 이 파일로만 common을 import한다.
// ★ common 내부 파일은 이 파일을 import하지 않는다 (순환)
export { CommonModule } from './common.module';
export type { AppConfig } from './interfaces/app-config';
export {
  DomainError,
  InvalidRequestError,
  UnsupportedFileError,
  PayloadTooLargeError,
  UnauthorizedError,
  DocumentNotFoundError,
  AssetNotFoundError,
  GoldenSetNotFoundError,
  DocumentLockedError,
  DocumentNotSearchableError,
  AnswerSpanNotFoundError,
  EvaluationInProgressError,
  RagUnavailableError,
} from './interfaces/domain-errors';
export type { ErrorCode } from './interfaces/domain-errors';
export type { ProcessingState, SearchState } from './interfaces/document-state';
// ★ libs/utils의 kstDayRange(RangeError)를 도메인 오류로 바꾸는 얇은 래퍼다
export { parseKstDayRange } from './helpers/parse-kst-day-range';
