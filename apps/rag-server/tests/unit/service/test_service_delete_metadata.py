"""문서 삭제 서비스(REQ-RAG-10.5)와 이름·판 정보 서비스(REQ-RAG-10.6) 테스트."""

import asyncio
from typing import cast

import pytest

from minerva_rag.core import Settings
from minerva_rag.indexing import Indexer
from minerva_rag.service import DeleteService, JobState, MetadataService

from .fakes import (
    WAIT,
    FakeIndexer,
    FakeReceiver,
    ReadyStub,
    ScriptedRunner,
    Timeline,
    go,
    make_edition,
    new_manager,
    notified,
    settle,
    started_spy,
    submit,
    wait_event,
    wait_state,
)

_ORDER = ("fail_queued", "wait_running", "delete_document", "forget_document")


def _names(timeline: Timeline) -> list[str]:
    """timeline의 호출 이름만 순서대로 돌려준다."""
    return [entry[0] for entry in timeline]


@pytest.mark.req("REQ-RAG-10.5.1")
@pytest.mark.req("REQ-RAG-10.5.2")
def test_delete_order(settings: Settings) -> None:
    """[REQ-RAG-10.5.1] 삭제는 fail_queued가 맨 먼저이고 대기 → 청크 삭제 → 상태 비우기 순이다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        spy = await started_spy(settings, timeline)
        service = DeleteService(cast(Indexer, FakeIndexer(timeline)), spy, ReadyStub(True))
        try:
            await service.delete("doc-a")
        finally:
            await spy.stop(0)
        return timeline

    timeline = go(scenario())

    assert timeline[0] == ("fail_queued", "doc-a", "DOCUMENT_DELETED", timeline[0][3])
    ordered = [entry for entry in timeline if entry[0] in _ORDER]
    assert [entry[0] for entry in ordered] == list(_ORDER)
    assert ordered[1] == ("wait_running", "doc-a")
    assert ordered[2] == ("delete_document", "doc-a")
    assert ordered[3] == ("forget_document", "doc-a")


@pytest.mark.req("REQ-RAG-10.5.1")
def test_fail_queued_scope(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.5.1] fail_queued는 그 문서의 QUEUED 작업만 실패시키고 알림을 하나씩 보낸다."""

    async def scenario() -> None:
        manager = await new_manager(settings)  # 동시 실행 상한 1
        try:
            a1 = ScriptedRunner(WAIT)
            a2 = ScriptedRunner()
            b1 = ScriptedRunner()
            a1_id = await submit(manager, "doc-a", a1)
            await wait_event(a1.waiting)
            a2_id = await submit(manager, "doc-a", a2, version="v2")
            b1_id = await submit(manager, "doc-b", b1)

            await manager.fail_queued("doc-a", "DOCUMENT_DELETED", "삭제 요청")
            await notified(receiver, a2_id, "failed")

            view = await manager.get_job(a2_id)
            assert view.state is JobState.FAILED
            assert view.failure is not None
            assert view.failure.code == "DOCUMENT_DELETED"
            assert view.failure.message == "삭제 요청"
            assert (await manager.get_job(a1_id)).state is JobState.RUNNING
            assert (await manager.get_job(b1_id)).state is JobState.QUEUED
            # 그 호출로 생긴 알림은 A2의 failed 하나뿐이다
            await settle()
            failed = [b for b in receiver.firsts() if b["job_state"] == "failed"]
            assert [b["job_id"] for b in failed] == [a2_id]

            a1.release.set()
            await wait_state(manager, b1_id, JobState.SUCCEEDED)
            assert a2.calls == 0
        finally:
            await manager.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.5.2")
