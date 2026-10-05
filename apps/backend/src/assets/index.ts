// assets 모듈의 공개 표면이다. 다른 모듈은 이 파일로만 assets를 import한다.
// ★ assets 내부 파일은 이 파일을 import하지 않는다 (순환)
export { AssetsModule } from './assets.module';
export { AssetsService } from './services/assets.service';
export type {
  AssetKind,
  UploadedImage,
  PreparedVersion,
  HintRunResult,
  HintContext,
  AssetViewData,
} from './interfaces/assets.types';
