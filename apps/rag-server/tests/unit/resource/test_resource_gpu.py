"""ModelHub의 GPU 실행과 모델 내리기·올리기(REQ-RAG-12.1.3, REQ-RAG-10.8.8.4~6) 단위 테스트.

★ GPU는 실제로 쓰지 않는다. `_cuda_available`·`_empty_cuda_cache`와 로더를 가짜로 바꿔 끼운다.
"""

import asyncio
import json
import threading
from typing import Any

import httpx
import ollama
import pytest
from structlog.testing import capture_logs

import minerva_rag.resource.model_hub as model_hub_module
from minerva_rag.core import ModelLoadError, ModelUnavailableError, Settings, get_settings
from minerva_rag.resource import LlmRole, ModelHub

from .fakes import (
    CudaSpy,
    FakeModels,
    FakeOllama,
    assert_log,
    events_named,
    install_cuda,
    prepared_hub,
    run,
)


@pytest.fixture(autouse=True)
def fast_unload_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """내리기 확인의 폴링 간격을 0으로 줄인다. 실제 대기를 쓰지 않는다."""
    monkeypatch.setattr(model_hub_module, "_UNLOAD_POLL_SECONDS", 0.0)


@pytest.fixture
def gpu(monkeypatch: pytest.MonkeyPatch) -> CudaSpy:
    """GPU를 쓸 수 있는 것으로 바꾼다."""
    return install_cuda(monkeypatch, available=True)


def _fields(entry: dict[str, Any]) -> set[str]:
    """로그 항목의 필드 키 집합이다 (event·log_level 제외)."""
    return set(entry) - {"event", "log_level"}


def _named_settings(monkeypatch: pytest.MonkeyPatch, **names: str) -> Settings:
    """역할별 Ollama 모델 이름을 바꾼 설정을 만든다."""
    for key, value in names.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    return get_settings()


# ── REQ-RAG-12.1.3 장치 선택 ──────────────────────────────────────


@pytest.mark.req("REQ-RAG-12.1.3")
def test_prepare_on_gpu(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-12.1.3] GPU를 쓸 수 있으면 두 모델을 GPU에 올리고 임베딩은 fp16을 보장한다."""
    run(prepared_hub(settings))

    assert fake_models.embedder.device == "cuda"
    assert fake_models.reranker.device == "cuda"
    assert fake_models.embedder.dtype == "torch.float16"
    # 명세는 임베딩 모델만 fp16을 요구한다
    assert fake_models.reranker.dtype != "torch.float16"


@pytest.mark.req("REQ-RAG-12.1.3")
def test_prepare_guarantees_fp16(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-12.1.3] 로더가 fp32 모델을 돌려줘도 GPU의 임베딩 모델은 fp16이 된다."""
    fake_models.loader_honors_half = False

    run(prepared_hub(settings))

    assert fake_models.embedder.device == "cuda"
    assert fake_models.embedder.dtype == "torch.float16"


@pytest.mark.req("REQ-RAG-12.1.3")
@pytest.mark.parametrize(
    ("use_gpu", "device", "dtype"), [(True, "cuda", "float16"), (False, "cpu", "float32")]
)
def test_models_ready_log(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_ollama: FakeOllama,
    fake_models: FakeModels,
    use_gpu: bool,
    device: str,
    dtype: str,
) -> None:
    """[REQ-RAG-12.1.3] resource.models_ready(info)는 장치와 임베딩 dtype만 담는다."""
    install_cuda(monkeypatch, available=use_gpu)

    with capture_logs() as logs:
        run(prepared_hub(settings))

    assert_log(logs, "resource.models_ready", "info", {"device", "embedding_dtype"})
    (ready,) = events_named(logs, "resource.models_ready")
    assert _fields(ready) == {"device", "embedding_dtype"}
    assert ready["device"] == device
    assert ready["embedding_dtype"] == dtype


@pytest.mark.req("REQ-RAG-12.1.3")
def test_prepare_on_cpu(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, cuda_off: CudaSpy
) -> None:
    """[REQ-RAG-12.1.3] GPU를 못 쓰면 CPU에 올리고 계산이 정상이며 장치 이동을 하지 않는다."""

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        assert len(await hub.embed_documents(["가나다"])) == 1
        assert len(await hub.embed_query("질의")) == fake_models.embedder.dimension
        assert len(await hub.rerank("질의", ["지문1", "지문22"])) == 2

    run(scenario())

    assert fake_models.embedder.device == "cpu"
    assert fake_models.reranker.device == "cpu"
    assert fake_models.embedder.moves == []
    assert fake_models.reranker.moves == []
    assert fake_models.embedder.dtype != "torch.float16"


