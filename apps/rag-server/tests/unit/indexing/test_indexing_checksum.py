"""체크섬(Indexer.checksum) 테스트 (REQ-RAG-3.5.2)."""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Mapping
from enum import StrEnum
from pathlib import Path

import pytest

from minerva_rag.core import Settings
from minerva_rag.indexing import Indexer

from .fakes import FakeChunkStore, FakeModelHub, as_hub, as_store

MARKDOWN = "# 설치\n\n[[minerva:table:t1 | 표]]"
ASSETS = {"t1": "요약 A", "i1": "캡션 B"}
MODE = "semantic"


def _checksum(
    settings: Settings,
    *,
    markdown: str = MARKDOWN,
    assets: Mapping[str, str] = ASSETS,
    mode: str = MODE,
    model_name: str = "fake-embed",
) -> str:
    """새 Indexer로 체크섬을 만든다."""
    hub = FakeModelHub(embedding_model_name=model_name)
    return Indexer(as_hub(hub), as_store(FakeChunkStore()), settings).checksum(
        markdown, assets, mode
    )


@pytest.mark.req("REQ-RAG-3.5.2")
def test_same_materials_same_checksum(settings: Settings) -> None:
    """[REQ-RAG-3.5.2] 같은 재료면 새 Indexer로 만들어도 같은 문자열 값이다."""
    first = _checksum(settings)
    second = _checksum(settings)

    assert isinstance(first, str)
    assert first == second


@pytest.mark.req("REQ-RAG-3.5.2")
def test_assets_order_ignored(settings: Settings) -> None:
    """[REQ-RAG-3.5.2] assets의 삽입 순서만 바꾸면 같은 값이다."""
    reordered = {"i1": "캡션 B", "t1": "요약 A"}

    assert _checksum(settings, assets=reordered) == _checksum(settings)


@pytest.mark.req("REQ-RAG-3.5.2")
@pytest.mark.parametrize(
    "material",
    ["markdown", "assets_value", "assets_key", "chunking_mode", "chunk_max", "embedding_model"],
)
def test_each_material_changes_checksum(
    material: str, settings: Settings, make_settings: Callable[..., Settings]
) -> None:
    """[REQ-RAG-3.5.2] 재료 중 하나만 바꿔도 값이 달라진다."""
    base = _checksum(settings)

    changed = {
        "markdown": lambda: _checksum(settings, markdown=MARKDOWN + "."),
        "assets_value": lambda: _checksum(settings, assets={**ASSETS, "t1": "요약 C"}),
        "assets_key": lambda: _checksum(settings, assets={**ASSETS, "i2": "캡션 D"}),
        "chunking_mode": lambda: _checksum(settings, mode="rule"),
        "chunk_max": lambda: _checksum(make_settings(chunk_max=256)),
        "embedding_model": lambda: _checksum(settings, model_name="other-embed"),
    }[material]()

    assert changed != base


class _Mode(StrEnum):
    """chunking의 ChunkingMode처럼 값이 문자열인 열거형이다(chunking을 import하지 않는다)."""

    SEMANTIC = "semantic"


@pytest.mark.req("REQ-RAG-3.5.2")
def test_checksum_accepts_str_enum_mode(settings: Settings) -> None:
    """[REQ-RAG-3.5.2] chunking_mode에 값이 같은 StrEnum 멤버를 넘겨도 문자열과 같은 값이다."""
    hub = FakeModelHub()
    indexer = Indexer(as_hub(hub), as_store(FakeChunkStore()), settings)

    assert indexer.checksum(MARKDOWN, ASSETS, _Mode.SEMANTIC) == indexer.checksum(
        MARKDOWN, ASSETS, "semantic"
    )


_CHILD_SCRIPT = """
import json
import sys

from minerva_rag.core import get_settings
from minerva_rag.indexing import Indexer


class Hub:
    embedding_model_name = "fake-embed"


data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
indexer = Indexer(Hub(), object(), get_settings())
sys.stdout.write(indexer.checksum(data["markdown"], data["assets"], data["mode"]))
"""


def _child_checksum(hash_seed: str, tmp_path: Path) -> str:
    """PYTHONHASHSEED를 고정한 하위 프로세스에서 같은 재료의 체크섬을 만든다."""
    env = {**os.environ, "PYTHONHASHSEED": hash_seed, "PYTHONIOENCODING": "utf-8"}
    payload = json.dumps({"markdown": MARKDOWN, "assets": ASSETS, "mode": MODE})
    done = subprocess.run(
        [sys.executable, "-c", _CHILD_SCRIPT],
        input=payload.encode("utf-8"),
        capture_output=True,
        cwd=tmp_path,  # ★ .env를 읽지 않게 빈 폴더에서 실행한다
        env=env,
        timeout=120,
        check=True,
    )
    return done.stdout.decode("utf-8")


@pytest.mark.req("REQ-RAG-3.5.2")
def test_checksum_stable_across_processes(settings: Settings, tmp_path: Path) -> None:
    """[REQ-RAG-3.5.2] 해시 시드가 다른 프로세스에서 만든 값이 서로, 이 프로세스의 값과 같다."""
    first = _child_checksum("1", tmp_path)
    second = _child_checksum("2", tmp_path)

    assert first == second == _checksum(settings)
