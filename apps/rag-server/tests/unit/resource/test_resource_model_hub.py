"""ModelHub(REQ-RAG-12.1.1, REQ-RAG-12.1.2, REQ-RAG-2.5.2.2, REQ-RAG-2.1.1) 단위 테스트."""

import base64
import threading

import ollama
import pytest
from structlog.testing import capture_logs

from minerva_rag.core import (
    MinervaError,
    ModelLoadError,
    ModelUnavailableError,
    PromptTooLongError,
    Settings,
)
from minerva_rag.resource import LlmRole, ModelHub

from .fakes import (
    FakeModels,
    FakeOllama,
    assert_log,
    assert_logs_exclude,
    install_failing_loader,
    install_fake_ollama,
    prepared_hub,
    run,
)

# ── REQ-RAG-12.1.1 모델 준비 ──────────────────────────────────────


@pytest.mark.req("REQ-RAG-12.1.1")
def test_prepare_succeeds_with_positive_dimension(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.1] 모든 모델이 있으면 prepare가 끝나고 차원이 양수이며 내려받지 않는다."""

    async def scenario() -> int:
        hub = await prepared_hub(settings)
        return hub.embedding_dimension

    assert run(scenario()) > 0
    assert not [p for p, _ in fake_ollama.requests if p == "/api/pull"]


@pytest.mark.req("REQ-RAG-12.1.1")
def test_prepare_fails_when_ollama_model_missing(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.1] Ollama 모델이 없으면 ModelLoadError이고 메시지에 모델 이름이 있다."""
    fake_ollama.models = {"qwen3:14b"}

    with pytest.raises(ModelLoadError) as info:
        run(prepared_hub(settings))

    assert settings.caption_vlm in info.value.message
    assert "model not found" not in info.value.message  # 원래 예외 문자열이 새지 않는다


@pytest.mark.req("REQ-RAG-12.1.1")
def test_prepare_fails_when_ollama_unreachable(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.1] Ollama에 연결할 수 없으면 ModelLoadError를 낸다."""
    fake_ollama.mode = "refuse"

    with pytest.raises(ModelLoadError):
        run(prepared_hub(settings))


@pytest.mark.req("REQ-RAG-12.1.1")
def test_prepare_fails_when_embedding_load_fails(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_ollama: FakeOllama,
    fake_models: FakeModels,
) -> None:
    """[REQ-RAG-12.1.1] 임베딩 모델 로드 실패는 ModelLoadError이고 메시지에 모델 이름이 있다."""
    install_failing_loader(monkeypatch, "_load_embedding_model")

    with pytest.raises(ModelLoadError) as info:
        run(prepared_hub(settings))

    assert settings.embedding_model in info.value.message


@pytest.mark.req("REQ-RAG-12.1.1")
def test_prepare_fails_when_reranker_load_fails(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_ollama: FakeOllama,
    fake_models: FakeModels,
) -> None:
    """[REQ-RAG-12.1.1] 재정렬 모델 로드 실패는 ModelLoadError이고 메시지에 모델 이름이 있다."""
    install_failing_loader(monkeypatch, "_load_reranker_model")

    with pytest.raises(ModelLoadError) as info:
        run(prepared_hub(settings))

    assert settings.reranker_model in info.value.message


@pytest.mark.req("REQ-RAG-12.1.1")
def test_prepare_failure_logged(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.1] prepare 실패는 resource.prepare_failed(error)로 남고 필드가 허용 범위다."""
    fake_ollama.models = set()

    with capture_logs() as logs, pytest.raises(ModelLoadError):
        run(prepared_hub(settings))

    assert_log(logs, "resource.prepare_failed", "error", {"model", "reason"})


