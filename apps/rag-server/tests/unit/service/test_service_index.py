"""색인 서비스(REQ-RAG-10.3) 테스트."""

import asyncio
from typing import cast

import pytest

from minerva_rag.chunking import Chunker, ChunkingMode
from minerva_rag.core import (
    ChunkingFailedError,
    FailureLocation,
    InvalidRequestError,
    JobNotFoundError,
    MinervaError,
    ModelUnavailableError,
    Settings,
    StoreUnavailableError,
    VectorDimensionMismatchError,
)
from minerva_rag.indexing import Indexer, IndexInput
from minerva_rag.service import IndexService, JobState
from minerva_rag.service.jobs import IndexOutcome, JobFailure, JobManager, JobStage

from .fakes import (
    FakeChunker,
    FakeIndexer,
    FakeJobQueue,
    FakeReceiver,
    FakeReporter,
    ReadyStub,
    Timeline,
    go,
    index_request,
    placeholder,
    running_manager,
    settle,
    wait_event,
    wait_state,
)


def _service(
    manager: JobManager, chunker: FakeChunker, indexer: FakeIndexer | None = None
) -> IndexService:
    """진짜 작업 관리자와 가짜 청킹·색인으로 색인 서비스를 만든다."""
    return IndexService(
        cast(Chunker, chunker),
        cast(Indexer, indexer if indexer is not None else FakeIndexer()),
        manager,
        ReadyStub(True),
    )


def _queue_service(
    timeline: Timeline,
) -> tuple[IndexService, FakeChunker, FakeIndexer, FakeJobQueue]:
    """가짜 작업 큐로 색인 서비스를 만든다. 모두 같은 timeline에 기록한다."""
    chunker = FakeChunker(timeline)
    indexer = FakeIndexer(timeline)
    queue = FakeJobQueue(timeline)
    service = IndexService(
        cast(Chunker, chunker), cast(Indexer, indexer), cast(JobManager, queue), ReadyStub(True)
    )
    return service, chunker, indexer, queue


