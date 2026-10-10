"""상태 알림(REQ-RAG-10.8.7) 테스트."""

import contextlib
import json
from collections.abc import Callable
from typing import Any

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import Settings
from minerva_rag.service import IndexOutcome, JobStage, JobState, JobView
from minerva_rag.service.jobs import JobFailure

from .fakes import (
    WAIT,
    FakeReceiver,
    ScriptedRunner,
    SleepRecorder,
    assert_service_log,
    go,
    install_write_failure,
    new_manager,
    notified,
    running_manager,
    settle,
    submit,
    until,
    wait_event,
    wait_state,
)

_BODY_KEYS = {"doc_id", "job_id", "version", "job_state", "index_state", "sequence"}
_INDEX_STATE_KEYS = {"searchable_version", "latest_job_id", "latest_job_state", "latest_job_stage"}
_RANK = {"queued": 0, "running": 1, "succeeded": 2, "failed": 2, "superseded": 2}
_TOKEN = "events-token-for-test"


def _first_for(receiver: FakeReceiver, job_id: str, state: str) -> dict[str, Any]:
    """그 작업의 그 상태 알림 본문(첫 시도)을 돌려준다."""
    (body,) = [b for b in receiver.firsts(job_id=job_id) if b["job_state"] == state]
    return body


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_notifications_per_change(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] queued·running·succeeded가 순번 1·2·3으로 나가고 본문이 그 시점 값이다."""

    async def scenario() -> str:
        async with running_manager(settings) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner(), version="v1")
            await notified(receiver, job_id, "succeeded")
            return job_id

    job_id = go(scenario())

    bodies = receiver.firsts(job_id=job_id)
    assert [b["job_state"] for b in bodies] == ["queued", "running", "succeeded"]
    assert [b["sequence"] for b in bodies] == [1, 2, 3]
    # 루트 IF-2: doc_id는 색인 요청의 문서, job_id는 상태가 바뀐 작업, version은 그 작업의 버전
    assert {b["doc_id"] for b in bodies} == {"doc-a"}
    assert {b["job_id"] for b in bodies} == {job_id}
    assert {b["version"] for b in bodies} == {"v1"}
    queued, running, succeeded = (b["index_state"] for b in bodies)
    assert queued["latest_job_id"] == job_id
    assert queued["latest_job_state"] == "queued"
    assert queued["searchable_version"] is None
    assert queued["latest_job_stage"] is None
    assert running["latest_job_state"] == "running"
    assert succeeded["searchable_version"] == "v1"
    assert succeeded["latest_job_state"] == "succeeded"
    assert succeeded["latest_job_stage"] is None


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_running_body_stage(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] running 알림의 index_state 단계는 chunking이다."""

    async def scenario() -> str:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(WAIT)
            job_id = await submit(manager, "doc-a", runner)
            await notified(receiver, job_id, "running")
            return job_id

    job_id = go(scenario())

    assert _first_for(receiver, job_id, "running")["index_state"]["latest_job_stage"] == "chunking"


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_body_shape(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] 모든 알림이 POST로 설정한 주소에 루트 IF-2 표의 필드만 담아 간다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await notified(receiver, job_id, "succeeded")

    go(scenario())

    assert receiver.requests
    for request in receiver.requests:
        assert request.method == "POST"
        assert request.url == settings.backend_events_url
        assert set(request.body) == _BODY_KEYS
        assert set(request.body["index_state"]) == _INDEX_STATE_KEYS


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_superseded_and_failed_notified(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] superseded·failed 알림은 바뀐 작업의 값과 종료 시점 상태를 담는다."""

    async def scenario() -> tuple[str, str]:
        async with running_manager(settings) as manager:
            blocker = ScriptedRunner(WAIT)
            await submit(manager, "doc-a", blocker, version="v1")
            await wait_event(blocker.waiting)
            old_id = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            new_id = await submit(manager, "doc-a", ScriptedRunner(), version="v3")
            await manager.fail_queued("doc-a", "DOCUMENT_DELETED", "삭제 요청")
            await notified(receiver, old_id, "superseded")
            await notified(receiver, new_id, "failed")
            return old_id, new_id

    old_id, new_id = go(scenario())

    assert receiver.states(old_id) == ["queued", "superseded"]
    assert receiver.states(new_id) == ["queued", "failed"]

    # 대체됨 알림: 대체된 작업(v2)의 값이다. 접수 한 번이 대체와 새 작업 기록을
    # 한 트랜잭션으로 하므로 그 시점의 최신 작업은 새 작업(대기)이다
    superseded = _first_for(receiver, old_id, "superseded")
    assert superseded["doc_id"] == "doc-a"
    assert superseded["job_id"] == old_id
    assert superseded["version"] == "v2"
    assert superseded["index_state"]["latest_job_id"] == new_id
    assert superseded["index_state"]["latest_job_state"] == "queued"
    assert superseded["index_state"]["latest_job_stage"] is None
    assert superseded["index_state"]["searchable_version"] is None

    # 대체됨 알림과 새 작업의 queued 알림은 서로 다른 순번을 받고 1씩 이어진다
    new_queued = _first_for(receiver, new_id, "queued")
    assert new_queued["version"] == "v3"
    assert new_queued["job_id"] == new_id
    assert new_queued["index_state"]["latest_job_id"] == new_id
    assert new_queued["sequence"] == superseded["sequence"] + 1

    # 실패 알림: 실패한 작업(v3)의 값이고 그 시점의 최신 작업은 그 작업(실패)이다
    failed = _first_for(receiver, new_id, "failed")
    assert failed["doc_id"] == "doc-a"
    assert failed["job_id"] == new_id
    assert failed["version"] == "v3"
    assert failed["index_state"]["latest_job_id"] == new_id
    assert failed["index_state"]["latest_job_state"] == "failed"
    assert failed["index_state"]["latest_job_stage"] is None
    assert failed["index_state"]["searchable_version"] is None
    assert failed["sequence"] > new_queued["sequence"]


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_state_recorded_before_notify(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] 알림 직후 조회한 상태·결과·실패 사유가 알림과 같거나 더 나중이다."""
    seen: list[tuple[str, JobView]] = []

    async def scenario() -> None:
        async with running_manager(settings) as manager:

            async def record(body: dict[str, Any]) -> None:
                seen.append((body["job_state"], await manager.get_job(body["job_id"])))

            receiver.on_receive = record
            ok_id = await submit(manager, "doc-a", ScriptedRunner(result=IndexOutcome(4, False)))
            bad = ScriptedRunner(result=JobFailure("STORE_UNAVAILABLE", "저장소 오류"))
            bad_id = await submit(manager, "doc-b", bad)
            await notified(receiver, ok_id, "succeeded")
            await notified(receiver, bad_id, "failed")
            await until(lambda: len(seen) >= len(receiver.requests))

    go(scenario())

    assert seen
    for notified_state, view in seen:
        assert _RANK[view.state.value] >= _RANK[notified_state]
        if notified_state == "succeeded":
            assert view.result is not None
        if notified_state == "failed":
            assert view.failure is not None


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_slow_receiver_not_blocking(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] 수신자가 응답하지 않아도 작업은 끝나고, 응답하면 알림이 모두 도착한다."""
    receiver.hold = lambda body: True

    async def scenario() -> str:
        async with running_manager(settings) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, job_id, JobState.SUCCEEDED)  # 알림이 막혀 있어도 끝난다
            receiver.gate.set()
            await receiver.wait_for(3)
            return job_id

    job_id = go(scenario())

    assert receiver.states(job_id) == ["queued", "running", "succeeded"]


@pytest.mark.req("REQ-RAG-10.8.7.1")
def test_per_document_order(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.1] 한 문서의 알림은 앞 알림이 끝나야 나가고 다른 문서는 기다리지 않는다."""
    receiver.hold = lambda body: body["doc_id"] == "doc-a"

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            a_id = await submit(manager, "doc-a", ScriptedRunner())
            await wait_state(manager, a_id, JobState.SUCCEEDED)
            b_id = await submit(manager, "doc-b", ScriptedRunner())
            await notified(receiver, b_id, "queued")  # 다른 문서는 막히지 않는다

            await settle()
            assert [
                r.body["sequence"] for r in receiver.select(lambda r: r.body["doc_id"] == "doc-a")
            ] == [1]

            receiver.gate.set()
            await receiver.wait_for(3, lambda r: r.body["doc_id"] == "doc-a")

    go(scenario())

    assert receiver.sequences("doc-a") == [1, 2, 3]