@pytest.mark.req("REQ-RAG-12.1.1", "REQ-RAG-12.1.3")
@pytest.mark.parametrize("stage", ["device_detect", "half"])
def test_prepare_failure_in_device_setup(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_ollama: FakeOllama,
    fake_models: FakeModels,
    stage: str,
) -> None:
    """[REQ-RAG-12.1.3] 장치 판별이나 fp16 변환이 실패하면 임베딩 모델 메시지의 ModelLoadError이고
    로그 사유가 각각 device_detect_failed·half_failed다."""
    if stage == "device_detect":

        def _boom() -> bool:
            raise RuntimeError("cuda 초기화 실패")

        monkeypatch.setattr(model_hub_module, "_cuda_available", _boom)
        reason = "device_detect_failed"
    else:
        install_cuda(monkeypatch, available=True)
        fake_models.loader_honors_half = False  # 로더가 fp32를 돌려줘 half()가 불린다

        def _half_fails() -> object:
            raise RuntimeError("fp16 변환 실패")

        monkeypatch.setattr(fake_models.embedder, "half", _half_fails)
        reason = "half_failed"

    with capture_logs() as logs, pytest.raises(ModelLoadError) as info:
        run(prepared_hub(settings))

    assert settings.embedding_model in info.value.message
    assert "임베딩 모델을 불러오지 못했습니다" in info.value.message
    assert settings.reranker_model not in info.value.message
    assert_log(logs, "resource.prepare_failed", "error", {"model", "reason"})
    (entry,) = events_named(logs, "resource.prepare_failed")
    assert entry["reason"] == reason
    assert entry["model"] == settings.embedding_model


@pytest.mark.req("REQ-RAG-12.1.3")
@pytest.mark.parametrize("method", ["release_local_models", "load_local_models"])
def test_local_switch_requires_prepare(settings: Settings, method: str) -> None:
    """[REQ-RAG-12.1.3] prepare 전에 로컬 모델을 내리거나 올리면 RuntimeError다."""
    hub = ModelHub(settings)

    with pytest.raises(RuntimeError):
        run(getattr(hub, method)())


