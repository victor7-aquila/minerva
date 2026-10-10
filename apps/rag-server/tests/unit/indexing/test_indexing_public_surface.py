"""indexing 공개 표면(MODULE.md 「공개 표면」·「모델별 필드」·코드 블록) 고정 테스트.

정적 계약 검사 도구가 없어 공개 이름·시그니처를 테스트로 고정한다.
"""

import dataclasses
import inspect
from collections.abc import Callable, Mapping
from typing import Any, Literal, cast, get_type_hints

import pytest

import minerva_rag.indexing as indexing
from minerva_rag.core import ChunkingResult, ChunkRecord, Edition, Settings, SparseVector
from minerva_rag.indexing import EmbeddedChunks, IndexDecision, Indexer, IndexInput, decide_index
from minerva_rag.resource import ChunkStore, ModelHub

P = inspect.Parameter


def _params(func: Callable[..., object]) -> list[inspect.Parameter]:
    """주석을 해석한 시그니처의 매개변수 목록을 돌려준다."""
    return list(inspect.signature(func, eval_str=True).parameters.values())


def _returns(func: Callable[..., object]) -> object:
    """주석을 해석한 반환 타입을 돌려준다."""
    return inspect.signature(func, eval_str=True).return_annotation


def _assert_frozen_fields(cls: type, expected: dict[str, object]) -> None:
    """frozen dataclass이고 필드 이름·순서·타입이 expected와 같으며 기본값이 없는지 본다."""
    assert dataclasses.is_dataclass(cls)
    fields = dataclasses.fields(cls)
    # frozen 여부는 인스턴스를 만들어 대입이 막히는지로 본다(내부 속성에 기대지 않는다)
    instance = cast(Any, cls)(**{f.name: None for f in fields})
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(instance, fields[0].name, "바꿈")
    assert [f.name for f in fields] == list(expected)
    assert get_type_hints(cls) == expected
    assert all(f.default is dataclasses.MISSING for f in fields)
    assert all(f.default_factory is dataclasses.MISSING for f in fields)


@pytest.mark.req("REQ-RAG-3")
def test_all_exports() -> None:
    """[REQ-RAG-3] 공개 이름은 다섯 개뿐이고 패키지 속성과 같은 객체다."""
    assert set(indexing.__all__) == {
        "EmbeddedChunks",
        "IndexDecision",
        "IndexInput",
        "Indexer",
        "decide_index",
    }
    assert indexing.EmbeddedChunks is EmbeddedChunks
    assert indexing.IndexDecision is IndexDecision
    assert indexing.IndexInput is IndexInput
    assert indexing.Indexer is Indexer
    assert indexing.decide_index is decide_index


@pytest.mark.req("REQ-RAG-3.2")
def test_index_input_fields() -> None:
    """[REQ-RAG-3.2] IndexInput은 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(
        IndexInput,
        {
            "doc_id": str,
            "version": str,
            "job_id": str,
            "markdown": str,
            "assets": Mapping[str, str],
            "name": str,
            "edition": Edition | None,
            "chunking_mode": str,
        },
    )


@pytest.mark.req("REQ-RAG-3.2")
def test_embedded_chunks_fields() -> None:
    """[REQ-RAG-3.2] EmbeddedChunks는 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(
        EmbeddedChunks,
        {
            "doc_id": str,
            "version": str,
            "name": str,
            "records": tuple[ChunkRecord, ...],
            "dense": tuple[tuple[float, ...], ...],
            "sparse": tuple[SparseVector, ...],
        },
    )


@pytest.mark.req("REQ-RAG-3.5")
def test_index_decision_fields() -> None:
    """[REQ-RAG-3.5] IndexDecision은 kind(Literal)와 job_id를 가진 frozen dataclass다."""
    _assert_frozen_fields(
        IndexDecision,
        {"kind": Literal["join", "reuse", "submit"], "job_id": str | None},
    )


