"""질의 확장(REQ-RAG-4.9) 테스트."""

import ast
import inspect
from pathlib import Path

import pytest

from minerva_rag.core import Settings
from minerva_rag.search import SearchQuery
from minerva_rag.search import glossary as glossary_module

from ..resource.fakes import run
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
_FORBIDDEN_MODULES = ("minerva_rag.resource", "minerva_rag.indexing")


@pytest.fixture
def example(settings: Settings, glossary_path: Path) -> Glossary:
    """예시 용어집을 읽은 헬퍼다."""
    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    glossary = Glossary(settings)
    glossary.load()
    return glossary


def _lower(values: tuple[str, ...]) -> set[str]:
    """영문 대소문자 차이를 없앤 집합이다."""
    return {v.lower() for v in values}


@pytest.mark.req("REQ-RAG-4.9.1")
def test_synonym_expands_group(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 동의어가 든 질의가 묶음 전체로 확장되고 질의에 있는 말은 뺀다."""
    result = example.expand("cert 갱신")

    assert "cert" in _lower(result.matched)
    assert _lower(result.terms) == {"인증서", "certificate", "인증 문서"}


@pytest.mark.req("REQ-RAG-4.9.1")
def test_canonical_expands_synonyms(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 대표어가 든 질의가 그 묶음의 동의어 전부로 확장된다."""
    result = example.expand("폐기 목록 조회")

    assert _lower(result.terms) == {"crl", "certificate revocation list"}


@pytest.mark.req("REQ-RAG-4.9.1")
def test_case_insensitive(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 영문은 대소문자를 가리지 않는다."""
    base = _lower(example.expand("cert").terms)

    assert base
    assert _lower(example.expand("CERT").terms) == base
    assert _lower(example.expand("Cert").terms) == base


@pytest.mark.req("REQ-RAG-4.9.1")
def test_no_term_empty_expansion(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 용어집의 말이 없는 질의는 빈 확장이다."""
    assert example.expand("날씨 어때") == Expansion((), ())


@pytest.mark.req("REQ-RAG-4.9.1")
def test_korean_particle_matches(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 한글 말은 조사가 붙어도 찾는다."""
    assert "certificate" in _lower(example.expand("인증서를 갱신").terms)


@pytest.mark.req("REQ-RAG-4.9.1")
def test_ascii_boundary(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 영문 말은 바로 앞에 영문이 붙으면(concert) 찾지 않고 조사는 붙어도 찾는다."""
    assert example.expand("concert 일정") == Expansion((), ())
    assert example.expand("cert를") != Expansion((), ())


@pytest.mark.parametrize("query", ["certs 갱신", "cert2 갱신", "cert9", "CERTS"])
@pytest.mark.req("REQ-RAG-4.9.1")
def test_ascii_boundary_after(example: Glossary, query: str) -> None:
    """[REQ-RAG-4.9.1] 영문·숫자로 끝나는 말은 바로 뒤에 영문·숫자가 오면 찾지 않는다."""
    assert example.expand(query) == Expansion((), ())


@pytest.mark.parametrize("query", ["cert-2", "cert.", "(cert)", "cert 2", "cert"])
@pytest.mark.req("REQ-RAG-4.9.1")
def test_ascii_boundary_after_non_alnum(example: Glossary, query: str) -> None:
    """[REQ-RAG-4.9.1] 영문 말 뒤가 영문·숫자가 아니면(기호·공백·끝) 찾는다."""
    assert "인증서" in example.expand(query).terms


@pytest.mark.req("REQ-RAG-4.9.1")
def test_nfkc_normalized_query(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 전각 문자로 쓴 질의도 NFKC 정규화 뒤 같은 말로 찾는다."""
    result = example.expand("ＣＥＲＴ 갱신")

    assert "인증서" in result.terms
    # ★ 질의에 이미 있는 말(정규화 뒤 cert)은 terms에서 뺀다
    assert "cert" not in _lower(result.terms)


@pytest.mark.req("REQ-RAG-4.9.1")
def test_nfkc_normalized_glossary(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.9.1] 용어집에 전각으로 쓴 말도 NFKC 정규화 뒤 질의의 말과 같게 본다."""
    write_glossary(glossary_path, "terms:\n  - canonical: 가상 사설망\n    synonyms: [ＶＰＮ]\n")
    glossary = Glossary(settings)
    glossary.load()

    assert "가상 사설망" in glossary.expand("vpn 설정").terms


@pytest.mark.req("REQ-RAG-4.9.1")
def test_whitespace_collapsed_in_query(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 질의의 연속 공백은 하나로 줄여 비교한다."""
    result = example.expand("인증   문서 갱신")

    assert {"인증서", "certificate", "cert"} <= _lower(result.terms)
    # ★ 질의에 이미 있는 말(공백을 줄인 뒤 '인증 문서')은 terms에서 뺀다
    assert "인증 문서" not in result.terms


@pytest.mark.req("REQ-RAG-4.9.1")
def test_whitespace_collapsed_in_glossary(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.9.1] 용어집에 공백을 여러 개 쓴 말도 하나로 줄여 질의의 말과 비교한다."""
    write_glossary(glossary_path, "terms:\n  - canonical: 인증서\n    synonyms: ['인증   문서']\n")
    glossary = Glossary(settings)
    glossary.load()

    assert "인증서" in glossary.expand("인증 문서 갱신").terms


@pytest.mark.req("REQ-RAG-4.9.1")
def test_already_in_query_uses_boundary(example: Glossary) -> None:
    """[REQ-RAG-4.9.1] 질의에 이미 있는 말도 경계 규칙으로 판정한다(certificate 속 cert 제외)."""
    result = example.expand("certificate 갱신")

    assert "cert" in _lower(result.terms)
    assert "certificate" not in _lower(result.terms)
    assert "인증서" in result.terms


@pytest.mark.req("REQ-RAG-4.9.2")
def test_glossary_change_no_store_writes(settings: Settings, glossary_path: Path) -> None:
    """[REQ-RAG-4.9.2] 용어집을 고쳐도 저장소에 쓰기가 없고 다음 검색의 확장 결과만 달라진다."""
    store = scripted_store([rec("a")])
    hub = FakeSearchHub()
    searcher = make_searcher(store, hub, settings)
    run(searcher.search(SearchQuery("cert 갱신")))
    before = list(hub.embed_inputs)

    write_glossary(glossary_path, EXAMPLE_GLOSSARY)
    run(searcher.search(SearchQuery("cert 갱신")))
    after = hub.embed_inputs[len(before) :]

    assert store.writes() == []
    assert before
    assert set(after) != set(before)
    assert before[0] == "cert 갱신"


def _import_targets(tree: ast.AST) -> list[tuple[int, str]]:
    """소스 트리의 import 대상을 (상대 import 단계, 모듈 이름)으로 모은다."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((0, alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            found.append((node.level, base))
            # `from .. import resource`처럼 가져오는 이름이 하위 모듈인 경우도 본다
            found.extend((node.level, f"{base}.{alias.name}".strip(".")) for alias in node.names)
    return found


@pytest.mark.req("REQ-RAG-4.9.2")
def test_glossary_module_independent() -> None:
    """[REQ-RAG-4.9.2] 용어집 헬퍼는 resource·indexing을 (상대 import 포함) import하지 않는다."""
    source_file = inspect.getsourcefile(glossary_module)
    assert source_file is not None
    tree = ast.parse(Path(source_file).read_text(encoding="utf-8"))

    targets = _import_targets(tree)

    assert targets
    for level, module in targets:
        if level == 0:
            for forbidden in _FORBIDDEN_MODULES:
                assert module != forbidden
                assert not module.startswith(forbidden + ".")
        else:
            assert module.split(".")[0] not in {"resource", "indexing"}