# ── REQ-RAG-10.8.8.4 Ollama 모델 내리기 ───────────────────────────


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_unloads_each(
    monkeypatch: pytest.MonkeyPatch, fake_ollama: FakeOllama
) -> None:
    """[REQ-RAG-10.8.8.4] 서로 다른 모델마다 내리는 요청(keep_alive 0)을 보내고, 돌아온 뒤에는
    모두 내려가 있다. 내리는 방법의 세부(프롬프트·확인 호출)는 구현 재량이라 고정하지 않는다."""
    names = {
        "RAG_CHUNKING_LLM": "model-a",
        "RAG_TABLE_LLM": "model-b",
        "RAG_CAPTION_VLM": "model-c",
    }
    cfg = _named_settings(monkeypatch, **names)
    fake_ollama.loaded = set(names.values())

    run(ModelHub(cfg).release_ollama_models())

    requests = fake_ollama.generate_requests()
    assert sorted(r["model"] for r in requests) == ["model-a", "model-b", "model-c"]
    for body in requests:
        assert body["keep_alive"] == 0
    assert fake_ollama.loaded == set()


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_dedupes(settings: Settings, fake_ollama: FakeOllama) -> None:
    """[REQ-RAG-10.8.8.4] 같은 모델 이름은 한 번만 내린다."""
    fake_ollama.loaded = {settings.chunking_llm, settings.caption_vlm}
    assert settings.chunking_llm == settings.table_llm

    run(ModelHub(settings).release_ollama_models())

    models = [r["model"] for r in fake_ollama.generate_requests()]
    assert sorted(models) == sorted({settings.chunking_llm, settings.caption_vlm})
    assert fake_ollama.loaded == set()


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_generate_after_release_ollama(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-10.8.8.4] 내린 뒤에도 generate가 정상 응답한다."""

    async def scenario() -> str:
        hub = await prepared_hub(settings)
        await hub.release_ollama_models()
        return await hub.generate(LlmRole.CHUNKING, "프롬프트")

    assert run(scenario()) == "응답"


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_without_prepare(settings: Settings, fake_ollama: FakeOllama) -> None:
    """[REQ-RAG-10.8.8.4] prepare 없이 불러도 오류 없이 끝난다."""
    run(ModelHub(settings).release_ollama_models())


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_refused(settings: Settings, fake_ollama: FakeOllama) -> None:
    """[REQ-RAG-10.8.8.4] Ollama 연결이 거부되면 ModelUnavailableError이고 경고를 남긴다."""
    fake_ollama.mode = "refuse"

    with capture_logs() as logs, pytest.raises(ModelUnavailableError):
        run(ModelHub(settings).release_ollama_models())

    assert_log(logs, "resource.model_unavailable", "warning", {"role", "model"})


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_timeout(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, fake_ollama: FakeOllama
) -> None:
    """[REQ-RAG-10.8.8.4] 모델이 내려가지 않고 대기 상한을 넘기면 정상 반환하지 않고 예외를 낸다.

    예외 종류는 명세가 정하지 않았다(ModelUnavailableError가 아닌 "그 밖의 실패").
    """
    monkeypatch.setattr(model_hub_module, "_UNLOAD_WAIT_SECONDS", 0.05)
    fake_ollama.stuck_loaded = True
    fake_ollama.loaded = {settings.chunking_llm}

    caught: Exception | None = None
    try:
        run(ModelHub(settings).release_ollama_models())
    except Exception as exc:  # 예외 종류는 구현 재량이다
        caught = exc
    assert caught is not None
    assert not isinstance(caught, ModelUnavailableError)


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_release_ollama_partial_failure(
    monkeypatch: pytest.MonkeyPatch, fake_ollama: FakeOllama
) -> None:
    """[REQ-RAG-10.8.8.4] 첫 모델의 내리기가 실패해도 나머지에 요청을 보내고, 끝에 그 예외를 낸다.
    정상 반환이 아니므로 완료 대기(ps)는 하지 않는다."""
    names = {
        "RAG_CHUNKING_LLM": "model-a",
        "RAG_TABLE_LLM": "model-b",
        "RAG_CAPTION_VLM": "model-c",
    }
    cfg = _named_settings(monkeypatch, **names)
    fake_ollama.loaded = set(names.values())
    original = fake_ollama.handler

    def _fail_first(request: httpx.Request) -> httpx.Response:
        """model-a의 내리기만 서버 오류로 답하고 나머지는 가짜 그대로 답한다."""
        body: dict[str, Any] = json.loads(request.content) if request.content else {}
        if request.url.path == "/api/generate" and body.get("model") == "model-a":
            fake_ollama.requests.append((request.url.path, body))
            return httpx.Response(500, json={"error": "boom"})
        return original(request)

    fake_ollama.handler = _fail_first  # ModelHub가 클라이언트를 만들기 전에 바꿔 끼운다

    with pytest.raises(ollama.ResponseError):
        run(ModelHub(cfg).release_ollama_models())

    requests = fake_ollama.generate_requests()
    assert sorted(r["model"] for r in requests) == ["model-a", "model-b", "model-c"]
    assert fake_ollama.loaded == {"model-a"}  # 나머지는 실제로 내려갔다
    assert [path for path, _ in fake_ollama.requests if path == "/api/ps"] == []


@pytest.mark.req("REQ-RAG-10.8.8.4")
def test_models_released_log_ollama(settings: Settings, fake_ollama: FakeOllama) -> None:
    """[REQ-RAG-10.8.8.4] resource.models_released(info)는 target과 elapsed_ms만 담는다."""
    fake_ollama.loaded = {settings.chunking_llm}

    with capture_logs() as logs:
        run(ModelHub(settings).release_ollama_models())

    assert_log(logs, "resource.models_released", "info", {"target", "elapsed_ms"})
    (entry,) = events_named(logs, "resource.models_released")
    assert _fields(entry) == {"target", "elapsed_ms"}
    assert entry["target"] == "ollama"


# ── REQ-RAG-10.8.8.5 로컬 모델 내리기 ─────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.8.5")
def test_release_local_on_gpu(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.5] GPU 모델을 CPU로 내리고 캐시를 비우며, 토큰 수·차원 조회는 그대로 된다."""

    async def scenario() -> list[dict[str, Any]]:
        hub = await prepared_hub(settings)
        with capture_logs() as logs:
            await hub.release_local_models()
        assert hub.count_tokens("가 나 다") == 3
        assert hub.embedding_dimension == fake_models.embedder.dimension
        assert hub.embedding_model_name == settings.embedding_model
        return [dict(entry) for entry in logs]

    logs = run(scenario())

    assert fake_models.embedder.device == "cpu"
    assert fake_models.reranker.device == "cpu"
    assert gpu.empty_cache_calls == 1
    assert fake_models.embedder.moves == ["cpu"]  # 조회가 다시 올리지 않는다
    assert fake_models.reranker.moves == ["cpu"]
    (entry,) = events_named(logs, "resource.models_released")
    assert entry["log_level"] == "info"
    assert _fields(entry) == {"target", "elapsed_ms"}
    assert entry["target"] == "local"


