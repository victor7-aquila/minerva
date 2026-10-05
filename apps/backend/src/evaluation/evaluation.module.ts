import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import { EvaluationController } from './controllers/evaluation.controller';
import { EvaluationClock } from './services/evaluation-clock';
import { EvaluationCrudService } from './services/evaluation-crud.service';
import { EvaluationTasks } from './services/evaluation-tasks';
import { EvaluationService } from './services/evaluation.service';

/** 평가 모듈이다. */
@Module({
  imports: [StorageModule, DocumentsModule, RagModule],
  controllers: [EvaluationController],
  providers: [EvaluationService, EvaluationCrudService, EvaluationTasks, EvaluationClock],
})
export class EvaluationModule {}
