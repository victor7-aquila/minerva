import { Module } from '@nestjs/common';
import { RagModule } from '../rag';
import { StorageModule } from '../storage';
import { AssetsController } from './controllers/assets.controller';
import { AssetsCrudService } from './services/assets-crud.service';
import { AssetsService } from './services/assets.service';

/** 표·이미지 모듈이다. */
@Module({
  imports: [StorageModule, RagModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetsCrudService],
  exports: [AssetsService],
})
export class AssetsModule {}
