import 'reflect-metadata';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MulterModule } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { AssetsModule } from '../assets';
import { CommonModule } from '../common';
import { DocumentsModule } from '../documents';
import { EvaluationModule } from '../evaluation';
import { IndexingModule } from '../indexing';
import { LogsModule } from '../logs';
import { RagModule } from '../rag';
import { SearchModule } from '../search';
import { StorageModule } from '../storage';
import { AppModule, DomainErrorFilter } from './index';
import * as barrel from './index';
import { MultipartLimitInterceptor } from './interceptors/multipart-limit.interceptor';

/** provider 메타데이터 한 항목의 모양이다. */
interface ProviderMeta {
  provide?: unknown;
  useClass?: unknown;
}

describe('REQ-BE-7.1.1', () => {
  // ★ contract·unused 도구가 없어 공개 표면을 여기서 보완 검증한다
  it('T-SURF-1 배럴의 값 export는 AppModule과 DomainErrorFilter뿐이다', () => {
    expect(Object.keys(barrel).sort()).toEqual(['AppModule', 'DomainErrorFilter']);
    expect(barrel.DomainErrorFilter).toBe(DomainErrorFilter);
  });

  it('T-SURF-2 AppModule이 CommonModule을 첫 항목으로 모든 기능 모듈·EventEmitterModule·ScheduleModule·MulterModule을 가져온다', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    // ★ 이후 단계가 이 기대 목록에 자기 모듈을 더한다
    const expected = [
      CommonModule,
      StorageModule,
      RagModule,
      LogsModule,
      AssetsModule,
      IndexingModule,
      DocumentsModule,
      SearchModule,
      EvaluationModule,
    ];
    const plain = imports.filter((item) => typeof item === 'function');
    // 순서는 계약이 아니다. CommonModule만 첫 항목이고 나머지는 집합으로 포함만 본다
    expect(imports[0]).toBe(CommonModule);
    expect(plain).toEqual(expect.arrayContaining(expected));
    const multer = imports.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { module?: unknown }).module === MulterModule,
    );
    expect(multer).toHaveLength(1);
    // ★ 모듈 사이 이벤트(IF-BE-1)용 EventEmitterModule.forRoot()는 앱 전체에 한 번, 전역으로 가져온다
    const emitters = imports.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { module?: unknown }).module === EventEmitterModule,
    );
    expect(emitters).toHaveLength(1);
    expect((emitters[0] as { global?: boolean }).global).not.toBe(false);
    // ★ 주기 작업(documents 기동 처리·상태 맞추기)용 ScheduleModule.forRoot()도 앱 전체에 한 번, 전역으로 가져온다
    const schedulers = imports.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { module?: unknown }).module === ScheduleModule,
    );
    expect(schedulers).toHaveLength(1);
    expect((schedulers[0] as { global?: boolean }).global).not.toBe(false);
  });

  it('T-SURF-3 전역 파이프·필터·인터셉터가 provider로 등록된다', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as ProviderMeta[];
    const pipes = providers.filter((p) => p.provide === APP_PIPE);
    const filters = providers.filter((p) => p.provide === APP_FILTER);
    const interceptors = providers.filter((p) => p.provide === APP_INTERCEPTOR);
    expect(pipes).toHaveLength(1);
    expect(filters).toHaveLength(1);
    expect(filters[0].useClass).toBe(DomainErrorFilter);
    expect(interceptors).toHaveLength(1);
    expect(interceptors[0].useClass).toBe(MultipartLimitInterceptor);
  });
});
