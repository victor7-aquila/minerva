"""요약·캡션 서비스: 작업 없이 바로 처리한다 (REQ-RAG-10.2)."""

from minerva_rag.core import get_logger

from ._guard import Readiness, guarded
from .captioner import Captioner

log = get_logger(__name__)


class CaptionService:
    """표 요약과 이미지 캡션 요청을 Captioner에 넘긴다."""

    def __init__(self, captioner: Captioner, readiness: Readiness) -> None:
        """요약·캡션 생성기와 준비 상태를 받는다. I/O는 하지 않는다."""
        self._captioner = captioner
        self._readiness = readiness

    async def summarize_table(self, table_markdown: str) -> str:
        """표 하나의 요약을 돌려준다."""
        log.info("service.caption.summarize_table", input_chars=len(table_markdown))
        with guarded(log, "caption.summarize_table", self._readiness):
            return await self._captioner.summarize_table(table_markdown)

    async def caption_image(self, image: bytes) -> str:
        """이미지 하나의 캡션을 돌려준다."""
        log.info("service.caption.caption_image", image_bytes=len(image))
        with guarded(log, "caption.caption_image", self._readiness):
            return await self._captioner.caption_image(image)
