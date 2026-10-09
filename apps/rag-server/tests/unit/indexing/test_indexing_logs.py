"""indexing 로그(MODULE.md 「로그」) 테스트.

`structlog.testing.capture_logs()`로 잡는다. 허용 필드 밖의 키와 본문·요약·이름이 새지 않는지 본다.
"""

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import Chunk, Settings, StoreUnavailableError
from minerva_rag.indexing import EmbeddedChunks, Indexer

from .fakes import (
    FakeChunkStore,
    as_store,
    asset_chunk,
    chunking_result,
    edition,
    make_indexer,
    make_input,
    run,
    text_chunk,
)

SECRET_BODY = "SECRET-BODY"
SECRET_HINT = "SECRET-HINT"
SECRET_NAME = "SECRET-NAME"
ASSETS = {"t1": f"{SECRET_HINT} 환경 변수 요약", "i1": f"{SECRET_HINT} 구성 캡션"}

WRITE_KEYS = {"event", "log_level", "doc_id", "version", "chunks", "removed"}
FAILED_KEYS = {"event", "log_level", "doc_id", "version", "cleanup_ok"}
DELETE_KEYS = {"event", "log_level", "doc_id", "had_records"}
METADATA_KEYS = {"event", "log_level", "doc_id", "name_changed", "edition_changed"}
EVENT_NAMES = {"indexing.write", "indexing.write_failed", "indexing.delete", "indexing.metadata"}


def _chunks() -> list[Chunk]:
    """표지 문자열을 담은 본문과 표·이미지 청크를 만든다."""
    return [
        text_chunk("k-1", f"{SECRET_BODY} [[minerva:table:t1 | 표]] 본문", order=0),
        text_chunk("k-2", f"{SECRET_BODY} 두 번째 본문", order=1),
        asset_chunk("k-t1", "table", "t1", "표", order=2),
        asset_chunk("k-i1", "image", "i1", "그림", order=3),
    ]


async def _embed(indexer: Indexer, version: str, job_id: str) -> EmbeddedChunks:
    """표지 문자열이 든 입력으로 embed한다."""
    inp = make_input(
        doc_id="doc-1",
        version=version,
        job_id=job_id,
        name=SECRET_NAME,
        edition=edition(2025),
        assets=ASSETS,
    )
    return await indexer.embed(inp, chunking_result(_chunks()))


def _events(logs: list[dict[str, object]], name: str) -> list[dict[str, object]]:
    """이름이 같은 이벤트만 고른다."""
    return [entry for entry in logs if entry["event"] == name]


def _own(logs: list[dict[str, object]]) -> list[dict[str, object]]:
    """indexing 이벤트만 고른다."""
    return [entry for entry in logs if str(entry["event"]).startswith("indexing.")]


@pytest.mark.req("REQ-RAG-3.3.3")
def test_write_log(settings: Settings) -> None:
    """[REQ-RAG-3.3.3] 성공한 write 뒤 indexing.write가 info로 하나 남고 필드가 허용 안이다."""

    async def scenario() -> tuple[EmbeddedChunks, list[dict[str, object]]]:
        indexer, _ = make_indexer(as_store(FakeChunkStore()), settings)
        embedded = await _embed(indexer, "v1", "job-1")
        with capture_logs() as logs:
            await indexer.write(embedded)
        return embedded, [dict(entry) for entry in logs]

    embedded, logs = run(scenario())

    found = _events(logs, "indexing.write")
    assert len(found) == 1
    entry = found[0]
    assert entry["log_level"] == "info"
    assert set(entry) <= WRITE_KEYS
    assert entry["doc_id"] == "doc-1"
    assert entry["version"] == "v1"
    assert entry["chunks"] == len(embedded.records)


@pytest.mark.req("REQ-RAG-10.3.4")
@pytest.mark.parametrize("cleanup_ok", [True, False])
def test_write_failed_log(settings: Settings, cleanup_ok: bool) -> None:
    """[REQ-RAG-10.3.4] 저장 실패면 indexing.write_failed가 warning으로 남고 write 로그는 없다."""

    async def scenario() -> list[dict[str, object]]:
        store = FakeChunkStore()
        indexer, _ = make_indexer(as_store(store), settings)
        embedded = await _embed(indexer, "v1", "job-1")
        store.fail["upsert"] = StoreUnavailableError()
        store.partial_upsert = 1
        store.down_after_failure = not cleanup_ok
        with capture_logs() as logs, pytest.raises(StoreUnavailableError):
            await indexer.write(embedded)
        return [dict(entry) for entry in logs]

    logs = run(scenario())

    found = _events(logs, "indexing.write_failed")
    assert len(found) == 1
    entry = found[0]
    assert entry["log_level"] == "warning"
    assert set(entry) <= FAILED_KEYS
    assert entry["doc_id"] == "doc-1"
    assert entry["version"] == "v1"
    assert entry["cleanup_ok"] is cleanup_ok
    assert _events(logs, "indexing.write") == []


