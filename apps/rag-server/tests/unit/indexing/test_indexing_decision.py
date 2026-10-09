"""중복 색인 방지 결정(decide_index) 테스트 (REQ-RAG-3.5.1, 3.5.3, 3.5.4, 3.5.5).

순수 함수라 저장소·모델이 없다.
"""

import pytest

from minerva_rag.indexing import IndexDecision, decide_index


@pytest.mark.req("REQ-RAG-3.5.1")
@pytest.mark.req("REQ-RAG-3.5.4")
def test_reuse_when_checksum_matches() -> None:
    """[REQ-RAG-3.5.1] 열린 작업·force가 없고 체크섬이 같으면 현재 색인 작업으로 reuse다."""
    decision = decide_index(
        "c1", open_job_id=None, current_job_id="j-cur", current_checksum="c1", force=False
    )

    assert decision == IndexDecision("reuse", "j-cur")


@pytest.mark.req("REQ-RAG-3.5.3")
@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("current_checksum", ["c1", "other", None], ids=["same", "diff", "none"])
def test_join_open_job(force: bool, current_checksum: str | None) -> None:
    """[REQ-RAG-3.5.3] 열린 작업이 있으면 force·현재 체크섬과 관계없이 join이고 그 작업 ID다."""
    decision = decide_index(
        "c1",
        open_job_id="j-open",
        current_job_id="j-cur" if current_checksum is not None else None,
        current_checksum=current_checksum,
        force=force,
    )

    assert decision.kind == "join"
    assert decision.job_id == "j-open"


@pytest.mark.req("REQ-RAG-3.5.1")
def test_submit_when_checksum_differs() -> None:
    """[REQ-RAG-3.5.1] 열린 작업이 없고 체크섬이 다르면 submit이고 job_id가 없다."""
    decision = decide_index(
        "c1", open_job_id=None, current_job_id="j-cur", current_checksum="c0", force=False
    )

    assert decision == IndexDecision("submit", None)


@pytest.mark.req("REQ-RAG-3.5.1")
def test_submit_when_no_current_index() -> None:
    """[REQ-RAG-3.5.1] 열린 작업도 현재 색인도 없으면 submit이고 job_id가 없다."""
    decision = decide_index(
        "c1", open_job_id=None, current_job_id=None, current_checksum=None, force=False
    )

    assert decision.kind == "submit"
    assert decision.job_id is None


@pytest.mark.req("REQ-RAG-3.5.5")
def test_force_submits_same_checksum() -> None:
    """[REQ-RAG-3.5.5] force이고 열린 작업이 없으면 체크섬이 같아도 submit이다."""
    decision = decide_index(
        "c1", open_job_id=None, current_job_id="j-cur", current_checksum="c1", force=True
    )

    assert decision.kind == "submit"


@pytest.mark.req("REQ-RAG-3.5.4")
def test_reuse_distinct_from_submit() -> None:
    """[REQ-RAG-3.5.4] reuse 결정에는 job_id가 있고 submit과 구분된다."""
    decision = decide_index(
        "c1", open_job_id=None, current_job_id="j-cur", current_checksum="c1", force=False
    )

    assert decision.job_id is not None
    assert decision.kind != "submit"


@pytest.mark.req("REQ-RAG-3.5.1")
@pytest.mark.parametrize(
    ("current_job_id", "current_checksum"),
    [("j-cur", None), (None, "c1")],
    ids=["job-only", "checksum-only"],
)
def test_current_index_fields_paired(
    current_job_id: str | None, current_checksum: str | None
) -> None:
    """[REQ-RAG-3.5.1] current_job_id와 current_checksum 중 하나만 있으면 ValueError다."""
    with pytest.raises(ValueError):
        decide_index(
            "c1",
            open_job_id=None,
            current_job_id=current_job_id,
            current_checksum=current_checksum,
            force=False,
        )