@pytest.mark.req("REQ-RAG-10.8.8.5")
def test_release_waits_for_inflight(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.5] 진행 중인 계산이 끝난 뒤에 내린다. 계산은 GPU에서 끝난다."""
    embedder = fake_models.embedder

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        embedder.block = threading.Event()
        compute = asyncio.create_task(hub.embed_documents(["가나다"]))
        assert await asyncio.to_thread(embedder.entered.wait, 5)

        release = asyncio.create_task(hub.release_local_models())
        # ★ 계산이 막혀 있는 동안 release가 끝나면 안 된다 (실제 시간 대신 양보·스레드 왕복)
        for _ in range(10):
            await asyncio.sleep(0)
            await asyncio.to_thread(lambda: None)
        assert not release.done()
        assert embedder.device == "cuda"

        embedder.block.set()
        assert len(await compute) == 1
        await release

    run(scenario())

    assert embedder.devices_seen == ["cuda"]
    assert embedder.device == "cpu"


@pytest.mark.req("REQ-RAG-10.8.8.5", "REQ-RAG-12.1.3")
def test_reload_on_demand_only_used_model(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.5] 내려 둔 모델로 계산이 오면 그 모델만 다시 올려서 계산한다."""

    async def scenario() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        hub = await prepared_hub(settings)
        await hub.release_local_models()
        with capture_logs() as embed_logs:
            await hub.embed_documents(["가나다"])
        assert fake_models.embedder.device == "cuda"
        assert fake_models.reranker.device == "cpu"
        with capture_logs() as rerank_logs:
            await hub.rerank("질의", ["지문"])
        return [dict(e) for e in embed_logs], [dict(e) for e in rerank_logs]

    embed_logs, rerank_logs = run(scenario())

    assert fake_models.embedder.devices_seen[-1] == "cuda"
    assert fake_models.reranker.devices_seen[-1] == "cuda"
    (loaded,) = events_named(embed_logs, "resource.models_loaded")
    assert loaded["log_level"] == "info"
    assert _fields(loaded) == {"models", "device", "elapsed_ms"}
    assert loaded["models"] == ["embedding"]
    assert loaded["device"] == "cuda"
    (loaded_rerank,) = events_named(rerank_logs, "resource.models_loaded")
    assert loaded_rerank["models"] == ["reranker"]


@pytest.mark.req("REQ-RAG-10.8.8.5")
def test_release_local_on_cpu(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, cuda_off: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.5] CPU에서는 아무 일도 하지 않고 이후 계산이 정상이다."""

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.release_local_models()
        assert len(await hub.embed_documents(["가나다"])) == 1
        assert len(await hub.rerank("질의", ["지문"])) == 1

    run(scenario())

    assert fake_models.embedder.moves == []
    assert fake_models.reranker.moves == []
    assert cuda_off.empty_cache_calls == 0


# ── REQ-RAG-10.8.8.6 로컬 모델 올리기 ─────────────────────────────


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_load_local_on_gpu(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.6] 내려 둔 두 모델을 GPU에 올리고 resource.models_loaded를 남긴다."""

    async def scenario() -> list[dict[str, Any]]:
        hub = await prepared_hub(settings)
        await hub.release_local_models()
        with capture_logs() as logs:
            await hub.load_local_models()
        return [dict(entry) for entry in logs]

    logs = run(scenario())

    assert fake_models.embedder.device == "cuda"
    assert fake_models.reranker.device == "cuda"
    (entry,) = events_named(logs, "resource.models_loaded")
    assert set(entry["models"]) == {"embedding", "reranker"}
    assert entry["device"] == "cuda"


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_load_local_already_loaded(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, gpu: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.6] 이미 올라가 있으면 아무 일도 하지 않고 로그도 남기지 않는다."""

    async def scenario() -> list[dict[str, Any]]:
        hub = await prepared_hub(settings)
        with capture_logs() as logs:
            await hub.load_local_models()
        return [dict(entry) for entry in logs]

    logs = run(scenario())

    assert fake_models.embedder.moves == []
    assert fake_models.reranker.moves == []
    assert events_named(logs, "resource.models_loaded") == []


@pytest.mark.req("REQ-RAG-10.8.8.6")
def test_load_local_on_cpu(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels, cuda_off: CudaSpy
) -> None:
    """[REQ-RAG-10.8.8.6] CPU에서는 오류 없이 끝나고 장치 이동이 없다."""

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.load_local_models()

    run(scenario())

    assert fake_models.embedder.moves == []
    assert fake_models.reranker.moves == []