@pytest.mark.req("REQ-RAG-12.1.1")
def test_close_is_idempotent(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.1] close는 prepare 없이도, 여러 번 불러도 오류가 없다."""

    async def scenario() -> None:
        never_prepared = ModelHub(settings)
        await never_prepared.close()
        await never_prepared.close()
        hub = await prepared_hub(settings)
        await hub.close()
        await hub.close()

    run(scenario())


# ── REQ-RAG-12.1.2 모델 서버 연결 실패 ────────────────────────────


@pytest.mark.req("REQ-RAG-12.1.2")
def test_generate_refused_raises_model_unavailable(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.2] 연결 거부면 generate는 ModelUnavailableError, ollama_available은 False다."""

    async def scenario() -> bool:
        hub = await prepared_hub(settings)
        fake_ollama.mode = "refuse"
        with pytest.raises(ModelUnavailableError) as info:
            await hub.generate(LlmRole.CHUNKING, "질문")
        assert info.value.code == "MODEL_UNAVAILABLE"
        return await hub.ollama_available()

    with capture_logs() as logs:
        available = run(scenario())

    assert available is False
    assert_log(logs, "resource.model_unavailable", "warning", {"role", "model"})


@pytest.mark.req("REQ-RAG-12.1.2")
def test_generate_connect_timeout_raises_model_unavailable(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.2] 연결 시간 초과도 ModelUnavailableError다."""

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        fake_ollama.mode = "connect_timeout"
        with pytest.raises(ModelUnavailableError):
            await hub.generate(LlmRole.CHUNKING, "질문")

    run(scenario())


@pytest.mark.req("REQ-RAG-12.1.2")
def test_generate_server_error_propagates(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.2] 연결은 됐지만 생성이 실패하면 그 오류를 그대로 낸다."""

    async def scenario() -> BaseException:
        hub = await prepared_hub(settings)
        fake_ollama.mode = "error"
        try:
            await hub.generate(LlmRole.CHUNKING, "질문")
        except Exception as exc:
            return exc
        raise AssertionError("오류가 나야 한다")

    error = run(scenario())

    assert isinstance(error, ollama.ResponseError)
    assert not isinstance(error, MinervaError)


@pytest.mark.req("REQ-RAG-9.2.1")
def test_ollama_available_without_prepare(settings: Settings, fake_ollama: FakeOllama) -> None:
    """[REQ-RAG-9.2.1] ollama_available은 prepare 없이 동작하고 오류를 내지 않는다."""

    async def scenario() -> tuple[bool, bool]:
        hub = ModelHub(settings)
        ok = await hub.ollama_available()
        fake_ollama.mode = "refuse"
        return ok, await hub.ollama_available()

    assert run(scenario()) == (True, False)


@pytest.mark.req("REQ-RAG-12.1.2")
def test_generate_passes_image_and_schema(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.2] image는 요청 images에 실리고 json_schema는 요청 format이 된다."""
    image = b"\x89PNG-test-bytes"
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(LlmRole.IMAGE_CAPTION, "설명", image=image)
        await hub.generate(LlmRole.CHUNKING, "추출", json_schema=schema)

    run(scenario())

    caption_body, schema_body = fake_ollama.generate_requests()
    assert [base64.b64decode(x) for x in caption_body["images"]] == [image]
    assert schema_body["format"] == schema


@pytest.mark.req("REQ-RAG-12.1.2")
@pytest.mark.parametrize("role", [LlmRole.CHUNKING, LlmRole.TABLE_SUMMARY])
def test_generate_rejects_image_for_text_roles(
    role: LlmRole, settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.2] image는 IMAGE_CAPTION에서만 쓴다. 다른 역할에 주면 ValueError다."""

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(role, "프롬프트", image=b"img")

    with pytest.raises(ValueError):
        run(scenario())


@pytest.mark.req("REQ-RAG-12.1.2")
def test_generate_logs_without_prompt(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1.2] resource.generate(info)는 허용 필드만 갖고 프롬프트·응답을 담지 않는다."""
    prompt = "비밀스러운 사내 문서 본문"
    fake_ollama.response_text = "비밀스러운 생성 결과"

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(LlmRole.CHUNKING, prompt)

    with capture_logs() as logs:
        run(scenario())

    assert_log(logs, "resource.generate", "info", {"role", "model", "prompt_chars", "elapsed_ms"})
    assert_logs_exclude(logs, [prompt, "비밀스러운 생성 결과"])


# ── REQ-RAG-2.5.2.2 컨텍스트 ──────────────────────────────────────


def _words(count: int) -> str:
    """가짜 토크나이저에서 정확히 count 토큰이 되는 프롬프트를 만든다."""
    return " ".join(["w"] * count)


@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_generate_sets_context_size_for_every_role(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-2.5.2.2] 모든 역할의 요청에 컨텍스트 크기가 지정되고 역할에 맞는 모델을 쓴다."""
    expected_models = {
        LlmRole.CHUNKING: settings.chunking_llm,
        LlmRole.TABLE_SUMMARY: settings.table_llm,
        LlmRole.IMAGE_CAPTION: settings.caption_vlm,
    }

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        for role in LlmRole:
            image = b"img" if role == LlmRole.IMAGE_CAPTION else None
            await hub.generate(role, "프롬프트", image=image)

    run(scenario())

    bodies = fake_ollama.generate_requests()
    assert len(bodies) == len(LlmRole)
    for role, body in zip(LlmRole, bodies, strict=True):
        assert body["options"]["num_ctx"] == settings.llm_context_tokens
        assert body["model"] == expected_models[role]