@pytest.mark.req("REQ-RAG-10.8.7.2")
def test_stage_changes_not_notified(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.2] 러너가 단계를 세 번 알려도 알림 수가 늘지 않는다."""

    async def scenario() -> str:
        async with running_manager(settings) as manager:
            runner = ScriptedRunner(JobStage.CHUNKING, JobStage.EMBEDDING, JobStage.STORING)
            job_id = await submit(manager, "doc-a", runner)
            await notified(receiver, job_id, "succeeded")
            return job_id

    job_id = go(scenario())

    assert receiver.states(job_id) == ["queued", "running", "succeeded"]


@pytest.mark.req("REQ-RAG-10.8.7.3")
def test_retry_backoff_then_drop(
    settings: Settings, receiver: FakeReceiver, sleeps: SleepRecorder
) -> None:
    """[REQ-RAG-10.8.7.3] 계속 실패하면 5번 더 보내고 1·2·4·8·16초 간격으로 멈춘 뒤 경고한다."""
    receiver.status = 500

    async def scenario(logs: list[Any]) -> None:
        async with running_manager(settings) as manager:
            await submit(manager, "doc-a", ScriptedRunner(WAIT))
            await receiver.wait_for(6, lambda r: r.body["sequence"] == 1)
            await until(lambda: any(e["event"] == "service.job_notify_failed" for e in logs))

    with capture_logs() as logs:
        go(scenario(logs))

    first = receiver.select(lambda r: r.body["sequence"] == 1)
    assert len(first) == 6
    assert sleeps.backoff[:5] == [1, 2, 4, 8, 16]
    found = assert_service_log(
        list(logs),
        "service.job_notify_failed",
        "warning",
        {"job_id", "doc_id", "sequence", "attempts"},
    )
    assert found[0]["sequence"] == 1


@pytest.mark.req("REQ-RAG-10.8.7.3")
def test_retry_stops_on_success(
    settings: Settings, receiver: FakeReceiver, sleeps: SleepRecorder
) -> None:
    """[REQ-RAG-10.8.7.3] 세 번째에 2xx를 받으면 거기서 멈추고 경고도 없다."""
    receiver.status = lambda body, attempt: 204 if attempt >= 3 else 500

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            await submit(manager, "doc-a", ScriptedRunner(WAIT))
            await receiver.wait_for(1, lambda r: r.body["sequence"] == 2)

    with capture_logs() as logs:
        go(scenario())

    assert len(receiver.select(lambda r: r.body["sequence"] == 1)) == 3
    assert sleeps.backoff[:2] == [1, 2]
    assert not [e for e in logs if e["event"] == "service.job_notify_failed"]


@pytest.mark.req("REQ-RAG-10.8.7.3")
def test_retry_count_setting(
    make_settings: Callable[..., Settings], receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.8.7.3] 재전송 횟수는 RAG_NOTIFY_RETRIES를 따른다."""
    receiver.status = 500

    async def scenario() -> None:
        async with running_manager(make_settings(retries=2)) as manager:
            await submit(manager, "doc-a", ScriptedRunner(WAIT))
            await receiver.wait_for(1, lambda r: r.body["sequence"] == 2)

    go(scenario())

    assert len(receiver.select(lambda r: r.body["sequence"] == 1)) == 3


