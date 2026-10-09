"""resource 공개 표면(MODULE.md 「공개 표면」·「모델별 필드」) 고정 테스트."""

import dataclasses
import inspect
from collections.abc import Callable
from enum import StrEnum
from typing import get_type_hints

import pytest

import minerva_rag.resource as resource
from minerva_rag.core import ChunkRecord
from minerva_rag.resource import ChunkFilter, ChunkStore, LlmRole, ModelHub, ScoredRecord

from .fakes import make_record

P = inspect.Parameter
POSITIONAL = P.POSITIONAL_OR_KEYWORD
KEYWORD_ONLY = P.KEYWORD_ONLY
EMPTY = P.empty

# (이름, 종류, 기본값) 목록. self는 뺀다
Sig = list[tuple[str, object, object]]


def _signature(func: Callable[..., object]) -> Sig:
    """self를 뺀 매개변수의 (이름, 종류, 기본값)을 돌려준다."""
    params = list(inspect.signature(func).parameters.values())
    return [(p.name, p.kind, p.default) for p in params if p.name != "self"]


def _positional(*names: str) -> Sig:
    return [(name, POSITIONAL, EMPTY) for name in names]


def _assign(target: object, name: str, value: object) -> None:
    """필드 대입을 이름으로 시도한다 (정적 검사가 frozen 대입을 막는 것을 피한다)."""
    setattr(target, name, value)


@pytest.mark.req("REQ-RAG-12.1")
@pytest.mark.req("REQ-RAG-12.2")
def test_resource_all_symbols() -> None:
    """[REQ-RAG-12.1] 공개 심볼은 정확히 다섯 개이고 모두 import된다."""
    expected = {"ChunkFilter", "ChunkStore", "LlmRole", "ModelHub", "ScoredRecord"}

    assert set(resource.__all__) == expected
    assert all(hasattr(resource, name) for name in expected)


@pytest.mark.req("REQ-RAG-12.1.2")
def test_llm_role_values() -> None:
    """[REQ-RAG-12.1.2] LlmRole은 StrEnum이고 멤버와 값이 명세와 같다."""
    assert issubclass(LlmRole, StrEnum)
    assert {m.name: m.value for m in LlmRole} == {
        "CHUNKING": "chunking",
        "TABLE_SUMMARY": "table_summary",
        "IMAGE_CAPTION": "image_caption",
    }


@pytest.mark.req("REQ-RAG-12.1")
def test_model_hub_signatures() -> None:
    """[REQ-RAG-12.1] ModelHub의 메서드 매개변수와 sync/async 구분이 명세와 같다."""
    expected: dict[str, Sig] = {
        "__init__": _positional("settings"),
        "prepare": [],
        "close": [],
        "generate": [
            *_positional("role", "prompt"),
            ("image", KEYWORD_ONLY, None),
            ("json_schema", KEYWORD_ONLY, None),
        ],
        "embed_documents": _positional("texts"),
        "embed_query": _positional("text"),
        "encode_sparse_documents": _positional("texts"),
        "encode_sparse_query": _positional("text"),
        "rerank": _positional("query", "passages"),
        "count_tokens": _positional("text"),
        "ollama_available": [],
    }
    for name, signature in expected.items():
        assert _signature(getattr(ModelHub, name)) == signature, name
    for name in expected:
        if name in ("__init__", "count_tokens"):
            assert not inspect.iscoroutinefunction(getattr(ModelHub, name)), name
        else:
            assert inspect.iscoroutinefunction(getattr(ModelHub, name)), name
    assert isinstance(ModelHub.embedding_dimension, property)
    assert isinstance(ModelHub.embedding_model_name, property)


@pytest.mark.req("REQ-RAG-12.2")
def test_chunk_store_signatures() -> None:
    """[REQ-RAG-12.2] ChunkStore의 매개변수 이름·순서와 코루틴 여부가 명세와 같다."""
    expected: dict[str, Sig] = {
        "__init__": _positional("settings"),
        "connect": _positional("dense_dimension"),
        "close": [],
        "ping": [],
        "upsert": _positional("records", "dense", "sparse"),
        "activate_records": _positional("doc_id", "chunk_ids"),
        "delete_records_except": _positional("doc_id", "chunk_ids"),
        "delete_records": _positional("chunk_ids"),
        "delete_document": _positional("doc_id"),
        "set_document_metadata": _positional("doc_id", "name", "edition"),
        "set_latest_editions": _positional("name", "latest_doc_ids"),
        "search_dense": _positional("vector", "flt", "limit"),
        "search_sparse": _positional("vector", "flt", "limit"),
        "active_records": _positional("doc_id"),
        "active_editions": _positional("name"),
        "job_records": _positional("doc_id", "job_id"),
    }
    for name, signature in expected.items():
        func = getattr(ChunkStore, name)
        assert _signature(func) == signature, name
        assert inspect.iscoroutinefunction(func) is (name != "__init__"), name


@pytest.mark.req("REQ-RAG-12.2")
def test_chunk_filter_fields() -> None:
    """[REQ-RAG-12.2] ChunkFilter의 필드 이름·순서·기본값·타입·불변성이 명세와 같다."""
    fields = dataclasses.fields(ChunkFilter)

    assert [f.name for f in fields] == [
        "doc_ids",
        "edition_name",
        "edition_label",
        "latest_or_unversioned",
    ]
    flt = ChunkFilter()
    assert (flt.doc_ids, flt.edition_name, flt.edition_label, flt.latest_or_unversioned) == (
        None,
        None,
        None,
        False,
    )
    hints = get_type_hints(ChunkFilter)
    assert hints["doc_ids"] == tuple[str, ...] | None
    assert hints["edition_name"] == str | None
    assert hints["edition_label"] == str | None
    assert hints["latest_or_unversioned"] is bool
    with pytest.raises(dataclasses.FrozenInstanceError):
        _assign(flt, "doc_ids", ("x",))


@pytest.mark.req("REQ-RAG-12.2")
def test_scored_record_fields() -> None:
    """[REQ-RAG-12.2] ScoredRecord는 record와 score를 가진 불변 데이터다."""
    assert [f.name for f in dataclasses.fields(ScoredRecord)] == ["record", "score"]
    hints = get_type_hints(ScoredRecord)
    assert hints["record"] is ChunkRecord
    assert hints["score"] is float
    scored = ScoredRecord(record=make_record("c-1"), score=0.5)
    with pytest.raises(dataclasses.FrozenInstanceError):
        _assign(scored, "score", 1.0)
