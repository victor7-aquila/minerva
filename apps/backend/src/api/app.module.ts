import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { FilesInterceptor, MulterModule } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { AppLoggerModule } from '../../libs/logger';
import { AssetsModule } from '../assets';
import { CommonModule } from '../common';
import { DocumentsModule } from '../documents';
import { EvaluationModule } from '../evaluation';
import { IndexingModule } from '../indexing';
import { LogsModule } from '../logs';
import { RagModule } from '../rag';
import { SearchModule } from '../search';
import { StorageModule } from '../storage';
import { DomainErrorFilter } from './filters/domain-error.filter';
import { createMulterOptions } from './helpers/multer-options';
import {
  MultipartLimitInterceptor,
  UPLOAD_FIELD,
  UPLOAD_FILES_INTERCEPTOR,
} from './interceptors/multipart-limit.interceptor';
import { createValidationPipe } from './helpers/validation';

/** 앱 모듈이다. 모든 기능 모듈을 조립한다. */
@Module({
  imports: [
    // ★ 첫 줄 고정 — 설정을 전역으로 준다
    CommonModule,
    // ★ 로거는 라이브러리(libs/logger)의 전역 모듈이다. 설정(CommonModule) 다음에 가져온다
    AppLoggerModule,
    // ★ 모듈 사이 이벤트·주기 작업은 앱 전체에 한 번만 가져온다. 기능 모듈은 forRoot를 부르지 않는다
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    StorageModule,
    RagModule,
    LogsModule,
    AssetsModule,
    IndexingModule,
    DocumentsModule,
    SearchModule,
    EvaluationModule,
    MulterModule.register(createMulterOptions()),
  ],
  providers: [
    // ★ 전역 처리는 DI provider로 건다. e2e가 AppModule만 올려도 같게 걸린다
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    { provide: UPLOAD_FILES_INTERCEPTOR, useClass: FilesInterceptor(UPLOAD_FIELD) },
    { provide: APP_INTERCEPTOR, useClass: MultipartLimitInterceptor },
  ],
})
export class AppModule {}