@pytest.mark.req("REQ-RAG-10.8.7.3")
def test_connection_error_retried(
    settings: Settings, receiver: FakeReceiver, sleeps: SleepRecorder
) -> None:
    """[REQ-RAG-10.8.7.3] 연결 오류도 다시 보낸다."""
    receiver.raise_on = lambda body, attempt: attempt == 1

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            await submit(manager, "doc-a", ScriptedRunner(WAIT))
            await receiver.wait_for(2, lambda r: r.body["sequence"] == 1)

    go(scenario())

    first = receiver.select(lambda r: r.body["sequence"] == 1)
    assert [r.attempt for r in first] == [1, 2]
    assert sleeps.backoff[:1] == [1]


@pytest.mark.req("REQ-RAG-10.8.7.4")
def test_sequence_per_document(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.4] 순번은 문서마다 1부터 1씩 커진다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            first = await submit(manager, "doc-a", ScriptedRunner(), version="v1")
            await notified(receiver, first, "succeeded")
            second = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            await notified(receiver, second, "succeeded")
            other = await submit(manager, "doc-b", ScriptedRunner())
            await notified(receiver, other, "queued")

    go(scenario())

    assert receiver.sequences("doc-a") == [1, 2, 3, 4, 5, 6]
    assert receiver.sequences("doc-b")[0] == 1


