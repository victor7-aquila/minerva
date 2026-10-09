"""ModelHub 통합 테스트 (실제 Ollama·모델 파일). MINERVA_IT_MODELS=1일 때만 돈다."""

import asyncio

import pytest

from minerva_rag.core import Settings
from minerva_rag.resource import LlmRole, ModelHub


@pytest.mark.req("REQ-RAG-12.1.1")
def test_it_prepare_with_real_models(
    it_settings: Settings, ollama_ready: None, models_opt_in: None
) -> None:
    """[REQ-RAG-12.1.1] 실제 모델로 prepare가 성공하고 임베딩 길이가 차원과 같다."""

    async def scenario() -> None:
        hub = ModelHub(it_settings)
        try:
            await hub.prepare()
            assert hub.embedding_dimension > 0
            assert len(await hub.embed_query("테스트")) == hub.embedding_dimension
        finally:
            await hub.close()

    asyncio.run(scenario())


@pytest.mark.req("REQ-RAG-2.1.1")
def test_it_generate_without_think_block(
    it_settings: Settings, ollama_ready: None, models_opt_in: None
) -> None:
    """[REQ-RAG-2.1.1] 실제 모델의 응답이 생각 블록으로 시작하지 않는다."""

    async def scenario() -> str:
        hub = ModelHub(it_settings)
        try:
            await hub.prepare()
            return await hub.generate(LlmRole.CHUNKING, "한 단어로 답하라: 하늘색은?")
        finally:
            await hub.close()

    answer = asyncio.run(scenario())

    assert answer.strip()
    assert not answer.strip().startswith("<think>")
