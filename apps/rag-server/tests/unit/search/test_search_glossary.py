"""용어 등록(REQ-RAG-4.8) 테스트."""

from pathlib import Path

import pytest
from structlog.testing import capture_logs

from minerva_rag.core import GlossaryError, Settings
from minerva_rag.search import SearchQuery
from minerva_rag.search import glossary as glossary_module

from ..resource.fakes import assert_log, run
from .fakes import (
    EXAMPLE_GLOSSARY,
    FakeSearchHub,
    make_searcher,
    rec,
    scripted_store,
    write_glossary,
)

Expansion = glossary_module.Expansion
Glossary = glossary_module.Glossary


def _loaded(settings: Settings, path: Path, text: str) -> Glossary:
    """파일에 내용을 쓰고 읽은 용어집을 돌려준다."""
    write_glossary(path, text)
    glossary = Glossary(settings)
    glossary.load()
    return glossary


def _terms(glossary: Glossary, query: str) -> set[str]:
    """질의를 확장한 말의 집합이다."""
    return set(glossary.expand(query).terms)


@pytest.mark.req("REQ-RAG-4.8.1")
def test_example_file_groups(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] 예시 파일을 읽으면 대표어와 동의어가 한 묶음으로 확장된다."""
    glossary = _loaded(settings, glossary_path, EXAMPLE_GLOSSARY)

    assert _terms(glossary, "인증서") == {"certificate", "cert", "인증 문서"}
    assert {t.lower() for t in _terms(glossary, "CRL")} >= {
        "폐기 목록",
        "certificate revocation list",
    }


@pytest.mark.parametrize(
    "content",
    [
        "{}",
        "terms:\n  - synonyms: [a]\n",
        "terms:\n  - canonical: 가\n",
        "terms:\n  - canonical: ''\n    synonyms: []\n",
        "terms: 3\n",
        "terms: [\n",
        "- a\n",
        # terms가 null이거나 값이 없는 파일
        "terms:\n",
        "terms: null\n",
        # 앞뒤 공백을 떼면 비는 대표어·동의어
        "terms:\n  - canonical: '   '\n    synonyms: []\n",
        "terms:\n  - canonical: 가\n    synonyms: ['  ']\n",
        # 문자열이 아닌 동의어 항목
        "terms:\n  - canonical: 가\n    synonyms: [1609]\n",
        "terms:\n  - canonical: 가\n    synonyms: [null]\n",
        # 목록이 아닌 synonyms
        "terms:\n  - canonical: 가\n    synonyms: abc\n",
        "terms:\n  - canonical: 가\n    synonyms: 3\n",
        "terms:\n  - canonical: 가\n    synonyms: null\n",
    ],
)
@pytest.mark.req("REQ-RAG-4.8.1")
def test_missing_required_fields(settings: Settings, glossary_path: Path, content: str) -> None:
    """[REQ-RAG-4.8.1] 필수 필드가 없거나 형식이 맞지 않는 파일은 GlossaryError다."""
    write_glossary(glossary_path, content)

    with pytest.raises(GlossaryError):
        Glossary(settings).load()


@pytest.mark.req("REQ-RAG-4.8.1")
def test_empty_synonym_rejected(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] 빈 동의어("")가 든 파일은 GlossaryError다."""
    write_glossary(glossary_path, "terms:\n  - canonical: 가\n    synonyms: ['']\n")

    with pytest.raises(GlossaryError):
        Glossary(settings).load()


@pytest.mark.req("REQ-RAG-4.8.1")
def test_non_string_term_rejected(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] 문자열이 아닌 말(YAML 숫자)이 든 파일은 GlossaryError다."""
    write_glossary(glossary_path, "terms:\n  - canonical: 1609\n    synonyms: []\n")

    with pytest.raises(GlossaryError):
        Glossary(settings).load()


@pytest.mark.req("REQ-RAG-4.8.1")
def test_surrounding_spaces_trimmed(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] 대표어와 동의어의 앞뒤 공백은 떼고 읽는다."""
    glossary = _loaded(
        settings,
        glossary_path,
        "terms:\n  - canonical: '  인증서  '\n    synonyms: [' cert ', '  인증 문서']\n",
    )

    assert _terms(glossary, "인증서") == {"cert", "인증 문서"}
    assert _terms(glossary, "cert") == {"인증서", "인증 문서"}


@pytest.mark.req("REQ-RAG-4.8.1")
def test_unknown_keys_ignored(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] 정해지지 않은 키는 무시하고 나머지는 그대로 읽는다."""
    glossary = _loaded(
        settings,
        glossary_path,
        "version: 3\nnote: 메모\nterms:\n  - canonical: 인증서\n    synonyms: [cert]\n"
        "    comment: 무시\n  - canonical: 가\n    synonyms: []\n    extra: [1, 2]\n",
    )

    assert _terms(glossary, "인증서") == {"cert"}


@pytest.mark.req("REQ-RAG-4.8.1")
def test_empty_terms_ok(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] terms가 비어 있어도 되고 그러면 어떤 질의도 빈 확장이다."""
    glossary = _loaded(settings, glossary_path, "terms: []\n")

    assert glossary.expand("무엇이든") == Expansion((), ())


