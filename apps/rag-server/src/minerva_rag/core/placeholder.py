"""색인용 MD의 자리표시를 읽는다 (루트 INTERFACES.md IF-1)."""

import re
from dataclasses import dataclass

# ★ IF-1: [[minerva:{kind}:{placeholder_id} | {description}]]
#   description은 비어 있지 않고, 줄바꿈과 "]]"를 담지 않으며, 끝 글자가 "]"가 아니다.
#   자리표시는 "[[minerva:" 뒤에 처음 나오는 "]]"에서 끝난다.
_PLACEHOLDER_RE = re.compile(
    r"\[\[minerva:(?P<kind>table|image):(?P<pid>[a-z0-9]+) \| "
    r"(?P<desc>(?:[^\]\n]|\](?!\]))*[^\]\n])\]\]"
)


@dataclass(frozen=True)
class Placeholder:
    """색인용 MD 안의 자리표시 하나다."""

    kind: str  # "table" 또는 "image"
    placeholder_id: str
    raw: str  # 원문에 나온 자리표시 문자열 전체
    start: int  # raw가 시작하는 글자 위치
    end: int  # raw가 끝난 다음 글자 위치


def find_placeholders(text: str) -> tuple[Placeholder, ...]:
    """text 안의 자리표시를 나오는 차례대로 돌려준다."""
    return tuple(
        Placeholder(
            kind=m["kind"],
            placeholder_id=m["pid"],
            raw=m.group(0),
            start=m.start(),
            end=m.end(),
        )
        for m in _PLACEHOLDER_RE.finditer(text)
    )
