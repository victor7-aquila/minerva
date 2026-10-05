// evaluation 모듈의 공개 표면이다. 다른 모듈은 이 파일로만 evaluation을 import한다.
// ★ evaluation 내부 파일은 이 파일을 import하지 않는다 (순환)
export { EvaluationModule } from './evaluation.module';
