import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
} from '@nestjs/common';
import type { Page } from '../../common';
import {
  DocIdParamDto,
  DocumentNamesQueryDto,
  EditDocumentDto,
  ListDocumentsQueryDto,
  ReplacementCheckQueryDto,
  UploadBodyDto,
} from '../interfaces/documents.dto';
import { DocumentsService } from '../services/documents.service';
import type {
  ChunkView,
  DocumentDetailView,
  DocumentRefView,
  DocumentSummaryView,
  OriginalView,
  UploadedDocumentView,
} from '../interfaces/documents.types';
import type { UploadFile } from '../helpers/upload-files';

/** 문서 API다. */
@Controller('v1')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  /** 문서를 올린다. */
  @Post('documents')
  @HttpCode(201)
  upload(
    // ★ FilesInterceptor를 달지 않는다 — api 전역 인터셉터가 req.files를 채운다
    @UploadedFiles() files: UploadFile[] | undefined,
    @Body() body: UploadBodyDto,
  ): Promise<{ documents: UploadedDocumentView[] }> {
    return this.documents.upload(files, body.meta);
  }

  /** 문서 목록을 준다. */
  @Get('documents')
  list(@Query() query: ListDocumentsQueryDto): Promise<Page<DocumentSummaryView>> {
    return this.documents.list(query);
  }

  /** 문서 이름 목록을 준다. */
  @Get('document-names')
  names(@Query() query: DocumentNamesQueryDto): Promise<{ items: string[] }> {
    return this.documents.names(query);
  }

  /** 같은 판이 되는 문서를 준다. ★ :doc_id 경로보다 먼저 선언한다 */
  @Get('documents/replacement-check')
  replacementCheck(
    @Query() query: ReplacementCheckQueryDto,
  ): Promise<{ replaces: DocumentRefView[] }> {
    return this.documents.replacementCheck(query);
  }

  /** 문서 하나를 준다. */
  @Get('documents/:doc_id')
  detail(@Param() params: DocIdParamDto): Promise<DocumentDetailView> {
    return this.documents.getDetail(params.doc_id);
  }

  /** 원본 MD를 준다. */
  @Get('documents/:doc_id/original')
  original(@Param() params: DocIdParamDto): Promise<OriginalView> {
    return this.documents.getOriginal(params.doc_id);
  }

  /** 검색에 쓰이는 청크를 준다. */
  @Get('documents/:doc_id/chunks')
  chunks(@Param() params: DocIdParamDto): Promise<{ items: ChunkView[] }> {
    return this.documents.getChunks(params.doc_id);
  }

  /** 문서를 고친다. */
  @Patch('documents/:doc_id')
  edit(@Param() params: DocIdParamDto, @Body() body: EditDocumentDto): Promise<DocumentDetailView> {
    return this.documents.edit(params.doc_id, body);
  }

  /** 내용을 다시 올린다. */
  @Post('documents/:doc_id/contents')
  @HttpCode(202)
  uploadContents(
    @Param() params: DocIdParamDto,
    @UploadedFiles() files: UploadFile[] | undefined,
  ): Promise<UploadedDocumentView> {
    return this.documents.uploadContents(params.doc_id, files);
  }

  /** 재색인한다. */
  @Post('documents/:doc_id/reindex')
  @HttpCode(202)
  reindex(@Param() params: DocIdParamDto): Promise<void> {
    return this.documents.reindex(params.doc_id);
  }

  /** 실패 문서를 색인 대기로 바꾼다. */
  @Post('documents/:doc_id/queue')
  @HttpCode(202)
  requeue(@Param() params: DocIdParamDto): Promise<void> {
    return this.documents.requeue(params.doc_id);
  }

  /** 문서를 지운다. */
  @Delete('documents/:doc_id')
  @HttpCode(204)
  remove(@Param() params: DocIdParamDto): Promise<void> {
    return this.documents.remove(params.doc_id);
  }
}
