"""REQ-RAG-3.5 중복 색인 방지: 체크섬과 합류·재사용·새 접수 결정."""

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class IndexDecision:
    """중복 색인 방지 결정이다."""

    kind: Literal["join", "reuse", "submit"]
    job_id: str | None


def compute_checksum(
    markdown: str,
    assets: Mapping[str, str],
    chunking_mode: str,
    *,
    chunk_max_tokens: int,
    embedding_model: str,
) -> str:
    """다섯 재료로 프로세스와 무관하게 같은 체크섬을 만든다."""
    payload = {
        "v": 1,  # ★ 재료가 바뀌면 올린다
        "markdown": markdown,
        "assets": sorted([key, value] for key, value in assets.items()),
        "chunking_mode": str(chunking_mode),  # ★ StrEnum이 와도 값 문자열
        "chunk_max_tokens": chunk_max_tokens,
        "embedding_model": embedding_model,
    }
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def decide_index(
    checksum: str,
    *,
    open_job_id: str | None,
    current_job_id: str | None,
    current_checksum: str | None,
    force: bool,
) -> IndexDecision:
    """열린 작업·현재 색인과 체크섬으로 합류·재사용·새 접수를 정한다."""
    if (current_job_id is None) != (current_checksum is None):
        raise ValueError("current_job_id와 current_checksum은 함께 주거나 함께 비워야 합니다")
    if open_job_id is not None:  # force와 무관하게 합류
        return IndexDecision(kind="join", job_id=open_job_id)
    if not force and current_checksum is not None and checksum == current_checksum:
        return IndexDecision(kind="reuse", job_id=current_job_id)
    return IndexDecision(kind="submit", job_id=None)
