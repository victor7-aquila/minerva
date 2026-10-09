"""search 공개 표면(MODULE.md 「공개 표면」·「모델별 필드」·코드 블록) 고정 테스트.

정적 계약 검사 도구가 없어 공개 이름·시그니처를 테스트로 고정한다.
"""

import dataclasses
import inspect
from collections.abc import Callable
from datetime import date
from enum import StrEnum
from typing import Any, cast, get_type_hints

import pytest

import minerva_rag.search as search
from minerva_rag.core import ChunkKind, Edition, Settings
from minerva_rag.resource import ChunkStore, ModelHub
from minerva_rag.search import (
    DocumentChunk,
    DocumentChunks,
    EditionRef,
    EditionScope,
    ResultChunk,
    ResultEdition,
    Searcher,
    SearchHit,
    SearchQuery,
)
from minerva_rag.search import glossary as glossary_module

P = inspect.Parameter
Expansion = glossary_module.Expansion
Glossary = glossary_module.Glossary


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


@pytest.mark.req("REQ-RAG-4")
def test_all_exports() -> None:
    """[REQ-RAG-4] 공개 이름은 아홉 개뿐이고 용어집 헬퍼는 내보내지 않는다."""
    exported: dict[str, object] = {
        "DocumentChunk": DocumentChunk,
        "DocumentChunks": DocumentChunks,
        "EditionRef": EditionRef,
        "EditionScope": EditionScope,
        "ResultChunk": ResultChunk,
        "ResultEdition": ResultEdition,
        "SearchHit": SearchHit,
        "SearchQuery": SearchQuery,
        "Searcher": Searcher,
    }

    assert set(search.__all__) == set(exported)
    for name, obj in exported.items():
        assert getattr(search, name) is obj
    assert "Glossary" not in search.__all__
    assert "Expansion" not in search.__all__


@pytest.mark.req("REQ-RAG-4.5")
def test_edition_scope_values() -> None:
    """[REQ-RAG-4.5] EditionScope는 all·latest·specific 셋뿐인 StrEnum이다."""
    assert issubclass(EditionScope, StrEnum)
    assert {m.name: m.value for m in EditionScope} == {
        "ALL": "all",
        "LATEST": "latest",
        "SPECIFIC": "specific",
    }


@pytest.mark.req("REQ-RAG-4.5")
def test_edition_ref_fields() -> None:
    """[REQ-RAG-4.5] EditionRef는 기본값 없는 frozen dataclass(name, label)다."""
    _assert_frozen_fields(EditionRef, {"name": str, "label": str})


@pytest.mark.req("REQ-RAG-4.3")
def test_search_query_fields() -> None:
    """[REQ-RAG-4.3] SearchQuery는 표의 차례·타입·기본값을 가진 frozen dataclass다."""
    fields = dataclasses.fields(SearchQuery)
    with pytest.raises(dataclasses.FrozenInstanceError):
        cast(Any, SearchQuery("q")).query = "바꿈"

    assert [f.name for f in fields] == [
        "query",
        "top_n",
        "doc_ids",
        "edition_scope",
        "edition",
        "expand_neighbors",
    ]
    assert get_type_hints(SearchQuery) == {
        "query": str,
        "top_n": int | None,
        "doc_ids": tuple[str, ...] | None,
        "edition_scope": EditionScope,
        "edition": EditionRef | None,
        "expand_neighbors": bool,
    }
    assert all(f.default_factory is dataclasses.MISSING for f in fields)
    assert [f.default for f in fields] == [
        dataclasses.MISSING,
        None,
        None,
        EditionScope.ALL,
        None,
        False,
    ]


