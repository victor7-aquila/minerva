"""resource 통합 테스트의 실행 조건과 격리. 환경이 없으면 skip한다 (실패가 아니다)."""

import asyncio
import os
from collections.abc import Iterator
from uuid import uuid4

import ollama
import pytest
from qdrant_client import AsyncQdrantClient

import minerva_rag.resource.chunk_store as chunk_store_module
from minerva_rag.core import Settings, get_settings


@pytest.fixture(scope="session")
def it_settings() -> Settings:
    """실제 환경의 설정을 읽는다. 설정이 없으면 건너뛴다."""
    try:
        return get_settings()
    except RuntimeError:
        pytest.skip("RAG Server 설정이 없어 통합 테스트를 건너뜁니다")


@pytest.fixture(scope="session")
def qdrant_ready(it_settings: Settings) -> None:
    """Qdrant에 닿지 않으면 건너뛴다."""

    async def probe() -> None:
        client = AsyncQdrantClient(url=it_settings.qdrant_url, check_compatibility=False, timeout=3)
        try:
            await client.get_collections()
        finally:
            await client.close()

    try:
        asyncio.run(probe())
    except Exception:
        pytest.skip("Qdrant에 연결할 수 없어 통합 테스트를 건너뜁니다")


@pytest.fixture(scope="session")
def ollama_ready(it_settings: Settings) -> None:
    """Ollama에 닿지 않으면 건너뛴다."""

    async def probe() -> None:
        await ollama.AsyncClient(host=it_settings.ollama_url, timeout=3).list()

    try:
        asyncio.run(probe())
    except Exception:
        pytest.skip("Ollama에 연결할 수 없어 통합 테스트를 건너뜁니다")


@pytest.fixture(scope="session")
def models_opt_in() -> None:
    """MINERVA_IT_MODELS=1일 때만 실제 모델 테스트를 돌린다 (수 GB를 내려받을 수 있다)."""
    # ★ RAG_ 접두사를 쓰지 않는다 (설정 키 공간)
    if os.environ.get("MINERVA_IT_MODELS") != "1":
        pytest.skip("MINERVA_IT_MODELS=1이 아니어서 실제 모델 테스트를 건너뜁니다")


async def assert_isolated(settings: Settings, name: str) -> None:
    """★ 고유 이름 컬렉션이 실제로 만들어졌는지 확인한다 (격리가 풀린 사고를 막는다)."""
    client = AsyncQdrantClient(url=settings.qdrant_url, check_compatibility=False, timeout=3)
    try:
        assert await client.collection_exists(name), "고유 이름 컬렉션이 없다: 격리가 풀렸다"
    finally:
        await client.close()


@pytest.fixture
def isolated_collection(
    monkeypatch: pytest.MonkeyPatch, it_settings: Settings, qdrant_ready: None
) -> Iterator[str]:
    """테스트마다 고유한 컬렉션 이름을 쓰고, 끝나면 지운다. 실제 컬렉션은 건드리지 않는다."""
    name = f"it_minerva_chunks_{uuid4().hex}"
    monkeypatch.setattr(chunk_store_module, "_COLLECTION_NAME", name)
    yield name
    # 아래 정리 코드는 고유 이름만 지운다. 격리가 풀렸는지는 테스트 안의 assert_isolated가 본다

    async def cleanup() -> None:
        client = AsyncQdrantClient(url=it_settings.qdrant_url, check_compatibility=False, timeout=3)
        try:
            await client.delete_collection(name)
        except Exception:
            pass  # 정리 실패는 무시한다
        finally:
            await client.close()

    asyncio.run(cleanup())
