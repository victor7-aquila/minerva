"""ChunkStore 연결 실패(REQ-RAG-12.2.1) 단위 테스트."""

import httpx
import pytest
from qdrant_client import AsyncQdrantClient
from qdrant_client.http.exceptions import UnexpectedResponse
from structlog.testing import capture_logs

from minerva_rag.core import Settings, StoreUnavailableError
from minerva_rag.resource import ChunkStore

from .fakes import STORE_CALLS, FlakyQdrant, assert_log, install_qdrant, run


async def _connected(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> tuple[ChunkStore, FlakyQdrant]:
    """연결을 끊을 수 있는 가짜 Qdrant에 connect한 ChunkStore를 돌려준다."""
    flaky = FlakyQdrant(AsyncQdrantClient(location=":memory:"))
    install_qdrant(monkeypatch, flaky)
    store = ChunkStore(settings)
    await store.connect(8)
    return store, flaky


@pytest.mark.req("REQ-RAG-12.2.1")
def test_connect_fails_when_unreachable(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """[REQ-RAG-12.2.1] connect가 Qdrant에 닿지 못하면 StoreUnavailableError이고 ping은 False다."""

    async def scenario() -> bool:
        flaky = FlakyQdrant(AsyncQdrantClient(location=":memory:"))
        flaky.down = True
        install_qdrant(monkeypatch, flaky)
        store = ChunkStore(settings)
        with pytest.raises(StoreUnavailableError) as info:
            await store.connect(8)
        assert info.value.code == "STORE_UNAVAILABLE"
        return await store.ping()

    with capture_logs() as logs:
        pinged = run(scenario())

    assert pinged is False
    assert_log(logs, "resource.store_unavailable", "warning", {"operation"})


@pytest.mark.req("REQ-RAG-12.2.1")
@pytest.mark.parametrize("method", list(STORE_CALLS))
def test_all_methods_raise_store_unavailable(
    method: str, monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """[REQ-RAG-12.2.1] 연결이 끊기면 모든 쓰기·조회 메서드가 StoreUnavailableError를 낸다."""

    async def scenario() -> None:
        store, flaky = await _connected(monkeypatch, settings)
        flaky.down = True
        with pytest.raises(StoreUnavailableError) as info:
            await STORE_CALLS[method](store)
        assert info.value.code == "STORE_UNAVAILABLE"

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2.1")
def test_ping_false_when_unreachable(monkeypatch: pytest.MonkeyPatch, settings: Settings) -> None:
    """[REQ-RAG-12.2.1] ping은 예외 없이 연결 여부를 돌려준다."""

    async def scenario() -> list[bool]:
        store, flaky = await _connected(monkeypatch, settings)
        results = [await store.ping()]
        flaky.down = True
        results.append(await store.ping())
        flaky.down = False
        results.append(await store.ping())
        return results

    assert run(scenario()) == [True, False, True]


@pytest.mark.req("REQ-RAG-12.2.1")
def test_close_unaffected_when_unreachable(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """[REQ-RAG-12.2.1] 연결이 끊겨도 close는 오류를 내지 않는다."""

    async def scenario() -> None:
        store, flaky = await _connected(monkeypatch, settings)
        flaky.down = True
        await store.close()

    run(scenario())


@pytest.mark.req("REQ-RAG-12.2.1")
def test_server_error_response_propagates(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """[REQ-RAG-12.2.1] 오류 응답은 StoreUnavailableError로 바꾸지 않고 그대로 낸다."""
    error = UnexpectedResponse(500, "Internal Server Error", b"boom", httpx.Headers())

    async def scenario() -> BaseException:
        store, flaky = await _connected(monkeypatch, settings)
        flaky.error = error
        try:
            await STORE_CALLS["active_records"](store)
        except Exception as exc:
            return exc
        raise AssertionError("오류가 나야 한다")

    raised = run(scenario())

    assert not isinstance(raised, StoreUnavailableError)
    assert isinstance(raised, UnexpectedResponse)
