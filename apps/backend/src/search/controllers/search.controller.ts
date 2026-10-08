import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { SearchRequestDto } from '../interfaces/search.dto';
import { SearchService } from '../services/search.service';
import type { SearchResponseView } from '../interfaces/search.types';

/** AI 검색 API다. */
@Controller('v1/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly service: SearchService) {}

  /** 검색 결과를 준다. */
  @Post()
  // ★ Nest의 POST 기본은 201이다
  @HttpCode(200)
  search(@Body() body: SearchRequestDto): Promise<SearchResponseView> {
    return this.service.search(body);
  }
}
