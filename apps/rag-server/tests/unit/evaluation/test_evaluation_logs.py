"""evaluation 로그(MODULE.md 「로그」) 테스트."""

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import Settings

from ..resource.fakes import assert_log, assert_logs_exclude, events_named, run
from .fakes import DOC_ID, FIRST, SECOND, FakeSearcher, case, hit, make_evaluator, searchable_doc


@pytest.mark.req("REQ-RAG-6.3.1")
def test_done_log_fields(settings: Settings) -> None:
    """[REQ-RAG-6.3.1] evaluation.done은 info로 허용 필드만 담아 한 번 남는다."""
    fake = FakeSearcher([hit(1, SECOND, before=[FIRST])])
    with capture_logs() as logs:
        run(make_evaluator(fake, settings).evaluate(case(top_n=5)))
    assert_log(
        logs, "evaluation.done", "info", {"doc_id", "n", "base_rank", "expanded_rank", "elapsed_ms"}
    )
    found = events_named(logs, "evaluation.done")
    assert len(found) == 1
    entry = found[0]
    assert entry["doc_id"] == DOC_ID
    assert entry["n"] == 5
    assert entry["base_rank"] is None
    assert entry["expanded_rank"] == 1
    assert isinstance(entry["elapsed_ms"], int)


@pytest.mark.req("REQ-RAG-6.3.1")
def test_logs_exclude_query_and_span(settings: Settings) -> None:
    """[REQ-RAG-6.3.1] 질의 원문, 정답 구간, 문서 이름은 로그에 남지 않는다."""
    fake = FakeSearcher(
        [hit(1, "비밀정답구간ABCDEFGHIJ", name="비밀문서이름")],
        doc=searchable_doc(name="비밀문서이름"),
    )
    with capture_logs() as logs:
        run(
            make_evaluator(fake, settings).evaluate(
                case(query="비밀질의문구", answer_span="비밀정답구간ABCDEFGHIJ")
            )
        )
    assert_logs_exclude(logs, ["비밀질의문구", "비밀정답구간", "비밀문서이름"])
