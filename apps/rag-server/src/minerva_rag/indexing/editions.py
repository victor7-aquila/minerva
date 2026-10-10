"""REQ-RAG-3.6.3 최신판 계산과 이름별 직렬화."""

import asyncio
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager

from minerva_rag.core import Edition


def latest_doc_ids(editions: Mapping[str, Edition | None]) -> frozenset[str]:
    """판 정보가 있는 문서 중 판 날짜가 가장 늦은 문서들을 돌려준다. 없으면 빈 집합이다."""
    dated = {doc_id: e.edition_date for doc_id, e in editions.items() if e is not None}
    if not dated:
        return frozenset()
    newest = max(dated.values())
    return frozenset(doc_id for doc_id, d in dated.items() if d == newest)


class NameLocks:
    """이름마다 하나의 asyncio.Lock을 빌려준다. 쓰는 곳이 없으면 지운다."""

    def __init__(self) -> None:
        """빈 잠금 표를 만든다."""
        self._locks: dict[str, asyncio.Lock] = {}
        self._users: dict[str, int] = {}

    @asynccontextmanager
    async def hold(self, name: str) -> AsyncIterator[None]:
        """그 이름의 잠금을 잡는다."""
        # ★ 잠금을 얻기 전에 사용 수를 올려야 대기 중에 잠금이 지워지지 않는다
        lock = self._locks.setdefault(name, asyncio.Lock())
        self._users[name] = self._users.get(name, 0) + 1
        try:
            async with lock:
                yield
        finally:
            self._users[name] -= 1
            if self._users[name] == 0:
                del self._users[name]
                del self._locks[name]