@pytest.mark.req("REQ-RAG-4.3.3")
def test_search_hit_fields() -> None:
    """[REQ-RAG-4.3.3] SearchHit은 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(
        SearchHit,
        {
            "rank": int,
            "score": float,
            "doc_id": str,
            "version": str,
            "heading_path": tuple[str, ...],
            "name": str,
            "edition": ResultEdition | None,
            "other_editions_in_results": bool,
            "chunks": tuple[ResultChunk, ...],
            "before": tuple[ResultChunk, ...],
            "after": tuple[ResultChunk, ...],
        },
    )


@pytest.mark.req("REQ-RAG-4.3.3")
def test_result_chunk_fields() -> None:
    """[REQ-RAG-4.3.3] ResultChunk는 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(
        ResultChunk,
        {
            "chunk_id": str,
            "kind": ChunkKind,
            "text": str,
            "placeholder_ids": tuple[str, ...],
            "split_index": int | None,
            "split_total": int | None,
        },
    )


@pytest.mark.req("REQ-RAG-4.5.1")
def test_result_edition_fields() -> None:
    """[REQ-RAG-4.5.1] ResultEdition은 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(ResultEdition, {"label": str, "edition_date": date, "is_latest": bool})


@pytest.mark.req("REQ-RAG-4.7")
def test_document_chunks_fields() -> None:
    """[REQ-RAG-4.7] DocumentChunks는 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(
        DocumentChunks,
        {
            "doc_id": str,
            "version": str | None,
            "name": str | None,
            "edition": Edition | None,
            "chunks": tuple[DocumentChunk, ...],
        },
    )


@pytest.mark.req("REQ-RAG-4.7.2")
def test_document_chunk_fields() -> None:
    """[REQ-RAG-4.7.2] DocumentChunk는 표의 차례·타입의 기본값 없는 frozen dataclass다."""
    _assert_frozen_fields(
        DocumentChunk,
        {
            "chunk_id": str,
            "order": int,
            "kind": ChunkKind,
            "heading_path": tuple[str, ...],
            "title": str | None,
            "summary": str | None,
            "text": str,
            "placeholder_ids": tuple[str, ...],
            "split_index": int | None,
            "split_total": int | None,
        },
    )


@pytest.mark.req("REQ-RAG-4")
def test_searcher_signatures() -> None:
    """[REQ-RAG-4] Searcher의 생성자와 동기·비동기 메서드 시그니처다."""
    init = _params(Searcher.__init__)
    assert [p.name for p in init] == ["self", "model_hub", "chunk_store", "settings"]
    assert all(p.kind is P.POSITIONAL_OR_KEYWORD for p in init)
    assert all(p.default is P.empty for p in init)
    assert [p.annotation for p in init[1:]] == [ModelHub, ChunkStore, Settings]
    assert _returns(Searcher.__init__) is None

    assert not inspect.iscoroutinefunction(Searcher.load_glossary)
    assert [p.name for p in _params(Searcher.load_glossary)] == ["self"]
    assert _returns(Searcher.load_glossary) is None

    assert inspect.iscoroutinefunction(Searcher.search)
    assert [(p.name, p.annotation) for p in _params(Searcher.search)[1:]] == [("q", SearchQuery)]
    assert _returns(Searcher.search) == tuple[SearchHit, ...]

    assert inspect.iscoroutinefunction(Searcher.document_chunks)
    assert [(p.name, p.annotation) for p in _params(Searcher.document_chunks)[1:]] == [
        ("doc_id", str)
    ]
    assert _returns(Searcher.document_chunks) is DocumentChunks


@pytest.mark.req("REQ-RAG-4.8", "REQ-RAG-4.9")
def test_glossary_helper_signatures() -> None:
    """[REQ-RAG-4.8] Glossary(settings)·load·expand는 동기이고 Expansion은 표의 필드를 가진다."""
    init = _params(Glossary.__init__)
    assert [p.name for p in init] == ["self", "settings"]
    assert init[1].annotation is Settings
    assert _returns(Glossary.__init__) is None

    assert not inspect.iscoroutinefunction(Glossary.load)
    assert [p.name for p in _params(Glossary.load)] == ["self"]
    assert _returns(Glossary.load) is None

    assert not inspect.iscoroutinefunction(Glossary.expand)
    assert [(p.name, p.annotation) for p in _params(Glossary.expand)[1:]] == [("query", str)]
    assert _returns(Glossary.expand) is Expansion

    _assert_frozen_fields(Expansion, {"matched": tuple[str, ...], "terms": tuple[str, ...]})
