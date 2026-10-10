"""모델을 준비하고 호출한다 (REQ-RAG-12.1)."""

import asyncio
import copy
import hashlib
import re
import threading
import time
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from enum import StrEnum
from typing import TYPE_CHECKING, Any, cast

import httpx
import ollama

from minerva_rag.core import (
    ModelLoadError,
    ModelUnavailableError,
    PromptTooLongError,
    Settings,
    SparseVector,
    get_logger,
)

if TYPE_CHECKING:
    from sentence_transformers import CrossEncoder, SentenceTransformer

log = get_logger(__name__)

_OLLAMA_CONNECT_TIMEOUT_SECONDS = 5.0
_HEALTH_TIMEOUT_SECONDS = 5.0
_THINK_BLOCK = re.compile(r"^\s*<think>.*?</think>\s*", re.DOTALL)

# 키워드 토큰화: 문자·숫자의 연속 구간이 단어다 (공백·구두점·기호·밑줄에서 나뉜다)
_WORD = re.compile(r"[^\W_]+")
_HANGUL_RUN = re.compile(r"[가-힣]+")

_NOT_PREPARED = "ModelHub.prepare 전에 호출했습니다"


class LlmRole(StrEnum):
    """생성 모델의 역할이다. 역할마다 설정의 모델이 다르다."""

    CHUNKING = "chunking"  # RAG_CHUNKING_LLM
    TABLE_SUMMARY = "table_summary"  # RAG_TABLE_LLM
    IMAGE_CAPTION = "image_caption"  # RAG_CAPTION_VLM


# ── 비공개 팩토리 (테스트가 바꿔 끼우는 경계) ────────────────────────


def _create_ollama_client(settings: Settings) -> ollama.AsyncClient:
    """설정한 주소의 Ollama 클라이언트를 만든다."""
    return ollama.AsyncClient(
        host=settings.ollama_url,
        # ★ 생성은 길 수 있어 읽기 제한을 두지 않고 연결 단계만 제한한다
        timeout=httpx.Timeout(None, connect=_OLLAMA_CONNECT_TIMEOUT_SECONDS),
    )


def _load_embedding_model(settings: Settings) -> "SentenceTransformer":
    """RAG_MODELS_DIR에서 임베딩 모델을 불러온다. 없으면 그 위치로 내려받는다."""
    # ★ torch import가 무거워 호출 시점에 늦게 한다
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(settings.embedding_model, cache_folder=str(settings.models_dir))


def _load_reranker_model(settings: Settings) -> "CrossEncoder":
    """RAG_MODELS_DIR에서 재정렬 모델을 불러온다. 없으면 그 위치로 내려받는다."""
    from sentence_transformers import CrossEncoder

    return CrossEncoder(settings.reranker_model, cache_folder=str(settings.models_dir))


# ── 키워드 토큰화 (모델이 필요 없다) ─────────────────────────────────


def _hangul_bigrams(word: str) -> list[str]:
    """단어 안 한글 연속 구간의 이웃한 두 글자 조각을 돌려준다. 단어 자체와 같은 조각은 뺀다."""
    pieces: list[str] = []
    for run in _HANGUL_RUN.findall(word):
        pieces.extend(run[i : i + 2] for i in range(len(run) - 1))
    return [piece for piece in pieces if piece != word]


def _keyword_tokens(text: str) -> list[str]:
    """키워드 토큰화 규칙으로 토큰을 나오는 차례대로(중복 포함) 돌려준다."""
    normalized = unicodedata.normalize("NFKC", text).lower()
    tokens: list[str] = []
    for word in _WORD.findall(normalized):
        tokens.append(word)
        tokens.extend(_hangul_bigrams(word))
    return tokens


def _token_index(token: str) -> int:
    """토큰을 프로세스와 무관한 uint32 인덱스로 바꾼다. ★ hash()는 실행마다 달라 쓰지 않는다."""
    return int.from_bytes(hashlib.blake2b(token.encode("utf-8"), digest_size=4).digest(), "big")


def _document_vector(text: str) -> SparseVector:
    """토큰 빈도를 값으로 하는 문서 키워드 벡터를 만든다."""
    counts: Counter[int] = Counter(_token_index(token) for token in _keyword_tokens(text))
    indices = sorted(counts)
    return SparseVector(
        indices=tuple(indices), values=tuple(float(counts[index]) for index in indices)
    )


