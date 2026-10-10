"""표 요약과 이미지 캡션을 만든다 (REQ-RAG-10.2.2, REQ-RAG-10.2.3)."""

from minerva_rag.core import (
    CaptionFailedError,
    ModelUnavailableError,
    PromptTooLongError,
    get_logger,
)
from minerva_rag.resource import LlmRole, ModelHub

log = get_logger(__name__)

# ★ 표 Markdown에 중괄호가 있을 수 있어 str.format을 쓰지 않고 이어 붙인다
_TABLE_INSTRUCTION = (
    "다음 Markdown 표의 내용을 한국어 한 문단으로 요약하세요. 표가 무엇을 정리했는지와 "
    "핵심 값을 담고, 목록·제목·Markdown 서식 없이 문장만 쓰세요.\n\n표:\n"
)
_IMAGE_INSTRUCTION = (
    "이 이미지를 한국어 한 문단으로 설명하세요. 이미지에 담긴 내용과, 글자가 있으면 그 핵심을 "
    "담고, 목록·제목·Markdown 서식 없이 문장만 쓰세요."
)


class Captioner:
    """표 요약과 이미지 캡션을 만든다."""

    def __init__(self, model_hub: ModelHub) -> None:
        """모델 허브를 받는다. I/O는 하지 않는다."""
        self._model_hub = model_hub

    async def summarize_table(self, table_markdown: str) -> str:
        """표 하나를 요약한 한 문단을 돌려준다."""
        return await self._generate(
            LlmRole.TABLE_SUMMARY,
            _TABLE_INSTRUCTION + table_markdown,
            image=None,
            size={"kind": "table", "input_chars": len(table_markdown)},
        )

    async def caption_image(self, image: bytes) -> str:
        """이미지 하나를 설명한 한 문단을 돌려준다."""
        return await self._generate(
            LlmRole.IMAGE_CAPTION,
            _IMAGE_INSTRUCTION,
            image=image,
            size={"kind": "image", "image_bytes": len(image)},
        )

    async def _generate(
        self, role: LlmRole, prompt: str, *, image: bytes | None, size: dict[str, str | int]
    ) -> str:
        """모델로 생성해 공백을 다듬는다. 실패나 빈 응답은 CaptionFailedError다."""
        try:
            text = await self._model_hub.generate(role, prompt, image=image)
        except ModelUnavailableError:
            raise  # ★ 연결 불가는 바꾸지 않는다 (REQ-RAG-12.1.2)
        except PromptTooLongError as exc:
            # 입력이 커서 생성하지 못한 경우다. 표를 잘라 요약하지 않는다
            log.warning("service.caption_failed", **size)
            raise CaptionFailedError() from exc
        except Exception as exc:
            # ★ 그 밖의 생성 오류도 같게 다룬다. 원인은 예외 체인(__cause__)에 남기고,
            #   로그 필드는 명세의 허용 범위(kind·크기)를 넘기지 않는다
            log.warning("service.caption_failed", **size)
            raise CaptionFailedError() from exc
        result = text.strip()
        if not result:
            log.warning("service.caption_failed", **size)
            raise CaptionFailedError()
        return result
