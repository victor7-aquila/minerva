"""키워드 벡터 토큰화(REQ-RAG-4.1.1, REQ-RAG-3.2.2) 단위 테스트.

인덱스 값(해시 알고리즘)과 순서는 단언하지 않는다. 집합 관계와 값만 본다.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from minerva_rag.core import Settings, SparseVector
from minerva_rag.resource import ModelHub

from .fakes import run

TEXT = "Docker 설치 후 token_refresh API를 호출한다 v2"


def _hub(settings: Settings) -> ModelHub:
    """prepare 없이 쓰는 ModelHub를 만든다 (키워드 인코딩은 모델이 필요 없다)."""
    return ModelHub(settings)


def _query(settings: Settings, text: str) -> SparseVector:
    return run(_hub(settings).encode_sparse_query(text))


def _document(settings: Settings, text: str) -> SparseVector:
    return run(_hub(settings).encode_sparse_documents([text]))[0]


def _pairs(vector: SparseVector) -> dict[int, float]:
    """(인덱스 → 값) 사전으로 바꿔 순서에 기대지 않고 비교한다."""
    return dict(zip(vector.indices, vector.values, strict=True))


@pytest.mark.req("REQ-RAG-4.1.1")
def test_korean_particles_share_bigrams(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] '인증서를'과 '인증서는'이 '인증'·'증서' 조각을 함께 갖는다."""
    pieces = set(_query(settings, "인증").indices) | set(_query(settings, "증서").indices)
    assert len(pieces) == 2
    for word in ("인증서를", "인증서는"):
        assert pieces <= set(_query(settings, word).indices)


@pytest.mark.req("REQ-RAG-4.1.1")
def test_two_syllable_word_not_doubled(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 조각이 단어 자체와 같으면 더하지 않아 값이 1인 원소 하나만 남는다."""
    vector = _document(settings, "인증")

    assert len(vector.indices) == 1
    assert vector.values == (1.0,)


@pytest.mark.req("REQ-RAG-4.1.1")
def test_english_case_insensitive(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 'Certificate'와 'certificate'는 같은 토큰이다."""
    assert _pairs(_query(settings, "Certificate")) == _pairs(_query(settings, "certificate"))


@pytest.mark.req("REQ-RAG-4.1.1")
def test_nfkc_normalization(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 전각 문자는 NFKC로 정규화되어 같은 토큰이 된다."""
    assert _pairs(_query(settings, "ＡＰＩ")) == _pairs(_query(settings, "api"))


@pytest.mark.req("REQ-RAG-4.1.1")
def test_split_on_punctuation_symbols_underscore(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 공백·구두점·기호·밑줄은 모두 단어를 가른다."""
    variants = ["token,refresh", "token refresh", "token_refresh", "token+refresh"]
    sets = [set(_query(settings, text).indices) for text in variants]

    assert len(sets[0]) == 2
    assert all(s == sets[0] for s in sets)


@pytest.mark.req("REQ-RAG-4.1.1")
@pytest.mark.req("REQ-RAG-3.2.2")
def test_document_and_query_share_indices(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 같은 텍스트를 문서·질의로 인코딩하면 같은 인덱스 집합이 나온다."""
    assert set(_document(settings, TEXT).indices) == set(_query(settings, TEXT).indices)


@pytest.mark.req("REQ-RAG-4.1.1")
def test_document_values_are_term_frequency(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 문서 벡터의 값은 토큰 빈도다."""
    document = _pairs(_document(settings, "api api key"))
    api_index = _query(settings, "api").indices[0]
    key_index = _query(settings, "key").indices[0]

    assert document[api_index] == 2.0
    assert document[key_index] == 1.0


@pytest.mark.req("REQ-RAG-4.1.1")
def test_query_values_are_one(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 질의 벡터의 값은 모두 1이다."""
    vector = _query(settings, "api api key")

    assert len(vector.indices) == 2
    assert set(vector.values) == {1.0}


@pytest.mark.req("REQ-RAG-4.1.1")
@pytest.mark.parametrize("text", ["", "  ,.!"])
def test_empty_text_gives_empty_vector(settings: Settings, text: str) -> None:
    """[REQ-RAG-4.1.1] 단어가 없는 텍스트는 원소가 없는 벡터가 된다."""
    assert _query(settings, text).indices == ()
    assert _document(settings, text).indices == ()


@pytest.mark.req("REQ-RAG-4.1.1")
def test_encode_sparse_documents_keeps_order(settings: Settings) -> None:
    """[REQ-RAG-4.1.1] 여러 건 인코딩은 입력 순서를 지키고 단건 결과와 같다."""
    texts = ["첫째 문서", "api key", "인증서를 갱신한다"]

    batch = run(_hub(settings).encode_sparse_documents(texts))

    assert len(batch) == 3
    for vector, text in zip(batch, texts, strict=True):
        assert _pairs(vector) == _pairs(_document(settings, text))


@pytest.mark.req("REQ-RAG-4.1.1")
def test_indices_stable_across_processes(settings: Settings, tmp_path: Path) -> None:
    """[REQ-RAG-4.1.1] 해시 시드가 다른 두 프로세스에서도 같은 토큰은 같은 값이다."""
    code = (
        "import asyncio, json, sys\n"
        "from minerva_rag.core import get_settings\n"
        "from minerva_rag.resource import ModelHub\n"
        "hub = ModelHub(get_settings())\n"
        "v = asyncio.run(hub.encode_sparse_query(sys.argv[1]))\n"
        "print(json.dumps(sorted(zip(v.indices, v.values))))\n"
    )
    outputs: list[str] = []
    for seed in ("1", "2"):
        env = dict(os.environ)
        env["PYTHONHASHSEED"] = seed
        result = subprocess.run(
            [sys.executable, "-c", code, TEXT],
            env=env,
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
        )
        outputs.append(result.stdout.strip())

    assert outputs[0] == outputs[1]
    loaded = [(int(i), float(v)) for i, v in json.loads(outputs[0])]
    assert loaded == sorted(_pairs(_query(settings, TEXT)).items())
