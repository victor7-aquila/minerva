import { Controller, Get, Header, Inject, Param, StreamableFile } from '@nestjs/common';
import { AssetParamsDto } from '../interfaces/asset-params.dto';
import { AssetsService } from '../services/assets.service';

/** 표·이미지 API다. */
@Controller('v1/documents/:doc_id/versions/:version/assets')
export class AssetsController {
  constructor(@Inject(AssetsService) private readonly assets: AssetsService) {}

  /** 이미지 파일을 준다. */
  @Get(':placeholder_id')
  @Header('X-Content-Type-Options', 'nosniff')
  // ★ SVG 안의 스크립트가 같은 출처에서 돌지 않게 막는다
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  async image(@Param() params: AssetParamsDto): Promise<StreamableFile> {
    const { data, contentType } = await this.assets.readImage(
      params.doc_id,
      params.version,
      params.placeholder_id,
    );
    return new StreamableFile(data, { type: contentType, length: data.length });
  }
}
