"""공유 타입(SparseVector, IF-RAG-1 타입, FailureLocation) 단위 테스트."""

import dataclasses
from datetime import date

import pytest

from minerva_rag.core import (
    Chunk,
    ChunkingResult,
    ChunkKind,
    ChunkRecord,
    Edition,
    FailureLocation,
    SparseVector,
)


def _assign(target: object, name: str, value: object) -> None:
    """필드 대입을 이름으로 시도한다 (정적 검사가 frozen 대입을 막는 것을 피한다)."""
    setattr(target, name, value)


def _make_chunk() -> Chunk:
    """모든 필드를 채운 TEXT 청크를 만든다."""
    return Chunk(
        chunk_key="k1",
        kind=ChunkKind.TEXT,
        order=0,
        heading_path=("설치", "Docker"),
        title="Docker 설치",
        summary="Docker를 설치하는 방법",
        text="본문 [[minerva:table:t1 | 표]]",
        placeholder_ids=("t1",),
        split_group="g1",
        split_index=1,
        split_total=2,
    )


def _make_record(chunk: Chunk) -> ChunkRecord:
    """판 정보를 가진 청크 레코드를 만든다."""
    return ChunkRecord(
        chunk_id="c1",
        doc_id="d1",
        version="v1",
        job_id="j1",
        active=True,
        name="설치 가이드",
        edition=Edition("2025", date(2025, 1, 31)),
        is_latest_edition=True,
        chunk=chunk,
    )


@pytest.mark.req("REQ-RAG-3.2.2")
def test_sparse_vector_valid() -> None:
    """[REQ-RAG-3.2.2] 길이가 같고 indices가 겹치지 않으면 만들어진다 (빈 벡터 포함)."""
    vector = SparseVector(indices=(3, 1, 7), values=(0.5, 1.0, 0.2))
    assert vector.indices == (3, 1, 7)
    assert vector.values == (0.5, 1.0, 0.2)
    empty = SparseVector((), ())
    assert empty.indices == ()


@pytest.mark.req("REQ-RAG-3.2.2")
def test_sparse_vector_length_mismatch() -> None:
    """[REQ-RAG-3.2.2] indices와 values의 길이가 다르면 ValueError가 난다."""
    with pytest.raises(ValueError):
        SparseVector((1, 2), (0.1,))


@pytest.mark.req("REQ-RAG-3.2.2")
def test_sparse_vector_duplicate_indices() -> None:
    """[REQ-RAG-3.2.2] indices에 같은 값이 두 번 나오면 ValueError가 난다."""
    with pytest.raises(ValueError):
        SparseVector((1, 1), (0.1, 0.2))


@pytest.mark.req("REQ-RAG-3.2.2")
def test_sparse_vector_frozen() -> None:
    """[REQ-RAG-3.2.2] SparseVector는 바꿀 수 없다."""
    vector = SparseVector((1,), (0.5,))
    with pytest.raises(dataclasses.FrozenInstanceError):
        _assign(vector, "indices", (2,))


@pytest.mark.req("REQ-RAG-3")
def test_chunk_record_roundtrip() -> None:
    """[REQ-RAG-3] ChunkRecord는 넣은 필드를 그대로 돌려주고 같은 값끼리 ==·hash가 같다."""
    chunk = _make_chunk()
    record = _make_record(chunk)
    assert record.chunk is chunk
    assert record.edition == Edition("2025", date(2025, 1, 31))
    assert (record.chunk_id, record.doc_id, record.version, record.job_id) == (
        "c1",
        "d1",
        "v1",
        "j1",
    )
    assert record.active is True
    assert record.name == "설치 가이드"
    assert record.is_latest_edition is True
    same = _make_record(_make_chunk())
    assert record == same
    assert hash(record) == hash(same)


@pytest.mark.req("REQ-RAG-2")
def test_chunk_kind_values() -> None:
    """[REQ-RAG-2] ChunkKind는 text·asset 두 값뿐인 문자열 열거형이다."""
    assert ChunkKind.TEXT == "text"
    assert ChunkKind.ASSET == "asset"
    assert len(list(ChunkKind)) == 2
    assert isinstance(ChunkKind.TEXT, str)


@pytest.mark.req("REQ-RAG-2")
def test_shared_types_frozen() -> None:
    """[REQ-RAG-2] 공유 타입 인스턴스는 필드를 바꿀 수 없다."""
    chunk = _make_chunk()
    instances: list[tuple[object, str]] = [
        (chunk, "order"),
        (ChunkingResult(chunks=(chunk,), fallback_used=False), "fallback_used"),
        (Edition("2025", date(2025, 1, 31)), "label"),
        (_make_record(chunk), "active"),
        (FailureLocation(None, None), "placeholder_id"),
    ]
    for instance, field in instances:
        with pytest.raises(dataclasses.FrozenInstanceError):
            _assign(instance, field, None)


@pytest.mark.req("REQ-RAG-10.8.2.5")
def test_failure_location_optional() -> None:
    """[REQ-RAG-10.8.2.5] FailureLocation의 두 필드는 모두 없을 수 있고 값은 그대로 유지된다."""
    empty = FailureLocation(None, None)
    assert empty.heading_path is None
    assert empty.placeholder_id is None
    full = FailureLocation(("설치", "Docker"), "t1")
    assert full.heading_path == ("설치", "Docker")
    assert full.placeholder_id == "t1"