@pytest.mark.req("REQ-RAG-3")
def test_indexer_init_signature() -> None:
    """[REQ-RAG-3] Indexer(model_hub, chunk_store, settings) -> None 시그니처다."""
    params = _params(Indexer.__init__)

    assert [p.name for p in params] == ["self", "model_hub", "chunk_store", "settings"]
    assert all(p.kind is P.POSITIONAL_OR_KEYWORD for p in params)
    assert all(p.default is P.empty for p in params)
    assert params[1].annotation is ModelHub
    assert params[2].annotation is ChunkStore
    assert params[3].annotation is Settings
    assert _returns(Indexer.__init__) is None


@pytest.mark.req("REQ-RAG-3.5.2")
def test_checksum_signature() -> None:
    """[REQ-RAG-3.5.2] checksum(markdown, assets, chunking_mode) -> str, 동기 함수다."""
    params = _params(Indexer.checksum)

    assert not inspect.iscoroutinefunction(Indexer.checksum)
    assert [p.name for p in params] == ["self", "markdown", "assets", "chunking_mode"]
    assert all(p.kind is P.POSITIONAL_OR_KEYWORD for p in params)
    assert all(p.default is P.empty for p in params)
    assert [p.annotation for p in params[1:]] == [str, Mapping[str, str], str]
    assert _returns(Indexer.checksum) is str


def _assert_async_method(
    method: str, names: list[str], types: list[object], returns: object
) -> None:
    """Indexer의 비동기 메서드가 명세의 이름·타입·반환 타입을 가졌는지 본다."""
    func = getattr(Indexer, method)
    params = _params(func)

    assert inspect.iscoroutinefunction(func)
    assert [p.name for p in params] == ["self", *names]
    assert all(p.kind is P.POSITIONAL_OR_KEYWORD for p in params)
    assert all(p.default is P.empty for p in params)
    assert [p.annotation for p in params[1:]] == types
    assert _returns(func) == returns


@pytest.mark.req("REQ-RAG-3.2")
def test_embed_signature() -> None:
    """[REQ-RAG-3.2] embed(inp, result) -> EmbeddedChunks, 비동기 함수다."""
    _assert_async_method("embed", ["inp", "result"], [IndexInput, ChunkingResult], EmbeddedChunks)


@pytest.mark.req("REQ-RAG-3.3")
def test_write_signature() -> None:
    """[REQ-RAG-3.3] write(embedded) -> int, 비동기 함수다."""
    _assert_async_method("write", ["embedded"], [EmbeddedChunks], int)


@pytest.mark.req("REQ-RAG-3.4")
def test_delete_document_signature() -> None:
    """[REQ-RAG-3.4] delete_document(doc_id) -> None, 비동기 함수다."""
    _assert_async_method("delete_document", ["doc_id"], [str], None)


@pytest.mark.req("REQ-RAG-3.6")
def test_update_metadata_signature() -> None:
    """[REQ-RAG-3.6] update_metadata(doc_id, name, edition) -> None, 비동기 함수다."""
    _assert_async_method(
        "update_metadata", ["doc_id", "name", "edition"], [str, str, Edition | None], None
    )


@pytest.mark.req("REQ-RAG-10.8.5.3")
def test_recover_signature() -> None:
    """[REQ-RAG-10.8.5.3] recover(doc_id, job_id) -> bool, 비동기 함수다."""
    _assert_async_method("recover", ["doc_id", "job_id"], [str, str], bool)


@pytest.mark.req("REQ-RAG-3.5")
def test_decide_index_signature() -> None:
    """[REQ-RAG-3.5] decide_index는 checksum만 위치 인자이고 나머지는 키워드 전용이다."""
    params = _params(decide_index)

    assert not inspect.iscoroutinefunction(decide_index)
    assert [p.name for p in params] == [
        "checksum",
        "open_job_id",
        "current_job_id",
        "current_checksum",
        "force",
    ]
    assert params[0].kind is P.POSITIONAL_OR_KEYWORD
    assert all(p.kind is P.KEYWORD_ONLY for p in params[1:])
    assert all(p.default is P.empty for p in params)
    assert [p.annotation for p in params] == [str, str | None, str | None, str | None, bool]
    assert _returns(decide_index) is IndexDecision
