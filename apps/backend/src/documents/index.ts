// documents 모듈의 공개 표면이다. 다른 모듈은 이 파일로만 documents를 import한다.
// ★ documents 내부 파일은 이 파일을 import하지 않는다 (순환)
export { DocumentsModule } from './documents.module';
export { DocumentsService } from './services/documents.service';
export type { DocumentRefData, EvaluationTarget } from './interfaces/documents.types';
