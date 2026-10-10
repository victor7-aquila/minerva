"""상태 확인(REQ-RAG-9.2.1) 테스트."""

import pytest
from fastapi.testclient import TestClient

from minerva_rag.service import Health

from .fakes import FakeLifecycle, FakeServices, lifespan_client, send, wait_until


@pytest.mark.req("REQ-RAG-9.2.1")
@pytest.mark.parametrize(
    ("qdrant", "ollama", "expected"),
    [
        (True, True, {"qdrant": "ok", "ollama": "ok"}),
        (False, True, {"qdrant": "unavailable", "ollama": "ok"}),
        (True, False, {"qdrant": "ok", "ollama": "unavailable"}),
        (False, False, {"qdrant": "unavailable", "ollama": "unavailable"}),
    ],
)
def test_health_maps_status(
    client: TestClient,
    fakes: FakeServices,
    qdrant: bool,
    ollama: bool,
    expected: dict[str, str],
) -> None:
    """[REQ-RAG-9.2.1] 연결 상태가 ok·unavailable로 옮겨져 200으로 나온다."""
    fakes.lifecycle.returns["health"] = Health(qdrant, ollama)

    response = send(client, "GET", "/v1/health", token=False)

    assert response.status_code == 200
    assert response.json() == expected


@pytest.mark.req("REQ-RAG-9.2.1", "REQ-RAG-9.3.1")
def test_health_without_token(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.2.1] 토큰이 없거나 틀려도 상태 확인은 200이다."""
    missing = send(client, "GET", "/v1/health", token=False)
    wrong = send(
        client, "GET", "/v1/health", token=False, headers={"X-Minerva-Token": "wrong-token"}
    )

    assert missing.status_code == 200
    assert wrong.status_code == 200


@pytest.mark.req("REQ-RAG-9.2.1")
def test_health_calls_only_lifecycle(client: TestClient, fakes: FakeServices) -> None:
    """[REQ-RAG-9.2.1] 상태 확인은 LifecycleService.health만 한 번 부른다."""
    send(client, "GET", "/v1/health", token=False)

    assert fakes.total_calls() == 0
    assert fakes.lifecycle.calls == [("health", ())]


@pytest.mark.req("REQ-RAG-9.2.1", "REQ-RAG-10.1.2")
def test_health_before_ready() -> None:
    """[REQ-RAG-9.2.1] 준비 전(기동이 끝나기 전)에도 상태 확인은 200이다."""
    fakes = FakeServices(FakeLifecycle(ready=False, startup="block"))

    with lifespan_client(fakes) as client:
        wait_until(lambda: fakes.lifecycle.startup_started)
        response = send(client, "GET", "/v1/health", token=False)
        fakes.lifecycle.release.set()

    assert response.status_code == 200
    # ★ health가 불린 시점에 기동은 아직 끝나지 않았다
    assert fakes.lifecycle.health_seen == [False]
