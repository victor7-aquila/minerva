"""search 로그(MODULE.md 「로그」) 테스트."""

from pathlib import Path

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import Settings
from minerva_rag.search import SearchHit, SearchQuery
from minerva_rag.search import glossary as glossary_module

from ..resource.fakes import assert_log, assert_logs_exclude, events_named, run
from .fakes import (
    EXAMPLE_GLOSSARY,
    FakeSearchHub,
    make_searcher,
    rec,
    scripted_store,
    write_glossary,
)

Glossary = glossary_module.Glossary
_QUERY = "cert 갱신"


def _logged_search(
    settings: Settings, glossary_path: Path, *, fail: bool = False, neighbors: bool = False
) -> tuple[list[dict[str, object]], tuple[SearchHit, ...]]:
    """예시 용어집으로 검색하고 로그와 결과를 돌려준다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    records = [rec(f"c{i}", order=i, name="인증 가이드") for i in range(1, 4)]
    hub = FakeSearchHub()
    if fail:
        hub.rerank_error = RuntimeError("실패")
    searcher = make_searcher(scripted_store(records), hub, settings)
    with capture_logs() as logs:
        hits = run(searcher.search(SearchQuery(_QUERY, top_n=3, expand_neighbors=neighbors)))
    return [dict(entry) for entry in logs], hits


@pytest.mark.req("REQ-RAG-4.3.1")
def test_done_log_fields(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.3.1] search.done이 한 번 남고 글자 수·개수만 허용 필드로 담는다."""
    logs, hits = _logged_search(settings, glossary_path)

    assert_log(
        logs,
        "search.done",
        "info",
        {"query_chars", "expanded_terms", "candidates", "results", "reranked", "elapsed_ms"},
    )
    (entry,) = events_named(logs, "search.done")
    assert entry["query_chars"] == len(_QUERY)
    assert entry["results"] == len(hits)
    assert entry["reranked"] is True
    for key in ("query_chars", "expanded_terms", "candidates", "results"):
        assert isinstance(entry[key], int)


@pytest.mark.req("REQ-RAG-4.2.2")
def test_done_reranked_false_on_failure(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.2.2] 재정렬이 실패한 검색의 search.done은 reranked가 거짓이다."""
    logs, _ = _logged_search(settings, glossary_path, fail=True)

    (entry,) = events_named(logs, "search.done")
    assert entry["reranked"] is False


@pytest.mark.req("REQ-RAG-4.3.1")
def test_logs_exclude_query_and_text(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.3.1] 질의 원문·확장한 말·결과 본문·문서 이름은 로그에 들어가지 않는다."""
    logs, hits = _logged_search(settings, glossary_path, neighbors=True)

    texts = [c.text for hit in hits for c in (*hit.before, *hit.chunks, *hit.after)]
    assert texts
    assert_logs_exclude(logs, [_QUERY, "인증서", "certificate", "인증 문서", "인증 가이드", *texts])


@pytest.mark.req("REQ-RAG-4.8.3")
def test_glossary_loaded_log(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.3] 용어집을 읽으면 search.glossary_loaded가 묶음 수를 담아 남는다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    glossary = Glossary(settings)

    with capture_logs() as logs:
        glossary.load()

    assert_log(logs, "search.glossary_loaded", "info", {"groups", "terms"})
    (entry,) = events_named(logs, "search.glossary_loaded")
    assert entry["groups"] == 2


@pytest.mark.req("REQ-RAG-4.8.3")
def test_glossary_loaded_counts_only(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.3] search.glossary_loaded는 개수만 담고 용어집의 말은 담지 않는다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    glossary = Glossary(settings)

    with capture_logs() as logs:
        glossary.load()

    (entry,) = events_named(logs, "search.glossary_loaded")
    assert isinstance(entry["groups"], int)
    assert isinstance(entry["terms"], int)
    assert_logs_exclude(logs, ["인증서", "certificate", "폐기 목록", "CRL"])