@pytest.mark.req("REQ-RAG-10.3.1")
def test_submit_queues_new_job(settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 새 요청은 queued와 새 작업 ID를 돌려주고 최신 작업이 된다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, FakeChunker())
            accepted = await service.submit(index_request())
            assert accepted.outcome == "queued"
            assert accepted.job_id
            assert accepted.doc_id == "doc-a"
            assert accepted.version == "v1"
            assert (await service.index_state("doc-a")).latest_job_id == accepted.job_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_open_job_joined(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.3.1] 같은 내용이 색인 중이면 joined와 그 작업 ID를 돌려주고 새 작업이 없다."""

    async def scenario() -> None:
        chunker = FakeChunker()
        chunker.block = asyncio.Event()
        async with running_manager(settings) as manager:
            service = _service(manager, chunker)
            first = await service.submit(index_request())
            await wait_event(chunker.started)  # 첫 작업이 색인 중이다

            second = await service.submit(index_request())

            assert second.outcome == "joined"
            assert second.job_id == first.job_id
            assert (await service.index_state("doc-a")).latest_job_id == first.job_id
            # queued·running 알림이 도착한 뒤에도 queued 알림은 하나뿐이다
            await receiver.wait_for(2)
            await settle()
            queued = [b for b in receiver.firsts() if b["job_state"] == "queued"]
            assert len(queued) == 1

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_current_index_reused(settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 이미 완료한 같은 내용은 reused와 그 작업 ID를 돌려주고 새 작업이 없다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, FakeChunker())
            first = await service.submit(index_request())
            await wait_state(manager, first.job_id, JobState.SUCCEEDED)

            second = await service.submit(index_request())

            assert second.outcome == "reused"
            assert second.job_id == first.job_id
            assert (await service.index_state("doc-a")).latest_job_id == first.job_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_force_creates_new_job(settings: Settings) -> None:
    """[REQ-RAG-10.3.1] force=True는 같은 내용이 이미 색인돼 있어도 새 작업을 접수한다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, FakeChunker())
            first = await service.submit(index_request())
            await wait_state(manager, first.job_id, JobState.SUCCEEDED)
            reused = await service.submit(index_request())
            assert reused.outcome == "reused"  # force가 아니면 재사용이다

            forced = await service.submit(index_request(force=True))

            assert forced.outcome == "queued"
            assert forced.job_id not in (first.job_id, reused.job_id)
            assert (await service.index_state("doc-a")).latest_job_id == forced.job_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_force_joins_open_job(settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 같은 내용이 색인 중이면 force=True여도 합류한다(decide_index의 정함)."""

    async def scenario() -> None:
        chunker = FakeChunker()
        chunker.block = asyncio.Event()
        async with running_manager(settings) as manager:
            service = _service(manager, chunker)
            first = await service.submit(index_request())
            await wait_event(chunker.started)

            forced = await service.submit(index_request(force=True))

            assert forced.outcome == "joined"
            assert forced.job_id == first.job_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_changed_content_new_job(settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 내용이 달라지면 완료한 색인이 있어도 새 작업이다."""

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, FakeChunker())
            first = await service.submit(index_request())
            await wait_state(manager, first.job_id, JobState.SUCCEEDED)

            second = await service.submit(index_request(markdown="# 다른 제목\n\n다른 본문"))

            assert second.outcome == "queued"
            assert second.job_id != first.job_id

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_missing_placeholders_rejected(settings: Settings, receiver: FakeReceiver) -> None:
    """[REQ-RAG-10.3.1] assets에 빠진 자리표시가 있으면 개수를 담은 InvalidRequestError다."""
    markdown = (
        "# 제목\n\n"
        + placeholder("table", "t1", "표 설명")
        + "\n\n"
        + placeholder("image", "i1", "이미지 설명")
    )

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, FakeChunker())
            with pytest.raises(InvalidRequestError) as caught:
                await service.submit(index_request(markdown=markdown, assets={}))
            assert "2" in caught.value.message
            assert (await service.index_state("doc-a")).latest_job_id is None
            await settle()
            assert receiver.requests == []

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.1")
def test_extra_assets_allowed(settings: Settings) -> None:
    """[REQ-RAG-10.3.1] 쓰지 않는 asset ID가 더 있어도 접수한다."""
    markdown = "# 제목\n\n" + placeholder("table", "t1", "표 설명")

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, FakeChunker())
            accepted = await service.submit(
                index_request(markdown=markdown, assets={"t1": "표 요약", "unused": "안 쓰는 문장"})
            )
            assert accepted.outcome == "queued"

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.2")
def test_runner_order() -> None:
    """[REQ-RAG-10.3.2] 러너는 단계 알림, 청킹, 임베딩, prepared, 저장 순으로 부르고 결과가 같다."""
    timeline: Timeline = []
    service, chunker, indexer, queue = _queue_service(timeline)
    request = index_request(chunking=ChunkingMode.RULE, name="이름")

    async def scenario() -> IndexOutcome:
        await service.submit(request)
        timeline.clear()
        reporter = FakeReporter("job-x", timeline)
        return await queue.runners[0](reporter)

    outcome = go(scenario())

    names = [entry[0] for entry in timeline]
    assert names == ["stage", "split", "stage", "embed", "prepared", "stage", "write"]
    assert [entry[1] for entry in timeline if entry[0] == "stage"] == [
        JobStage.CHUNKING,
        JobStage.EMBEDDING,
        JobStage.STORING,
    ]
    assert outcome == IndexOutcome(3, True)  # 레코드 3개, 청킹 결과의 fallback_used
    assert timeline[4] == ("prepared", outcome)
    assert timeline[1] == ("split", request.markdown, ChunkingMode.RULE)
    inp = timeline[3][1]
    assert isinstance(inp, IndexInput)
    assert inp.job_id == "job-x"
    assert inp.doc_id == request.doc_id
    assert inp.version == request.version
    assert inp.markdown == request.markdown
    assert inp.assets == request.assets
    assert inp.name == "이름"
    assert inp.edition == request.edition
    assert inp.chunking_mode == "rule"
    # 저장은 embed가 돌려준 결과를 받는다
    assert timeline[6][1] is indexer.embedded[0]
    assert all(record.job_id == "job-x" for record in indexer.embedded[0].records)
    assert chunker.result.fallback_used is True


@pytest.mark.req("REQ-RAG-10.3.3")
def test_chunking_failure_skips_indexing() -> None:
    """[REQ-RAG-10.3.3] 청킹이 실패하면 CHUNKING_FAILED(위치 포함)이고 색인하지 않는다."""
    timeline: Timeline = []
    service, chunker, _, queue = _queue_service(timeline)
    location = FailureLocation(("설치", "Docker"), "t1")
    chunker.error = ChunkingFailedError(location=location)

    async def scenario() -> JobFailure:
        await service.submit(index_request())
        timeline.clear()
        with pytest.raises(JobFailure) as caught:
            await queue.runners[0](FakeReporter("job-x", timeline))
        return caught.value

    failure = go(scenario())

    assert failure.code == "CHUNKING_FAILED"
    assert failure.location == location
    names = [entry[0] for entry in timeline]
    assert "embed" not in names
    assert "write" not in names


