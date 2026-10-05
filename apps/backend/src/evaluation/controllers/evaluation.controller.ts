import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Page } from '../../../libs/utils';
import {
  CreateGoldenSetDto,
  GoldenSetIdParamDto,
  ListGoldenSetsQueryDto,
} from '../interfaces/evaluation.dto';
import type { EvaluationSummaryView, GoldenSetView } from '../interfaces/evaluation.types';
import { EvaluationService } from '../services/evaluation.service';

/** 골든셋·평가 API다. */
@Controller('v1')
export class EvaluationController {
  constructor(@Inject(EvaluationService) private readonly evaluation: EvaluationService) {}

  /** 골든셋 목록을 준다. */
  @Get('golden-sets')
  list(@Query() query: ListGoldenSetsQueryDto): Promise<Page<GoldenSetView>> {
    return this.evaluation.list(query);
  }

  /** 골든셋을 추가한다. */
  @Post('golden-sets')
  @HttpCode(201)
  create(@Body() body: CreateGoldenSetDto): Promise<GoldenSetView> {
    return this.evaluation.create(body);
  }

  /** 모든 골든셋을 다시 평가한다. */
  @Post('golden-sets/evaluate-all')
  @HttpCode(202)
  evaluateAll(): Promise<void> {
    return this.evaluation.evaluateAll();
  }

  /** 골든셋을 지운다. */
  @Delete('golden-sets/:golden_set_id')
  @HttpCode(204)
  remove(@Param() params: GoldenSetIdParamDto): Promise<void> {
    return this.evaluation.remove(params.golden_set_id);
  }

  /** 골든셋 한 건을 다시 평가한다. */
  @Post('golden-sets/:golden_set_id/evaluate')
  @HttpCode(202)
  evaluate(@Param() params: GoldenSetIdParamDto): Promise<void> {
    return this.evaluation.evaluateOne(params.golden_set_id);
  }

  /** 평가 요약을 준다. */
  @Get('evaluation-summary')
  summary(): Promise<EvaluationSummaryView> {
    return this.evaluation.summary();
  }
}
