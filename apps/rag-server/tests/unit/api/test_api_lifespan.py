"""수명주기 연결(REQ-RAG-10.1.2, REQ-RAG-10.1.3, REQ-RAG-12.1.1) 테스트."""

from collections.abc import Callable

import pytest
from structlog.testing import capture_logs

from minerva_rag.api import create_app
from minerva_rag.core import (
    GlossaryError,
    ModelLoadError,
    ServerNotReadyError,
    StoreUnavailableError,
)

from .fakes import (
    ExitCall,
    FakeLifecycle,
    FakeServices,
    assert_event,
    lifespan_client,
    send,
    wait_until,
)


@pytest.mark.req("REQ-RAG-10.1.2")
def test_startup_runs_in_background() -> None:
    """[REQ-RAG-10.1.2] 기동이 끝나지 않아도 앱이 요청을 받기 시작하고 상태 확인이 200이다."""
    fakes = FakeServices(FakeLifecycle(ready=False, startup="block"))

    # ★ 기동을 기다렸다면 여기서 막힌다 (가짜 기동은 5초 상한에 TimeoutError를 낸다)
    with lifespan_client(fakes) as client:
        wait_until(lambda: fakes.lifecycle.startup_started)
        response = send(client, "GET", "/v1/health", token=False)
        still_running = not fakes.lifecycle.startup_finished

    assert response.status_code == 200
    assert still_running


@pytest.mark.req("REQ-RAG-10.1.2")
def test_requests_during_startup_get_not_ready() -> None:
    """[REQ-RAG-10.1.2] 준비 중 요청은 service가 판단한 503 SERVER_NOT_READY를 그대로 받는다."""
    fakes = FakeServices(FakeLifecycle(ready=False, startup="block"))
    fakes.search.raises["search"] = ServerNotReadyError()

    with lifespan_client(fakes) as client:
        wait_until(lambda: fakes.lifecycle.startup_started)
        response = send(client, "POST", "/v1/search", json={"query": "q"})

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVER_NOT_READY"


@pytest.mark.req("REQ-RAG-10.1.3")
def test_shutdown_awaited_on_exit() -> None:
    """[REQ-RAG-10.1.3] 앱이 종료되면 LifecycleService.shutdown을 기다린다."""
    fakes = FakeServices(FakeLifecycle(startup="ok"))

    with lifespan_client(fakes) as client:
        wait_until(lambda: fakes.lifecycle.startup_finished)
        assert send(client, "GET", "/v1/health", token=False).status_code == 200
        assert fakes.lifecycle.shutdown_calls == 0

    assert fakes.lifecycle.shutdown_calls == 1
    # ★ 가짜 shutdown은 양보한 뒤에야 끝 표시를 세운다. 기다리지 않고 던져 두었다면 아직 거짓이다
    assert fakes.lifecycle.shutdown_finished


@pytest.mark.req("REQ-RAG-12.1.1")
def test_startup_success_does_not_exit(exit_calls: list[ExitCall]) -> None:
    """[REQ-RAG-12.1.1] 기동이 성공하면 프로세스를 끝내지 않는다."""
    fakes = FakeServices(FakeLifecycle(startup="ok"))

    with lifespan_client(fakes):
        wait_until(lambda: fakes.lifecycle.startup_finished)

    assert exit_calls == []


_FAILURES: list[Callable[[], BaseException]] = [
    ModelLoadError,
    StoreUnavailableError,
    GlossaryError,
    lambda: RuntimeError("x"),
]


@pytest.mark.req("REQ-RAG-12.1.1")
@pytest.mark.parametrize(
    "make_error", _FAILURES, ids=["model-load", "store", "glossary", "runtime"]
)
def test_startup_failure_exits_process(
    exit_calls: list[ExitCall], make_error: Callable[[], BaseException]
) -> None:
    """[REQ-RAG-12.1.1] 기동이 어떤 예외로 실패해도 프로세스 종료 함수를 정확히 한 번 부른다."""
    fakes = FakeServices(FakeLifecycle(startup="fail", startup_error=make_error()))

    with lifespan_client(fakes):
        wait_until(lambda: len(exit_calls) >= 1)

    assert len(exit_calls) == 1


@pytest.mark.req("REQ-RAG-12.1.1")
def test_startup_failure_logged(exit_calls: list[ExitCall]) -> None:
    """[REQ-RAG-12.1.1] 기동 실패는 error_type만 담은 api.startup_failed 오류 로그를 남긴다."""
    fakes = FakeServices(FakeLifecycle(startup="fail", startup_error=ModelLoadError()))
    # ★ 앱을 만든 뒤에 로그 수집을 연다 (create_app이 로그 구성을 한다)
    app = create_app(fakes.services)

    with capture_logs() as logs, lifespan_client(fakes, app):
        wait_until(lambda: len(exit_calls) >= 1)

    found = assert_event(logs, "api.startup_failed", "error", {"error_type"})
    assert [entry["error_type"] for entry in found] == ["ModelLoadError"]


@pytest.mark.req("REQ-RAG-12.1.1")
def test_startup_failure_exit_code_is_nonzero(exit_calls: list[ExitCall]) -> None:
    """[REQ-RAG-12.1.1] 기동 실패로 끝낼 때 종료 코드는 0이 아니다 (값은 구현 재량)."""
    fakes = FakeServices(FakeLifecycle(startup="fail", startup_error=ModelLoadError()))

    with lifespan_client(fakes):
        wait_until(lambda: len(exit_calls) >= 1)

    (call,) = exit_calls
    assert call.code is not None, "종료 코드를 정수로 넘겨야 0이 아님을 알 수 있다"
    assert call.code != 0
