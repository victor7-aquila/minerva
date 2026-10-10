"""엔드포인트: 요청을 service 입력으로 옮기고 결과를 API.md 응답 형식으로 돌려준다 (REQ-RAG-9.1.1).

★ 라우트 함수에는 try/except를 두지 않는다. 예외 변환은 errors.py의 전역 처리기가 한다.
"""

from typing import Annotated

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from minerva_rag.core import PayloadTooLargeError, Settings, get_logger
from minerva_rag.service import Services

from . import schemas

log = get_logger(__name__)


def _log_too_large(request: Request, size: int, limit: int) -> None:
    """크기 한도 초과를 경로·바이트 수·한도만 담아 남긴다."""
    log.warning("api.payload_too_large", path=request.url.path, bytes=size, limit=limit)


def register_routes(app: FastAPI, services: Services, settings: Settings) -> None:
    """service와 크기 한도를 쥔 엔드포인트 12개를 앱에 등록한다."""
    # ★ include_router를 쓰지 않고 앱에 직접 등록한다 (app.routes에 라우트가 그대로 보이도록)

    @app.post("/v1/captions/table")
    async def summarize_table(body: schemas.TableCaptionBody) -> Response:
        """표 요약을 만든다."""
        summary = await services.caption.summarize_table(body.table_markdown)
        return JSONResponse({"summary": summary})

    @app.post("/v1/captions/image")
    async def caption_image(request: Request, image: Annotated[UploadFile, File()]) -> Response:
        """이미지 캡션을 만든다. 파트의 Content-Type과 파일 이름은 쓰지 않는다."""
        # ★ 한도 + 1바이트까지만 읽어 크기를 판정한다 (사전 검사가 큰 본문을 이미 막았다)
        data = await image.read(settings.max_image_bytes + 1)
        if len(data) > settings.max_image_bytes:
            _log_too_large(request, len(data), settings.max_image_bytes)
            raise PayloadTooLargeError()
        caption = await services.caption.caption_image(data)
        return JSONResponse({"caption": caption})

    @app.post("/v1/index-jobs")
    async def submit_index_job(request: Request, body: schemas.IndexJobBody) -> Response:
        """색인을 요청한다. queued·joined는 202, reused는 200이다."""
        size = len(body.markdown.encode("utf-8"))
        if size > settings.max_markdown_bytes:
            _log_too_large(request, size, settings.max_markdown_bytes)
            raise PayloadTooLargeError()
        accepted = await services.index.submit(body.to_request())
        status = 200 if accepted.outcome == "reused" else 202
        return JSONResponse(schemas.accepted_payload(accepted), status_code=status)

    @app.get("/v1/index-jobs/{job_id}")
    async def get_index_job(job_id: str) -> Response:
        """작업 상태를 조회한다."""
        job = await services.index.get_job(job_id)
        return JSONResponse(schemas.job_payload(job))

    @app.delete("/v1/documents/{doc_id}")
    async def delete_document(doc_id: str) -> Response:
        """문서의 모든 버전 청크를 지운다."""
        await services.delete.delete(doc_id)
        return Response(status_code=204)

    @app.post("/v1/documents/index-states")
    async def get_index_states(body: schemas.IndexStatesBody) -> Response:
        """여러 문서의 색인 상태를 조회한다."""
        states = await services.index.index_states(body.doc_ids)
        return JSONResponse({"items": [schemas.index_state_payload(state) for state in states]})

    @app.get("/v1/documents/{doc_id}/index-state")
    async def get_index_state(doc_id: str) -> Response:
        """문서 하나의 색인 상태를 조회한다."""
        state = await services.index.index_state(doc_id)
        return JSONResponse(schemas.index_state_payload(state))

    @app.put("/v1/documents/{doc_id}/metadata")
    async def update_metadata(doc_id: str, body: schemas.MetadataBody) -> Response:
        """문서의 이름과 판 정보를 바꾼다."""
        edition = body.edition.to_edition() if body.edition is not None else None
        await services.metadata.update(doc_id, body.name, edition)
        return Response(status_code=204)

    @app.get("/v1/documents/{doc_id}/chunks")
    async def get_document_chunks(doc_id: str) -> Response:
        """문서의 지금 검색되는 청크를 문서 안 순서대로 조회한다."""
        chunks = await services.search.document_chunks(doc_id)
        return JSONResponse(schemas.document_chunks_payload(chunks))

    @app.post("/v1/search")
    async def search(body: schemas.SearchBody) -> Response:
        """질의와 관련된 결과를 상위 N개 돌려준다."""
        hits = await services.search.search(body.to_query())
        return JSONResponse({"results": [schemas.search_result_payload(hit) for hit in hits]})

    @app.post("/v1/evaluations")
    async def evaluate(body: schemas.EvaluationBody) -> Response:
        """골든셋 한 건을 평가한다."""
        result = await services.evaluation.evaluate(body.to_case())
        return JSONResponse(schemas.evaluation_payload(result))

    @app.get("/v1/health")
    async def health() -> Response:
        """Qdrant·Ollama 연결 상태를 돌려준다. 준비 전에도 200이다."""
        return JSONResponse(schemas.health_payload(await services.lifecycle.health()))