def _query_vector(text: str) -> SparseVector:
    """값이 모두 1인 질의 키워드 벡터를 만든다."""
    indices = sorted({_token_index(token) for token in _keyword_tokens(text)})
    return SparseVector(indices=tuple(indices), values=tuple(1.0 for _ in indices))


# ── 모델 출력 변환 ──────────────────────────────────────────────────


def _to_list(value: object) -> list[Any]:
    """numpy 배열 등 tolist를 가진 값과 일반 시퀀스를 목록으로 바꾼다."""
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return cast(list[Any], tolist())
    return list(cast(Sequence[Any], value))


def _as_float_list(value: object) -> list[float]:
    """모델 출력(1차원)을 float 목록으로 바꾼다."""
    return [float(item) for item in _to_list(value)]


def _as_float_rows(value: object) -> list[list[float]]:
    """모델 출력(2차원)을 float 목록의 목록으로 바꾼다."""
    return [_as_float_list(row) for row in _to_list(value)]


class ModelHub:
    """모델을 준비하고 호출한다."""

    def __init__(self, settings: Settings) -> None:
        """설정을 받고 Ollama 클라이언트를 만든다. I/O는 하지 않는다."""
        self._settings = settings
        self._ollama = _create_ollama_client(settings)
        self._embedder: SentenceTransformer | None = None
        self._reranker: CrossEncoder | None = None
        self._dimension: int | None = None
        self._closed = False
        # ★ HF 빠른 토크나이저는 동시에 쓰면 "Already borrowed"로 실패한다 — 모델마다 잠근다.
        # 잠금은 워커 스레드 안에서만 잡아 이벤트 루프가 추론을 기다리지 않는다
        self._embed_lock = threading.Lock()
        self._rerank_lock = threading.Lock()
        # ★ count_tokens 전용 토크나이저 사본과 그 잠금. 임베딩 추론과 잠금을 나눠, 이벤트 루프
        # 스레드의 count_tokens가 긴 추론이 끝나기를 기다리지 않는다(잠금 구간은 짧은 encode뿐)
        self._counter_tokenizer: Any = None
        self._count_lock = threading.Lock()

    # ── 준비·종료 ────────────────────────────────────────────────

    async def prepare(self) -> None:
        """Ollama 모델을 확인하고 임베딩·재정렬 모델을 불러온다. 실패하면 ModelLoadError를 낸다."""
        settings = self._settings
        # 같은 이름은 한 번만, 설정 순서대로 확인한다
        wanted = dict.fromkeys([settings.chunking_llm, settings.table_llm, settings.caption_vlm])
        # ★ 빨리 실패하는 원격 확인을 무거운 로드보다 먼저 한다
        for model in wanted:
            await self._check_ollama_model(model)

        embedder = await self._load_embedder()
        try:
            dimension = embedder.get_embedding_dimension()
        except Exception as exc:
            raise self._prepare_failure(
                settings.embedding_model,
                "invalid_dimension",
                f"임베딩 모델을 불러오지 못했습니다: {settings.embedding_model}",
            ) from exc
        try:
            counter = await asyncio.to_thread(copy.deepcopy, embedder.tokenizer)
        except Exception as exc:
            raise self._prepare_failure(
                settings.embedding_model,
                "tokenizer_copy_failed",
                f"임베딩 모델을 불러오지 못했습니다: {settings.embedding_model}",
            ) from exc
        if dimension is None or dimension < 1:
            raise self._prepare_failure(
                settings.embedding_model,
                "invalid_dimension",
                f"임베딩 모델을 불러오지 못했습니다: {settings.embedding_model}",
            )
        try:
            reranker = await asyncio.to_thread(_load_reranker_model, settings)
        except Exception as exc:
            raise self._prepare_failure(
                settings.reranker_model,
                "load_failed",
                f"재정렬 모델을 불러오지 못했습니다: {settings.reranker_model}",
            ) from exc
        # 모두 성공한 뒤에만 채운다 — 반쯤 준비된 상태를 남기지 않는다
        self._embedder = embedder
        self._reranker = reranker
        self._dimension = dimension
        self._counter_tokenizer = counter

    async def _check_ollama_model(self, model: str) -> None:
        """Ollama에 모델이 있는지 확인한다. 없거나 확인하지 못하면 ModelLoadError를 낸다."""
        try:
            await self._ollama.show(model)
        except (ConnectionError, httpx.ConnectTimeout) as exc:
            raise self._prepare_failure(
                model,
                "ollama_unreachable",
                f"Ollama에 연결할 수 없어 모델을 확인하지 못했습니다: {model}",
            ) from exc
        except ollama.ResponseError as exc:
            if exc.status_code == 404:
                raise self._prepare_failure(
                    model, "ollama_model_missing", f"Ollama에 설정한 모델이 없습니다: {model}"
                ) from exc
            raise self._prepare_failure(
                model, "ollama_check_failed", f"Ollama에서 모델을 확인하지 못했습니다: {model}"
            ) from exc
        except Exception as exc:
            raise self._prepare_failure(
                model, "ollama_check_failed", f"Ollama에서 모델을 확인하지 못했습니다: {model}"
            ) from exc

    async def _load_embedder(self) -> "SentenceTransformer":
        """모델 폴더를 만들고 임베딩 모델을 불러온다."""
        settings = self._settings
        try:
            await asyncio.to_thread(settings.models_dir.mkdir, parents=True, exist_ok=True)
            return await asyncio.to_thread(_load_embedding_model, settings)
        except Exception as exc:
            raise self._prepare_failure(
                settings.embedding_model,
                "load_failed",
                f"임베딩 모델을 불러오지 못했습니다: {settings.embedding_model}",
            ) from exc

    @staticmethod
    def _prepare_failure(model: str, reason: str, message: str) -> ModelLoadError:
        """실패 로그를 남기고 ModelLoadError를 돌려준다. ★ 로그에 예외 문자열을 넣지 않는다."""
        log.error("resource.prepare_failed", model=model, reason=reason)
        return ModelLoadError(message)

    async def close(self) -> None:
        """Ollama 클라이언트를 닫고 모델 참조를 놓는다. 여러 번 불러도 된다."""
        self._embedder = None
        self._reranker = None
        self._dimension = None
        self._counter_tokenizer = None
        if self._closed:
            return
        self._closed = True
        await self._ollama.close()

    # ── 생성 ─────────────────────────────────────────────────────

    async def generate(
        self,
        role: LlmRole,
        prompt: str,
        *,
        image: bytes | None = None,
        json_schema: Mapping[str, Any] | None = None,
    ) -> str:
        """역할에 대응하는 Ollama 모델로 생성한다. 넘치는 프롬프트는 보내지 않고 오류를 낸다."""
        self._require_embedder()  # count_tokens에 토크나이저가 필요하다
        if image is not None and role is not LlmRole.IMAGE_CAPTION:
            raise ValueError("image는 IMAGE_CAPTION 역할에서만 쓸 수 있습니다")
        settings = self._settings
        model = self._model_for(role)
        limit = settings.llm_context_tokens - settings.llm_output_reserve_tokens
        # ★ Ollama는 컨텍스트를 넘는 입력을 오류 없이 잘라 쓰므로 보내기 전에 막는다
        token_count = await asyncio.to_thread(self.count_tokens, prompt)
        if token_count > limit:
            raise PromptTooLongError()

        started = time.perf_counter()
        try:
            response = await self._ollama.generate(
                model=model,
                prompt=prompt,
                images=[image] if image is not None else None,
                format=dict(json_schema) if json_schema is not None else None,
                options={"num_ctx": settings.llm_context_tokens},
                think=False,
                stream=False,
            )
        except (ConnectionError, httpx.ConnectTimeout) as exc:
            # ★ ollama 라이브러리는 연결 거부(httpx.ConnectError)를 내장 ConnectionError로 바꾸고
            # 연결 시간 초과는 httpx.ConnectTimeout 그대로 낸다. 이미 연결된 뒤 끊긴 경우
            # (ConnectionResetError 등)는 연결 불가가 아니므로 그대로 전파한다
            if isinstance(exc, ConnectionResetError | ConnectionAbortedError | BrokenPipeError):
                raise
            log.warning("resource.model_unavailable", role=role.value, model=model)
            raise ModelUnavailableError() from exc
        # 그 밖의 예외(ollama.ResponseError 등)는 그대로 전파한다 — 해석은 부른 단위가 한다
        text = _THINK_BLOCK.sub("", response.response or "", count=1)
        log.info(
            "resource.generate",
            role=role.value,
            model=model,
            prompt_chars=len(prompt),
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )
        return text

    def _model_for(self, role: LlmRole) -> str:
        """역할에 대응하는 설정의 Ollama 모델 이름을 돌려준다."""
        settings = self._settings
        if role is LlmRole.CHUNKING:
            return settings.chunking_llm
        if role is LlmRole.TABLE_SUMMARY:
            return settings.table_llm
        return settings.caption_vlm

    # ── 임베딩·재정렬·토큰 ───────────────────────────────────────

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """문서용 입력 형식으로 dense 벡터를 만든다. 입력과 같은 길이·같은 순서다."""
        embedder = self._require_embedder()
        if not texts:
            return []
        batch = list(texts)
        output = await asyncio.to_thread(self._encode_locked, embedder.encode_document, batch)
        rows = _as_float_rows(output)
        if len(rows) != len(batch):
            raise RuntimeError("임베딩 결과의 개수가 입력과 다릅니다")
        return rows

    async def embed_query(self, text: str) -> list[float]:
        """질의용 입력 형식으로 dense 벡터를 만든다."""
        embedder = self._require_embedder()
        output = await asyncio.to_thread(self._encode_locked, embedder.encode_query, text)
        return _as_float_list(output)

    async def encode_sparse_documents(self, texts: Sequence[str]) -> list[SparseVector]:
        """문서 텍스트마다 키워드 벡터를 만든다. 입력과 같은 길이·같은 순서다."""
        batch = list(texts)
        if not batch:
            return []

        def _encode() -> list[SparseVector]:
            return [_document_vector(text) for text in batch]

        return await asyncio.to_thread(_encode)

    async def encode_sparse_query(self, text: str) -> SparseVector:
        """질의 텍스트의 키워드 벡터를 만든다."""
        return await asyncio.to_thread(_query_vector, text)

    async def rerank(self, query: str, passages: Sequence[str]) -> list[float]:
        """질의와 지문의 관련도 점수를 돌려준다. 점수가 클수록 관련이 높다."""
        reranker = self._require_reranker()
        if not passages:
            return []
        pairs = [(query, passage) for passage in passages]
        output = await asyncio.to_thread(self._predict_locked, reranker, pairs)
        scores = _as_float_list(output)
        if len(scores) != len(pairs):
            raise RuntimeError("재정렬 결과의 개수가 입력과 다릅니다")
        return scores

    def _encode_locked(self, encode: Any, inputs: Any) -> Any:
        """임베딩 모델 추론을 잠금 아래에서 한 번에 하나씩 실행한다. 워커 스레드에서만 부른다."""
        with self._embed_lock:
            return encode(inputs, normalize_embeddings=True, convert_to_numpy=True)

    def _predict_locked(self, reranker: "CrossEncoder", pairs: list[tuple[str, str]]) -> Any:
        """재정렬 추론을 잠금 아래에서 한 번에 하나씩 실행한다. 워커 스레드에서만 부른다."""
        with self._rerank_lock:
            return reranker.predict(pairs, convert_to_numpy=True)

    def count_tokens(self, text: str) -> int:
        """임베딩 모델의 토크나이저로 센다. 토크나이저가 붙이는 특수 토큰은 세지 않는다."""
        self._require_embedder()
        tokenizer = self._counter_tokenizer
        if tokenizer is None:
            raise RuntimeError(_NOT_PREPARED)
        # ★ 전용 사본을 짧게만 잠근다 — 추론 잠금과 무관해 이벤트 루프 스레드가 오래 막히지 않는다
        with self._count_lock:
            return len(tokenizer.encode(text, add_special_tokens=False))

    @property
    def embedding_dimension(self) -> int:
        """임베딩 벡터의 차원이다. prepare 전에는 RuntimeError다."""
        if self._dimension is None:
            raise RuntimeError(_NOT_PREPARED)
        return self._dimension

    @property
    def embedding_model_name(self) -> str:
        """설정한 임베딩 모델 이름이다."""
        return self._settings.embedding_model

    async def ollama_available(self) -> bool:
        """Ollama에 닿는지만 돌려준다. 오류를 내지 않는다."""
        try:
            await asyncio.wait_for(self._ollama.list(), _HEALTH_TIMEOUT_SECONDS)
        except Exception:
            return False
        return True

    # ── 준비 확인 ────────────────────────────────────────────────

    def _require_embedder(self) -> "SentenceTransformer":
        """준비된 임베딩 모델을 돌려준다. prepare 전이면 RuntimeError다."""
        if self._embedder is None:
            raise RuntimeError(_NOT_PREPARED)
        return self._embedder

    def _require_reranker(self) -> "CrossEncoder":
        """준비된 재정렬 모델을 돌려준다. prepare 전이면 RuntimeError다."""
        if self._reranker is None:
            raise RuntimeError(_NOT_PREPARED)
        return self._reranker
