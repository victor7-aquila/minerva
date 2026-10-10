"""chunking 공개 표면(MODULE.md 「공개 표면」·REQ-RAG-2.1 코드 블록) 고정 테스트.

정적 계약 검사 도구가 없어 공개 이름·시그니처를 테스트로 고정한다.
"""

import inspect
from collections.abc import Callable
from enum import StrEnum

import pytest

import minerva_rag.chunking as chunking
from minerva_rag.chunking import Chunker, ChunkingMode
from minerva_rag.core import ChunkingResult, Settings
from minerva_rag.resource import ModelHub

P = inspect.Parameter


def _params(func: Callable[..., object]) -> list[inspect.Parameter]:
    """주석을 해석한 시그니처의 매개변수 목록을 돌려준다."""
    return list(inspect.signature(func, eval_str=True).parameters.values())


@pytest.mark.req("REQ-RAG-2.1.1")
def test_all_exports() -> None:
    """[REQ-RAG-2.1.1] 공개 이름은 Chunker와 ChunkingMode뿐이다."""
    assert set(chunking.__all__) == {"Chunker", "ChunkingMode"}
    assert chunking.Chunker is Chunker
    assert chunking.ChunkingMode is ChunkingMode


@pytest.mark.req("REQ-RAG-2.1.1")
def test_chunking_mode_values() -> None:
    """[REQ-RAG-2.1.1] ChunkingMode는 SEMANTIC="semantic", RULE="rule"만 가진 StrEnum이다."""
    assert issubclass(ChunkingMode, StrEnum)
    assert {m.name: m.value for m in ChunkingMode} == {"SEMANTIC": "semantic", "RULE": "rule"}


@pytest.mark.req("REQ-RAG-2.1.1")
def test_chunker_init_signature() -> None:
    """[REQ-RAG-2.1.1] Chunker(model_hub: ModelHub, settings: Settings) -> None."""
    params = _params(Chunker.__init__)

    assert [p.name for p in params] == ["self", "model_hub", "settings"]
    assert all(p.kind is P.POSITIONAL_OR_KEYWORD for p in params)
    assert all(p.default is P.empty for p in params)
    assert params[1].annotation is ModelHub
    assert params[2].annotation is Settings
    assert inspect.signature(Chunker.__init__, eval_str=True).return_annotation is None


@pytest.mark.req("REQ-RAG-2.1.1")
def test_split_signature() -> None:
    """[REQ-RAG-2.1.1] async def split(markdown: str, mode: ChunkingMode) -> ChunkingResult."""
    params = _params(Chunker.split)

    assert inspect.iscoroutinefunction(Chunker.split)
    assert [p.name for p in params] == ["self", "markdown", "mode"]
    assert all(p.kind is P.POSITIONAL_OR_KEYWORD for p in params)
    assert all(p.default is P.empty for p in params)
    assert params[1].annotation is str
    assert params[2].annotation is ChunkingMode
    assert inspect.signature(Chunker.split, eval_str=True).return_annotation is ChunkingResult