@pytest.mark.req("REQ-RAG-3.4.1")
@pytest.mark.req("REQ-RAG-3.4.3")
def test_delete_log(settings: Settings) -> None:
    """[REQ-RAG-3.4.1] 삭제 끝에 indexing.delete가 info로 남고 had_records가 레코드 유무다."""

    async def scenario() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        indexer, _ = make_indexer(as_store(FakeChunkStore()), settings)
        await indexer.write(await _embed(indexer, "v1", "job-1"))
        with capture_logs() as existing:
            await indexer.delete_document("doc-1")
        with capture_logs() as missing:
            await indexer.delete_document("nope")
        return [dict(e) for e in existing], [dict(e) for e in missing]

    existing, missing = run(scenario())

    found = _events(existing, "indexing.delete")
    assert len(found) == 1
    assert found[0]["log_level"] == "info"
    assert set(found[0]) <= DELETE_KEYS
    assert found[0]["doc_id"] == "doc-1"
    assert found[0]["had_records"] is True
    absent = _events(missing, "indexing.delete")
    assert len(absent) == 1
    assert absent[0]["had_records"] is False


@pytest.mark.req("REQ-RAG-3.6.5")
def test_metadata_log(settings: Settings) -> None:
    """[REQ-RAG-3.6.5] update_metadata 끝에 indexing.metadata가 info로 남고 바뀐 항목이 표시된다."""

    async def scenario() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        indexer, _ = make_indexer(as_store(FakeChunkStore()), settings)
        await indexer.write(await _embed(indexer, "v1", "job-1"))
        with capture_logs() as renamed:
            await indexer.update_metadata("doc-1", "새 이름", edition(2025))
        with capture_logs() as reedited:
            await indexer.update_metadata("doc-1", "새 이름", edition(2020))
        return [dict(e) for e in renamed], [dict(e) for e in reedited]

    renamed, reedited = run(scenario())

    name_only = _events(renamed, "indexing.metadata")
    assert len(name_only) == 1
    assert name_only[0]["log_level"] == "info"
    assert set(name_only[0]) <= METADATA_KEYS
    assert name_only[0]["doc_id"] == "doc-1"
    assert name_only[0]["name_changed"] is True
    assert name_only[0]["edition_changed"] is False
    edition_only = _events(reedited, "indexing.metadata")
    assert len(edition_only) == 1
    assert edition_only[0]["name_changed"] is False
    assert edition_only[0]["edition_changed"] is True


@pytest.mark.req("REQ-RAG-3.1.1")
def test_logs_exclude_text_and_hints(settings: Settings) -> None:
    """[REQ-RAG-3.1.1] 로그에 본문·요약·캡션 문장·이름이 없고 이벤트 이름은 정해진 넷뿐이다."""

    async def scenario() -> list[dict[str, object]]:
        store = FakeChunkStore()
        indexer, _ = make_indexer(as_store(store), settings)
        with capture_logs() as logs:
            first = await _embed(indexer, "v1", "job-1")
            await indexer.write(first)
            second = await _embed(indexer, "v2", "job-2")
            store.fail["upsert"] = StoreUnavailableError()
            with pytest.raises(StoreUnavailableError):
                await indexer.write(second)
            store.fail.clear()
            await indexer.update_metadata("doc-1", f"{SECRET_NAME}-2", edition(2020))
            await indexer.recover("doc-1", "job-1")
            await indexer.delete_document("doc-1")
        return [dict(entry) for entry in logs]

    logs = run(scenario())

    assert {str(entry["event"]) for entry in _own(logs)} <= EVENT_NAMES
    for entry in logs:
        for key, value in entry.items():
            for forbidden in (SECRET_BODY, SECRET_HINT, SECRET_NAME):
                assert forbidden not in str(value), f"{key} 값에 금지 내용이 있다"