@pytest.mark.req("REQ-RAG-10.8.7.4")
def test_retry_keeps_sequence(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.4] 다시 보낸 요청의 본문은 첫 요청과 같다."""
    receiver.status = lambda body, attempt: 500 if attempt == 1 else 204

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await receiver.wait_for(6)  # 알림 세 개가 각각 두 번씩
            await notified(receiver, job_id, "succeeded")

    go(scenario())

    by_sequence: dict[int, list[str]] = {}
    for request in receiver.requests:
        by_sequence.setdefault(request.body["sequence"], []).append(
            json.dumps(request.body, sort_keys=True)
        )
    assert sorted(by_sequence) == [1, 2, 3]
    for bodies in by_sequence.values():
        assert len(bodies) == 2
        assert bodies[0] == bodies[1]


@pytest.mark.req("REQ-RAG-10.8.7.4")
def test_sequence_survives_restart(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.4] 다시 시작해도 순번이 이어져 첫 알림이 마지막 순번 + 1이다."""

    async def scenario() -> None:
        first = await new_manager(settings)
        try:
            job_id = await submit(first, "doc-a", ScriptedRunner(), version="v1")
            await notified(receiver, job_id, "succeeded")
        finally:
            await first.stop(0)

        async with running_manager(settings) as second:
            new_id = await submit(second, "doc-a", ScriptedRunner(), version="v2")
            await notified(receiver, new_id, "queued")

    go(scenario())

    assert receiver.sequences("doc-a")[:4] == [1, 2, 3, 4]


@pytest.mark.req("REQ-RAG-10.8.7.4")
def test_failed_transaction_keeps_state(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, receiver: FakeReceiver
) -> None:
    """[REQ-RAG-10.8.7.4] 쓰기가 중간에 실패하면 상태·순번이 함께 되돌려지고 알림이 없다."""
    # ★ 관리자를 만들기 전에 건다 — 첫 쓰기 문은 통과시키고 그다음 쓰기 문부터 SQLite 오류를 낸다
    failure = install_write_failure(monkeypatch)

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            running = ScriptedRunner(WAIT)
            await submit(manager, "doc-a", running, version="v1")
            await wait_event(running.waiting)
            queued_id = await submit(manager, "doc-a", ScriptedRunner(), version="v2")
            await receiver.wait_for(3)  # 순번 1·2·3
            assert receiver.sequences("doc-a") == [1, 2, 3]

            failure.arm(passes=1)
            # 실패를 어떻게 알리는지는 명세 밖이다. 상태와 순번이 그대로인지만 본다
            with contextlib.suppress(Exception):
                await manager.fail_queued("doc-a", "DOCUMENT_DELETED", "삭제 요청")
            failure.disarm()
            assert failure.failures >= 1  # 주입이 실제로 걸렸다

            assert (await manager.get_job(queued_id)).state is JobState.QUEUED
            await settle()
            assert len(receiver.requests) == 3  # 실패한 변경의 알림은 없다

            # 같은 변경을 다시 하면 성공하고, 순번은 실패한 시도에서 소비되지 않아 4다
            await manager.fail_queued("doc-a", "DOCUMENT_DELETED", "삭제 요청")
            await notified(receiver, queued_id, "failed")

    go(scenario())

    assert receiver.sequences("doc-a") == [1, 2, 3, 4]


@pytest.mark.req("REQ-RAG-10.8.7.5")
def test_token_header_everywhere(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.5] 재전송을 포함한 모든 알림의 토큰 헤더가 설정한 토큰이다."""
    receiver.status = lambda body, attempt: 500 if attempt == 1 else 204

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            job_id = await submit(manager, "doc-a", ScriptedRunner())
            await notified(receiver, job_id, "succeeded")
            await receiver.wait_for(6)  # 알림 세 개가 각각 두 번씩

    go(scenario())

    assert len(receiver.requests) >= 6
    assert {r.headers.get("x-minerva-token") for r in receiver.requests} == {_TOKEN}


@pytest.mark.req("REQ-RAG-10.8.7.5")
def test_401_retried(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.8.7.5] 401 응답도 다른 실패와 같이 다시 보낸다."""
    receiver.status = lambda body, attempt: 401 if attempt == 1 else 204

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            await submit(manager, "doc-a", ScriptedRunner(WAIT))
            await receiver.wait_for(2, lambda r: r.body["sequence"] == 1)

    go(scenario())

    assert [r.attempt for r in receiver.select(lambda r: r.body["sequence"] == 1)] == [1, 2]