@pytest.mark.req("REQ-RAG-4.8.1")
def test_missing_file_is_empty(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] 파일이 없으면 빈 용어집이다."""
    glossary_path.unlink()
    glossary = Glossary(settings)

    glossary.load()

    assert glossary.expand("인증서") == Expansion((), ())


@pytest.mark.req("REQ-RAG-4.8.1")
def test_searcher_load_glossary_raises(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.1] Searcher.load_glossary는 형식 오류를 GlossaryError 그대로 낸다."""
    write_glossary(glossary_path, "terms: [\n")
    searcher = make_searcher(scripted_store([]), FakeSearchHub(), settings, load=False)

    with pytest.raises(GlossaryError):
        searcher.load_glossary()


@pytest.mark.req("REQ-RAG-4.8.2")
def test_duplicate_across_groups(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.2] 같은 동의어가 두 묶음에 있으면 GlossaryError이고 메시지에 그 말이 있다."""
    write_glossary(
        glossary_path,
        "terms:\n  - canonical: 가\n    synonyms: [cert]\n"
        "  - canonical: 나\n    synonyms: [cert]\n",
    )

    with pytest.raises(GlossaryError) as raised:
        Glossary(settings).load()

    assert "cert" in str(raised.value)


@pytest.mark.req("REQ-RAG-4.8.2")
def test_duplicate_case_insensitive(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.2] 대소문자만 다른 영문 동의어도 같은 말로 보고 거부한다."""
    write_glossary(
        glossary_path,
        "terms:\n  - canonical: 가\n    synonyms: [cert]\n"
        "  - canonical: 나\n    synonyms: [CERT]\n",
    )

    with pytest.raises(GlossaryError) as raised:
        Glossary(settings).load()

    assert "cert" in str(raised.value).lower()


@pytest.mark.req("REQ-RAG-4.8.2")
def test_duplicate_canonical_vs_synonym(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.2] 한 묶음의 대표어가 다른 묶음의 동의어로 나와도 거부한다."""
    write_glossary(
        glossary_path,
        "terms:\n  - canonical: 가\n    synonyms: [a]\n  - canonical: 나\n    synonyms: [가]\n",
    )

    with pytest.raises(GlossaryError):
        Glossary(settings).load()


_BEFORE = "terms:\n  - canonical: 인증서\n    synonyms: [cert]\n"
_AFTER = "terms:\n  - canonical: 인증서\n    synonyms: [증명서]\n"
_BROKEN = "terms:\n  - canonical: 가\n    synonyms: [x]\n  - canonical: 나\n    synonyms: [x]\n"


@pytest.mark.req("REQ-RAG-4.8.3")
def test_reload_on_change(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.3] 파일을 고치면 load 없이도 다음 expand가 새 묶음으로 확장한다."""
    glossary = _loaded(settings, glossary_path, _BEFORE)
    assert _terms(glossary, "인증서") == {"cert"}

    write_glossary(glossary_path, _AFTER)

    assert _terms(glossary, "인증서") == {"증명서"}


@pytest.mark.req("REQ-RAG-4.8.3")
def test_bad_change_keeps_previous(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.3] 잘못 고친 파일이면 직전 묶음으로 확장하고 경고 로그를 남긴다."""
    glossary = _loaded(settings, glossary_path, _BEFORE)
    write_glossary(glossary_path, _BROKEN)

    with capture_logs() as logs:
        terms = _terms(glossary, "인증서")

    assert terms == {"cert"}
    assert_log(logs, "search.glossary_reload_failed", "warning", {"reason"})


@pytest.mark.req("REQ-RAG-4.8.3")
def test_recovers_after_fix(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.3] 잘못 고친 뒤 다시 올바르게 고치면 다음 expand가 새 묶음으로 확장한다."""
    glossary = _loaded(settings, glossary_path, _BEFORE)
    write_glossary(glossary_path, _BROKEN)
    assert _terms(glossary, "인증서") == {"cert"}

    write_glossary(glossary_path, _AFTER)

    assert _terms(glossary, "인증서") == {"증명서"}


@pytest.mark.req("REQ-RAG-4.8.3", "REQ-RAG-4.9.1")
def test_search_uses_reloaded_glossary(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.8.3] 용어집 파일에 묶음을 더하면 다음 검색부터 확장에 반영된다."""
    hub = FakeSearchHub()
    searcher = make_searcher(scripted_store([rec("a")]), hub, settings)
    run(searcher.search(SearchQuery("vpn 설정")))
    assert "가상 사설망" not in hub.embed_inputs[-1]

    write_glossary(glossary_path, "terms:\n  - canonical: 가상 사설망\n    synonyms: [VPN]\n")
    run(searcher.search(SearchQuery("vpn 설정")))

    assert "가상 사설망" in hub.embed_inputs[-1]
