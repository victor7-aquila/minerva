"""문서 청크 조회(REQ-RAG-4.7) 테스트."""

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import ChunkKind, ChunkRecord, Settings
from minerva_rag.search import DocumentChunks

from ..resource.fakes import assert_log, events_named, make_edition, run
from .fakes import (
    BACKENDS,
    FakeSearchHub,
    FakeSearchStore,
    as_store,
    backend_store,
    make_searcher,
    rec,
)


async def _fetch(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    records: list[ChunkRecord],
    doc_id: str = "doc-1",
) -> DocumentChunks:
    """backend 위에서 문서 청크를 조회한다."""
    async with backend_store(backend, monkeypatch, records) as store:
        return await make_searcher(store, FakeSearchHub(), settings).document_chunks(doc_id)


def _mixed_document() -> tuple[list[ChunkRecord], list[str]]:
    """순서가 뒤섞인 한 문서의 레코드와 기대하는 문서 순서를 돌려준다."""
    t0 = rec("t0", order=0)
    t1 = rec("t1", order=1, placeholder_ids=("p2", "p1"))
    a1 = rec("a1", order=1, kind=ChunkKind.ASSET, pid="p1")
    a2 = rec("a2", order=1, kind=ChunkKind.ASSET, pid="p2")
    s1 = rec("s1", order=2, split=("g", 1, 2))
    s2 = rec("s2", order=2, split=("g", 2, 2))
    return [s2, a1, t1, s1, a2, t0], ["t0", "t1", "a2", "a1", "s1", "s2"]


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_order(backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    """[REQ-RAG-4.7.1] 뒤섞여 저장된 레코드가 본문·조각, 표·이미지 차례의 문서 순서로 나온다."""
    records, expected = _mixed_document()

    result = run(_fetch(backend, monkeypatch, settings, records))

    assert [c.chunk_id for c in result.chunks] == expected
    assert result.version == "v1"


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_version(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.7.1] version이 active 레코드의 버전이고 chunks는 그 버전의 레코드뿐이다."""
    records = [
        rec("o1", version="v1", active=False, order=1),
        rec("o2", version="v1", active=False, order=2),
        rec("n1", version="v2", order=1),
        rec("n2", version="v2", order=2),
    ]

    result = run(_fetch(backend, monkeypatch, settings, records))

    assert result.version == "v2"
    assert [c.chunk_id for c in result.chunks] == ["n1", "n2"]


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_name_and_edition(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.7.1] 문서 이름과 판 정보가 레코드 값 그대로다."""
    edition = make_edition("2025")
    records = [rec("a", name="표준", edition=edition, latest=True)]

    result = run(_fetch(backend, monkeypatch, settings, records))

    assert result.doc_id == "doc-1"
    assert result.name == "표준"
    assert result.edition == edition


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.7.2")
def test_document_chunk_fields(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.7.2] 모든 DocumentChunk의 필드가 레코드 값 그대로다."""
    records = [
        rec("t", order=1, heading_path=("가", "나"), placeholder_ids=("p1",)),
        rec("a", order=1, kind=ChunkKind.ASSET, pid="p1", heading_path=("가", "나")),
        rec("s1", order=2, split=("g", 1, 2)),
        rec("s2", order=2, split=("g", 2, 2)),
    ]
    by_id = {r.chunk_id: r for r in records}

    result = run(_fetch(backend, monkeypatch, settings, records))

    assert {c.chunk_id for c in result.chunks} == set(by_id)
    for chunk in result.chunks:
        source = by_id[chunk.chunk_id].chunk
        assert chunk.order == source.order
        assert chunk.kind == source.kind
        assert chunk.heading_path == source.heading_path
        assert chunk.title == source.title
        assert chunk.summary == source.summary
        assert chunk.text == source.text
        assert chunk.placeholder_ids == source.placeholder_ids
        assert chunk.split_index == source.split_index
        assert chunk.split_total == source.split_total


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.7.3")
def test_document_without_active(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.7.3] active 레코드가 없는 문서면 version이 None이고 chunks가 비어 있다."""
    records = [rec("x", doc_id="inactive-doc", active=False)]

    missing = run(_fetch(backend, monkeypatch, settings, records, "no-such-doc"))
    inactive = run(_fetch(backend, monkeypatch, settings, records, "inactive-doc"))

    for result in (missing, inactive):
        assert result.version is None
        assert result.chunks == ()


@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_chunks_no_writes(settings: Settings) -> None:
    """[REQ-RAG-4.7.1] 문서 청크 조회는 저장소에 쓰지 않는다."""
    store = FakeSearchStore()
    store.add(*_mixed_document()[0])

    run(make_searcher(as_store(store), FakeSearchHub(), settings).document_chunks("doc-1"))

    assert store.writes() == []


def _two_versions() -> list[ChunkRecord]:
    """v2 레코드 3개 뒤에 v1 레코드 2개를 넣은 모두 active인 문서다."""
    return [
        rec("n2", version="v2", order=2),
        rec("n0", version="v2", order=0),
        rec("n1", version="v2", order=1),
        rec("o1", version="v1", order=1),
        rec("o0", version="v1", order=0),
    ]


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_multiple_versions_last(
    backend: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[REQ-RAG-4.7.1] 두 버전이 함께 active면 버전이 v2이고 v2의 청크만 문서 순서로 나온다."""
    result = run(_fetch(backend, monkeypatch, settings, _two_versions()))

    assert result.version == "v2"
    assert [c.chunk_id for c in result.chunks] == ["n0", "n1", "n2"]


@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_multiple_versions_warns(settings: Settings) -> None:
    """[REQ-RAG-4.7.1] 두 버전이 함께 active면 search.multiple_active_versions 경고를 남긴다."""
    store = FakeSearchStore()
    store.add(*_two_versions())
    searcher = make_searcher(as_store(store), FakeSearchHub(), settings)

    with capture_logs() as logs:
        run(searcher.document_chunks("doc-1"))

    assert_log(logs, "search.multiple_active_versions", "warning", {"doc_id", "versions"})
    (entry,) = events_named(logs, "search.multiple_active_versions")
    assert entry["doc_id"] == "doc-1"
    assert entry["versions"] == 2


@pytest.mark.req("REQ-RAG-4.7.1")
def test_document_single_version_no_warning(settings: Settings) -> None:
    """[REQ-RAG-4.7.1] 버전이 하나인 문서는 경고를 남기지 않는다."""
    store = FakeSearchStore()
    store.add(*_mixed_document()[0])
    searcher = make_searcher(as_store(store), FakeSearchHub(), settings)

    with capture_logs() as logs:
        run(searcher.document_chunks("doc-1"))

    assert events_named(logs, "search.multiple_active_versions") == []