@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_generate_rejects_prompt_over_limit(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-2.5.2.2] 한도(컨텍스트 - 출력 몫)를 넘으면 보내지 않고 PromptTooLongError다."""
    limit = settings.llm_context_tokens - settings.llm_output_reserve_tokens

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(LlmRole.CHUNKING, _words(limit + 1))

    with pytest.raises(PromptTooLongError):
        run(scenario())
    assert fake_ollama.generate_requests() == []


@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_generate_accepts_prompt_at_limit(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-2.5.2.2] 한도와 정확히 같은 프롬프트는 요청이 나간다 ('넘으면' 거부)."""
    limit = settings.llm_context_tokens - settings.llm_output_reserve_tokens

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(LlmRole.CHUNKING, _words(limit))

    run(scenario())

    assert len(fake_ollama.generate_requests()) == 1


@pytest.mark.req("REQ-RAG-2.5.2.2")
def test_generate_ignores_image_tokens(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-2.5.2.2] 이미지의 토큰은 세지 않으므로 큰 이미지가 있어도 거부되지 않는다."""
    limit = settings.llm_context_tokens - settings.llm_output_reserve_tokens

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(LlmRole.IMAGE_CAPTION, _words(limit), image=b"\x00" * 1_000_000)

    run(scenario())

    assert len(fake_ollama.generate_requests()) == 1


# ── REQ-RAG-2.1.1 생각 모드 ───────────────────────────────────────


@pytest.mark.req("REQ-RAG-2.1.1")
def test_generate_disables_thinking(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-2.1.1] 모든 생성 요청이 생각 모드를 끈다."""

    async def scenario() -> None:
        hub = await prepared_hub(settings)
        await hub.generate(LlmRole.CHUNKING, "하나")
        await hub.generate(LlmRole.IMAGE_CAPTION, "둘", image=b"img")

    run(scenario())

    bodies = fake_ollama.generate_requests()
    assert len(bodies) == 2
    assert all(body["think"] is False for body in bodies)


@pytest.mark.req("REQ-RAG-2.1.1")
def test_generate_strips_leading_think_block(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-2.1.1] 응답 앞의 생각 블록은 지우고 나머지만 돌려준다."""

    async def scenario() -> tuple[str, str]:
        hub = await prepared_hub(settings)
        fake_ollama.response_text = "<think>\n추론\n</think>\n\n답변"
        with_think = await hub.generate(LlmRole.CHUNKING, "질문")
        fake_ollama.response_text = "답변"
        plain = await hub.generate(LlmRole.CHUNKING, "질문")
        return with_think, plain

    with_think, plain = run(scenario())

    assert "<think>" not in with_think
    assert "추론" not in with_think
    assert with_think.strip() == "답변"
    assert plain == "답변"


# ── REQ-RAG-12.1 임베딩·재정렬·토큰 ───────────────────────────────


@pytest.mark.req("REQ-RAG-12.1")
def test_embed_documents_keeps_length_and_order(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1] embed_documents는 입력과 같은 길이·같은 순서로 차원 길이의 벡터를 돌려준다."""
    texts = ["가", "가나다", "가나다라마"]

    async def scenario() -> tuple[list[list[float]], int]:
        hub = await prepared_hub(settings)
        return await hub.embed_documents(texts), hub.embedding_dimension

    vectors, dimension = run(scenario())

    assert len(vectors) == 3
    assert all(len(v) == dimension for v in vectors)
    # 가짜가 입력마다 다른 벡터를 주므로 순서가 바뀌면 이 비교가 깨진다
    single = [run(_embed_one(settings, t)) for t in texts]
    assert vectors == single


