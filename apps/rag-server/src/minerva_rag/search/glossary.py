"""용어집 파일을 읽고 검증하며 질의를 확장한다 (REQ-RAG-4.8, REQ-RAG-4.9)."""

import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import yaml

from minerva_rag.core import GlossaryError, Settings, get_logger

log = get_logger(__name__)

# 파일의 (st_mtime_ns, st_size). 파일이 없으면 None, stat 자체가 실패하면 _STAT_ERROR
_Sig = tuple[int, int] | None
_STAT_ERROR: _Sig = (-1, -1)
_NEVER = object()  # 아직 한 번도 읽지 않았다는 감시값


class _InvalidGlossaryError(GlossaryError):
    """형식 오류다. 로그용 사유 코드를 함께 갖는다."""

    def __init__(self, message: str, reason: str) -> None:
        """메시지와 영문 사유 코드를 받는다."""
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class Expansion:
    """질의에서 찾은 말과 넣을 말이다."""

    matched: tuple[str, ...]
    terms: tuple[str, ...]


@dataclass(frozen=True)
class _Snapshot:
    """검증을 마친 용어집이다."""

    groups: tuple[tuple[str, ...], ...]  # 묶음마다 대표어가 먼저, 그다음 동의어 (원형)
    index: tuple[tuple[str, int, str], ...]  # (정규화한 말, 묶음 번호, 원형) — 파일 순서


_EMPTY = _Snapshot(groups=(), index=())


def _normalize(text: str) -> str:
    """NFKC 정규화·소문자화를 하고 연속 공백을 하나로 줄인다."""
    return " ".join(unicodedata.normalize("NFKC", text).lower().split())


def _is_ascii_alnum(ch: str) -> bool:
    """영문·숫자(ASCII) 글자인지 본다."""
    return ch.isascii() and ch.isalnum()


def _bounded(word: str, query: str, start: int) -> bool:
    """query의 start 위치에 나온 word의 앞뒤 글자가 경계 규칙을 지키는지 본다."""
    end = start + len(word)
    if _is_ascii_alnum(word[0]) and start > 0 and _is_ascii_alnum(query[start - 1]):
        return False
    return not (_is_ascii_alnum(word[-1]) and end < len(query) and _is_ascii_alnum(query[end]))


def _occurs(word: str, query: str) -> bool:
    """정규화한 말이 정규화한 질의에 경계 규칙을 지키며 나오는지 본다."""
    if not word:
        return False
    start = query.find(word)
    while start != -1:
        if _bounded(word, query, start):
            return True
        start = query.find(word, start + 1)
    return False


def _invalid(where: str) -> _InvalidGlossaryError:
    """위치를 담은 형식 오류를 만든다."""
    return _InvalidGlossaryError(f"용어집 형식이 올바르지 않습니다: {where}", "invalid_format")


def _word(value: object, where: str) -> str:
    """말 하나를 검증하고 앞뒤 공백을 뗀 문자열로 돌려준다."""
    if not isinstance(value, str) or not value.strip():
        raise _invalid(where)
    return value.strip()


def _parse_group(position: int, item: object) -> tuple[str, ...]:
    """terms의 항목 하나를 검증해 (대표어, 동의어...)로 돌려준다."""
    where = f"terms[{position}]"
    if not isinstance(item, dict):
        raise _invalid(where)
    fields: dict[object, object] = dict(item)
    canonical = _word(fields.get("canonical"), f"{where}.canonical")
    synonyms = fields.get("synonyms")
    if not isinstance(synonyms, list):
        raise _invalid(f"{where}.synonyms")
    items: list[object] = list(synonyms)
    words = [_word(s, f"{where}.synonyms[{i}]") for i, s in enumerate(items)]
    return (canonical, *words)


def _build_snapshot(groups: list[tuple[str, ...]]) -> _Snapshot:
    """묶음 목록에서 같은 말이 두 번 나오는지 보고 검색용 색인을 만든다."""
    seen: set[str] = set()
    index: list[tuple[str, int, str]] = []
    for number, words in enumerate(groups):
        for word in words:
            normalized = _normalize(word)
            if normalized in seen:
                # ★ 메시지에 그 말을 담는다 (REQ-RAG-4.8.2). 로그에는 옮기지 않는다
                raise _InvalidGlossaryError(
                    f"용어집에 같은 말이 두 번 나옵니다: {word}", "duplicate_term"
                )
            seen.add(normalized)
            index.append((normalized, number, word))
    return _Snapshot(groups=tuple(groups), index=tuple(index))


