"""search 통합 테스트의 실행 조건과 격리. resource 통합 픽스처를 재사용한다."""

from ..resource.conftest import (  # noqa: F401 — pytest 픽스처를 이 폴더에 등록한다
    isolated_collection,
    it_settings,
    qdrant_ready,
)