async def _embed_one(settings: Settings, text: str) -> list[float]:
    """한 건짜리 embed_documents 결과를 돌려준다."""
    hub = await prepared_hub(settings)
    return (await hub.embed_documents([text]))[0]


@pytest.mark.req("REQ-RAG-12.1")
def test_embed_query_uses_query_format(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1] embed_query는 질의용 형식, embed_documents는 문서용 형식으로 계산한다."""

    async def scenario() -> tuple[list[float], int]:
        hub = await prepared_hub(settings)
        await hub.embed_documents(["문서 글"])
        return await hub.embed_query("질의 글"), hub.embedding_dimension

    vector, dimension = run(scenario())

    assert len(vector) == dimension
    kinds = {kind for kind, _ in fake_models.embedder.calls}
    assert kinds == {"document", "query"}
    document_inputs = [
        t for kind, texts in fake_models.embedder.calls if kind == "document" for t in texts
    ]
    query_inputs = [
        t for kind, texts in fake_models.embedder.calls if kind == "query" for t in texts
    ]
    assert document_inputs == ["문서 글"]
    assert query_inputs == ["질의 글"]


@pytest.mark.req("REQ-RAG-12.1")
def test_rerank_keeps_length_and_order(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1] rerank는 지문 수만큼, 지문 순서대로 점수를 돌려준다."""
    passages = ["가나다라마", "가", "가나다"]

    async def scenario() -> list[float]:
        hub = await prepared_hub(settings)
        return await hub.rerank("질의", passages)

    scores = run(scenario())

    assert len(scores) == 3
    # 가짜 점수는 지문 길이다: 순서가 보존되면 길이 순서와 점수 순서가 같다
    assert scores[0] > scores[2] > scores[1]


@pytest.mark.req("REQ-RAG-12.1")
def test_count_tokens_excludes_special_tokens(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1] count_tokens는 토크나이저가 붙이는 특수 토큰을 세지 않는다."""

    async def scenario() -> int:
        hub = await prepared_hub(settings)
        return hub.count_tokens("a b c")

    assert run(scenario()) == 3


@pytest.mark.req("REQ-RAG-12.1")
def test_model_calls_run_off_event_loop(
    settings: Settings, fake_ollama: FakeOllama, fake_models: FakeModels
) -> None:
    """[REQ-RAG-12.1] 임베딩·재정렬 계산은 이벤트 루프 스레드에서 실행하지 않는다."""

    async def scenario() -> int:
        hub = await prepared_hub(settings)
        fake_models.embedder.threads.clear()
        await hub.embed_documents(["문서"])
        await hub.embed_query("질의")
        await hub.rerank("질의", ["지문"])
        return threading.get_ident()

    loop_thread = run(scenario())

    used = fake_models.embedder.threads + fake_models.reranker.threads
    assert len(used) >= 3
    assert loop_thread not in used


@pytest.mark.req("REQ-RAG-12.1")
def test_calls_before_prepare_raise(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-12.1] prepare 전 모델 호출은 RuntimeError이고 키워드 인코딩·모델 이름은 동작한다."""
    install_fake_ollama(monkeypatch, FakeOllama(models=set()))
    hub = ModelHub(settings)

    async def scenario() -> None:
        with pytest.raises(RuntimeError):
            await hub.generate(LlmRole.CHUNKING, "질문")
        with pytest.raises(RuntimeError):
            await hub.embed_documents(["문서"])
        with pytest.raises(RuntimeError):
            await hub.embed_query("질의")
        with pytest.raises(RuntimeError):
            await hub.rerank("질의", ["지문"])
        assert await hub.encode_sparse_documents(["문서 글"])
        assert (await hub.encode_sparse_query("질의 글")).indices

    run(scenario())

    with pytest.raises(RuntimeError):
        hub.count_tokens("글")
    with pytest.raises(RuntimeError):
        _ = hub.embedding_dimension
    assert hub.embedding_model_name == settings.embedding_model