def _read_snapshot(path: Path) -> _Snapshot:
    """파일을 읽어 검증한 용어집을 돌려준다. 없으면 빈 용어집이다."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return _EMPTY
    except OSError:
        # ★ OSError 메시지에는 경로가 들어 있으므로 원인을 잇지 않는다
        raise _InvalidGlossaryError("용어집 파일을 읽지 못했습니다", "unreadable") from None
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise _InvalidGlossaryError("용어집 파일이 UTF-8이 아닙니다", "unreadable") from None
    try:
        # ★ safe_load만 쓴다 — 임의 객체를 만들지 않는다
        data: object = yaml.safe_load(text)
    except (yaml.YAMLError, ValueError, TypeError, OverflowError, RecursionError):
        # ★ 잘못된 날짜 같은 생성자 오류(ValueError)와 깊은 중첩(RecursionError)도 형식 오류다.
        #   파일 내용이 담긴 원인은 잇지 않는다
        raise _InvalidGlossaryError("용어집 파일이 YAML 형식이 아닙니다", "invalid_yaml") from None
    if not isinstance(data, dict):
        raise _invalid("최상위")
    top: dict[object, object] = dict(data)
    terms = top.get("terms")
    if not isinstance(terms, list):
        raise _invalid("terms")
    entries: list[object] = list(terms)
    return _build_snapshot([_parse_group(i, item) for i, item in enumerate(entries)])


def _expand(snapshot: _Snapshot, query: str) -> Expansion:
    """질의에 든 말을 찾아 그 묶음의 말 전부로 확장한다. 질의에 이미 있는 말은 뺀다."""
    normalized_query = _normalize(query)
    matched: list[str] = []
    numbers: dict[int, None] = {}  # 순서를 지키는 집합
    for normalized, number, original in snapshot.index:
        if _occurs(normalized, normalized_query):
            matched.append(original)
            numbers[number] = None
    terms: dict[str, None] = {}
    for number in sorted(numbers):
        for word in snapshot.groups[number]:
            if not _occurs(_normalize(word), normalized_query):
                terms[word] = None
    return Expansion(matched=tuple(matched), terms=tuple(terms))


class Glossary:
    """용어집을 읽고 질의를 확장한다."""

    def __init__(self, settings: Settings) -> None:
        """용어집 경로를 받는다. I/O는 하지 않는다."""
        self._path = settings.glossary_path
        self._snapshot = _EMPTY
        self._loaded_sig: object = _NEVER  # 마지막으로 성공한 서명
        self._failed_sig: object = _NEVER  # 마지막으로 실패한 서명 (같은 실패를 되풀이하지 않는다)

    def _signature(self) -> _Sig:
        """파일의 (수정 시각, 크기)를 돌려준다. 파일이 없으면 None이다."""
        try:
            info = os.stat(self._path)
        except FileNotFoundError:
            return None
        except OSError:
            return _STAT_ERROR
        return (info.st_mtime_ns, info.st_size)

    def load(self) -> None:
        """용어집 파일을 읽어 바꾼다. 형식이 틀리면 GlossaryError를 내고 직전 용어집을 유지한다."""
        sig = self._signature()  # ★ 읽기 전에 stat — 읽는 사이 바뀌면 다음 expand가 다시 읽는다
        snapshot = _read_snapshot(self._path)  # 실패하면 예외가 나고 상태는 그대로다
        self._snapshot = snapshot  # ★ 한 번의 대입으로 바꾼다
        self._loaded_sig = sig
        self._failed_sig = _NEVER
        log.info("search.glossary_loaded", groups=len(snapshot.groups), terms=len(snapshot.index))

    def _reload_if_changed(self) -> None:
        """파일이 바뀌었으면 다시 읽는다. 실패하면 직전 용어집을 계속 쓰고 경고를 남긴다."""
        sig = self._signature()
        if sig == self._loaded_sig or sig == self._failed_sig:
            return
        try:
            self.load()
        except GlossaryError as exc:
            self._failed_sig = sig
            reason = exc.reason if isinstance(exc, _InvalidGlossaryError) else "invalid_format"
            log.warning("search.glossary_reload_failed", reason=reason)

    def expand(self, query: str) -> Expansion:
        """바뀐 파일이면 다시 읽고, 질의에 든 말의 묶음 전체로 확장한다."""
        self._reload_if_changed()
        return _expand(self._snapshot, query)