@pytest.mark.req("REQ-RAG-10.3.3")
def test_chunking_failure_recorded(settings: Settings) -> None:
    """[REQ-RAG-10.3.3] 청킹 실패는 FAILED와 CHUNKING_FAILED·위치로 기록된다."""
    location = FailureLocation(("설치", "Docker"), "t1")
    chunker = FakeChunker()
    chunker.error = ChunkingFailedError(location=location)

    async def scenario() -> None:
        async with running_manager(settings) as manager:
            service = _service(manager, chunker)
            accepted = await service.submit(index_request())
            await wait_state(manager, accepted.job_id, JobState.FAILED)
            view = await service.get_job(accepted.job_id)
            assert view.failure is not None
            assert view.failure.code == "CHUNKING_FAILED"
            assert view.failure.location == location

    go(scenario())


@pytest.mark.req("REQ-RAG-10.3.3")
def test_chunking_failure_without_location() -> None:
    """[REQ-RAG-10.3.3] 위치를 모르는 청킹 실패는 location이 없는 CHUNKING_FAILED다."""
    timeline: Timeline = []
    service, chunker, _, queue = _queue_service(timeline)
    chunker.error = ChunkingFailedError()

    async def scenario() -> JobFailure:
        await service.submit(index_request())
        with pytest.raises(JobFailure) as caught:
            await queue.runners[0](FakeReporter("job-x", timeline))
        return caught.value

    failure = go(scenario())

    assert failure.code == "CHUNKING_FAILED"
    assert failure.location is None


@pytest.mark.req("REQ-RAG-10.3.4")
def test_store_failure_keeps_previous() -> None:
    """[REQ-RAG-10.3.4] 저장이 실패하면 STORE_UNAVAILABLE이고 이전 버전을 지우는 호출이 없다."""
    timeline: Timeline = []
    service, _, indexer, queue = _queue_service(timeline)
    indexer.write_error = StoreUnavailableError()

    async def scenario() -> JobFailure:
        await service.submit(index_request())
        timeline.clear()
        with pytest.raises(JobFailure) as caught:
            await queue.runners[0](FakeReporter("job-x", timeline))
        return caught.value

    failure = go(scenario())

    assert failure.code == "STORE_UNAVAILABLE"
    names = [entry[0] for entry in timeline]
    assert "embed" in names
    assert "write" in names
    assert "delete_document" not in names
    assert "update_metadata" not in names


@pytest.mark.req("REQ-RAG-10.3.4")
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ModelUnavailableError(), "MODEL_UNAVAILABLE"),
        (VectorDimensionMismatchError(), "VECTOR_DIMENSION_MISMATCH"),
        (StoreUnavailableError(), "STORE_UNAVAILABLE"),
    ],
)
def test_resource_errors_mapped(error: MinervaError, code: str) -> None:
    """[REQ-RAG-10.3.4] 임베딩 중 resource 오류는 그 코드의 JobFailure가 되고 저장하지 않는다."""
    timeline: Timeline = []
    service, _, indexer, queue = _queue_service(timeline)
    indexer.embed_error = error

    async def scenario() -> JobFailure:
        await service.submit(index_request())
        timeline.clear()
        with pytest.raises(JobFailure) as caught:
            await queue.runners[0](FakeReporter("job-x", timeline))
        return caught.value

    failure = go(scenario())

    assert failure.code == code
    assert "write" not in [entry[0] for entry in timeline]


@pytest.mark.req("REQ-RAG-10.8.2.4")
def test_other_errors_propagate() -> None:
    """[REQ-RAG-10.8.2.4] 그 밖의 예외는 JobFailure로 바꾸지 않고 그대로 낸다."""
    timeline: Timeline = []
    service, chunker, _, queue = _queue_service(timeline)
    chunker.error = RuntimeError("x")

    async def scenario() -> BaseException:
        await service.submit(index_request())
        with pytest.raises(RuntimeError) as caught:
            await queue.runners[0](FakeReporter("job-x", timeline))
        return caught.value

    raised = go(scenario())

    assert not isinstance(raised, JobFailure)


@pytest.mark.req("REQ-RAG-10.8.2.2")
@pytest.mark.req("REQ-RAG-10.8.6.2")
@pytest.mark.req("REQ-RAG-10.8.6.3")
def test_queries_delegate(settings: Settings) -> None:
    """[REQ-RAG-10.8.2.2] 조회 메서드는 작업 관리자의 같은 메서드 결과를 그대로 돌려준다."""

    async def scenario() -> None:
        chunker = FakeChunker()
        chunker.block = asyncio.Event()
        async with running_manager(settings) as manager:
            service = _service(manager, chunker)
            accepted = await service.submit(index_request())
            await wait_event(chunker.started)  # 색인 중으로 멈춰 상태가 바뀌지 않는다

            assert await service.get_job(accepted.job_id) == await manager.get_job(accepted.job_id)
            assert await service.index_state("doc-a") == await manager.index_state("doc-a")
            ids = ["doc-a", "none"]
            assert await service.index_states(ids) == await manager.index_states(ids)
            with pytest.raises(JobNotFoundError):
                await service.get_job("no-such-job")

    go(scenario())