def test_delete_waits_running(settings: Settings) -> None:
    """[REQ-RAG-10.5.2] 삭제는 색인 중인 작업이 끝난 뒤에 청크를 지우고 상태를 비운다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        spy = await started_spy(settings, timeline)
        service = DeleteService(cast(Indexer, FakeIndexer(timeline)), spy, ReadyStub(True))
        try:
            a1 = ScriptedRunner(WAIT)
            a2 = ScriptedRunner()
            a1_id = await submit(spy, "doc-a", a1)
            await wait_event(a1.waiting)
            a2_id = await submit(spy, "doc-a", a2, version="v2")

            task = asyncio.create_task(service.delete("doc-a"))
            await wait_event(spy.entered_wait)

            # 기다리는 동안: 대기 작업은 실패했고 청크 삭제는 아직 없다
            await wait_state(spy, a2_id, JobState.FAILED)
            failure = (await spy.get_job(a2_id)).failure
            assert failure is not None
            assert failure.code == "DOCUMENT_DELETED"
            await settle()
            assert not task.done()
            assert "delete_document" not in _names(timeline)

            a1.release.set()
            await asyncio.wait_for(task, 5)
            assert a2.calls == 0
            assert (await spy.get_job(a1_id)).state is JobState.SUCCEEDED
            assert (await spy.index_state("doc-a")).searchable_version is None
        finally:
            await spy.stop(0)
        return timeline

    timeline = go(scenario())

    names = _names(timeline)
    assert names.index("delete_document") < names.index("forget_document")


@pytest.mark.req("REQ-RAG-10.5.2")
def test_wait_running_returns_after_job(settings: Settings) -> None:
    """[REQ-RAG-10.5.2] wait_running은 그 문서의 RUNNING 작업이 끝난 뒤에 돌아온다."""

    async def scenario() -> None:
        manager = await new_manager(settings)
        try:
            runner = ScriptedRunner(WAIT)
            job_id = await submit(manager, "doc-a", runner)
            await wait_event(runner.waiting)

            task = asyncio.create_task(manager.wait_running("doc-a"))
            await settle()
            assert not task.done()

            runner.release.set()
            await asyncio.wait_for(task, 5)
            assert (await manager.get_job(job_id)).state is JobState.SUCCEEDED
        finally:
            await manager.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.5.2")
def test_wait_running_without_running(settings: Settings) -> None:
    """[REQ-RAG-10.5.2] RUNNING 작업이 없으면 wait_running은 곧바로 돌아온다."""

    async def scenario() -> None:
        manager = await new_manager(settings)
        try:
            await asyncio.wait_for(manager.wait_running("doc-a"), 5)  # 작업 없는 문서

            blocker = ScriptedRunner(WAIT)
            await submit(manager, "doc-x", blocker)
            await wait_event(blocker.waiting)
            queued = ScriptedRunner()
            await submit(manager, "doc-b", queued)  # 상한 1이라 대기 작업만 있는 문서
            await asyncio.wait_for(manager.wait_running("doc-b"), 5)
            assert queued.calls == 0
        finally:
            await manager.stop(0)

    go(scenario())


@pytest.mark.req("REQ-RAG-10.6.1")
def test_metadata_waits_running(settings: Settings) -> None:
    """[REQ-RAG-10.6.1] 이름·판 변경은 색인 중인 작업이 끝난 뒤에 한 번 일어난다."""
    edition = make_edition()

    async def scenario() -> Timeline:
        timeline: Timeline = []
        spy = await started_spy(settings, timeline)
        service = MetadataService(cast(Indexer, FakeIndexer(timeline)), spy, ReadyStub(True))
        try:
            runner = ScriptedRunner(WAIT)
            await submit(spy, "doc-a", runner)
            await wait_event(runner.waiting)

            task = asyncio.create_task(service.update("doc-a", "새 이름", edition))
            await wait_event(spy.entered_wait)
            await settle()
            assert not task.done()
            assert "update_metadata" not in _names(timeline)

            runner.release.set()
            await asyncio.wait_for(task, 5)
        finally:
            await spy.stop(0)
        return timeline

    timeline = go(scenario())

    names = _names(timeline)
    assert names.count("update_metadata") == 1
    assert names.index("wait_running") < names.index("update_metadata")
    assert ("update_metadata", "doc-a", "새 이름", edition) in timeline


@pytest.mark.req("REQ-RAG-10.6.1")
def test_metadata_without_running(settings: Settings) -> None:
    """[REQ-RAG-10.6.1] 색인 중인 작업이 없으면 wait_running 뒤에 곧바로 변경한다."""

    async def scenario() -> Timeline:
        timeline: Timeline = []
        spy = await started_spy(settings, timeline)
        service = MetadataService(cast(Indexer, FakeIndexer(timeline)), spy, ReadyStub(True))
        try:
            await asyncio.wait_for(service.update("doc-a", "새 이름", None), 5)
        finally:
            await spy.stop(0)
        return timeline

    timeline = go(scenario())

    ordered = [entry for entry in timeline if entry[0] in ("wait_running", "update_metadata")]
    assert ordered == [("wait_running", "doc-a"), ("update_metadata", "doc-a", "새 이름", None)]
