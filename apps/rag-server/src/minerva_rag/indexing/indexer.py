"""REQ-RAG-3.2·3.3·3.4·3.6 색인 쓰기, 버전 교체, 삭제, 이름·판 변경, 기동 복구."""

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from minerva_rag.core import (
    ChunkingResult,
    ChunkRecord,
    Edition,
    Settings,
    SparseVector,
    get_logger,
)
from minerva_rag.resource import ChunkStore, ModelHub

from .decision import compute_checksum
from .editions import NameLocks, latest_doc_ids
from .index_text import build_index_text

log = get_logger(__name__)


@dataclass(frozen=True)
class IndexInput:
    """색인 한 번의 입력이다."""

    doc_id: str
    version: str
    job_id: str
    markdown: str
    assets: Mapping[str, str]
    name: str
    edition: Edition | None
    chunking_mode: str


@dataclass(frozen=True)
class EmbeddedChunks:
    """벡터를 붙인 새 버전 레코드다. 저장 전이라 모두 active가 아니다."""

    doc_id: str
    version: str
    name: str
    records: tuple[ChunkRecord, ...]
    dense: tuple[tuple[float, ...], ...]
    sparse: tuple[SparseVector, ...]


class Indexer:
    """청크를 색인하고 버전·판·삭제를 관리한다."""

    def __init__(self, model_hub: ModelHub, chunk_store: ChunkStore, settings: Settings) -> None:
        """모델 허브·저장소·설정을 받는다. I/O는 하지 않는다."""
        self._hub = model_hub
        self._store = chunk_store
        self._settings = settings
        self._locks = NameLocks()  # ★ 인스턴스 하나가 직렬화 범위다

    def checksum(self, markdown: str, assets: Mapping[str, str], chunking_mode: str) -> str:
        """색인 입력과 색인 설정으로 체크섬을 만든다."""
        return compute_checksum(
            markdown,
            assets,
            chunking_mode,
            chunk_max_tokens=self._settings.chunk_max_tokens,
            embedding_model=self._hub.embedding_model_name,
        )

    async def embed(self, inp: IndexInput, result: ChunkingResult) -> EmbeddedChunks:
        """청크마다 색인 텍스트로 dense·키워드 벡터를 만들어 새 레코드를 만든다."""
        chunks = result.chunks
        texts = [build_index_text(c, inp.assets) for c in chunks]  # 빠진 ID는 모델 호출 전에 실패
        if not chunks:
            return EmbeddedChunks(inp.doc_id, inp.version, inp.name, (), (), ())
        dense_rows = await self._hub.embed_documents(texts)
        sparse_rows = await self._hub.encode_sparse_documents(texts)
        if len(dense_rows) != len(chunks) or len(sparse_rows) != len(chunks):
            raise RuntimeError("벡터 개수가 청크 수와 다릅니다")
        records = tuple(
            ChunkRecord(
                chunk_id=uuid.uuid4().hex,
                doc_id=inp.doc_id,
                version=inp.version,
                job_id=inp.job_id,
                active=False,
                name=inp.name,
                edition=inp.edition,
                is_latest_edition=False,
                chunk=c,  # ★ 원문(자리표시 포함)을 그대로 둔다
            )
            for c in chunks
        )
        return EmbeddedChunks(
            doc_id=inp.doc_id,
            version=inp.version,
            name=inp.name,
            records=records,
            dense=tuple(tuple(float(x) for x in row) for row in dense_rows),
            sparse=tuple(sparse_rows),
        )

    async def write(self, embedded: EmbeddedChunks) -> int:
        """새 버전을 저장·활성화하고 이전 레코드를 지운 뒤 최신판 표시를 맞춘다."""
        doc_id = embedded.doc_id
        if any(r.doc_id != doc_id for r in embedded.records):
            raise ValueError("records의 doc_id가 embedded.doc_id와 다릅니다")
        new_ids = frozenset(r.chunk_id for r in embedded.records)
        previous = await self._store.active_records(doc_id)  # 쓰기 전에 읽는다
        names = {r.name for r in previous} | {embedded.name}
        removed = sum(1 for r in previous if r.chunk_id not in new_ids)
        try:
            await self._store.upsert(embedded.records, embedded.dense, embedded.sparse)
            await self._store.activate_records(doc_id, new_ids)
        except Exception:
            cleanup_ok = await self._discard(new_ids)
            log.warning(
                "indexing.write_failed",
                doc_id=doc_id,
                version=embedded.version,
                cleanup_ok=cleanup_ok,
            )
            raise  # ★ 원래 예외
        # ★ 활성화 뒤 4·5단계의 예외는 그대로 낸다(사용자 결정)
        await self._store.delete_records_except(doc_id, new_ids)
        await self._refresh_latest(names)
        log.info(
            "indexing.write",
            doc_id=doc_id,
            version=embedded.version,
            chunks=len(embedded.records),
            removed=removed,
        )
        return len(embedded.records)

    async def delete_document(self, doc_id: str) -> None:
        """문서의 모든 버전 레코드를 지우고 그 이름의 최신판 표시를 맞춘다."""
        previous = await self._store.active_records(doc_id)
        if not previous:
            log.info("indexing.delete", doc_id=doc_id, had_records=False)
            return
        names = {r.name for r in previous}
        await self._store.delete_document(doc_id)
        await self._refresh_latest(names)
        log.info("indexing.delete", doc_id=doc_id, had_records=True)

    async def update_metadata(self, doc_id: str, name: str, edition: Edition | None) -> None:
        """다시 색인하지 않고 문서의 이름·판 정보를 바꾼다."""
        previous = await self._store.active_records(doc_id)
        if not previous:
            log.info("indexing.metadata", doc_id=doc_id, name_changed=False, edition_changed=False)
            return
        old_names = {r.name for r in previous}
        old_editions = {r.edition for r in previous}
        await self._store.set_document_metadata(doc_id, name, edition)
        await self._refresh_latest(old_names | {name})
        log.info(
            "indexing.metadata",
            doc_id=doc_id,
            name_changed=old_names != {name},
            edition_changed=old_editions != {edition},
        )

    async def recover(self, doc_id: str, job_id: str) -> bool:
        """다시 시작할 때 그 작업의 결과가 검색에 쓰이는지 확인하고 남은 정리를 한다."""
        records = await self._store.job_records(doc_id, job_id)
        if not records:
            return False
        ids = frozenset(r.chunk_id for r in records)
        if not any(r.active for r in records):
            await self._store.delete_records(ids)  # 저장만 하고 활성화 전
            return False
        previous = await self._store.active_records(doc_id)
        names = {r.name for r in previous} | {r.name for r in records}
        await self._store.activate_records(doc_id, ids)  # 일부만 active였어도 모두
        await self._store.delete_records_except(doc_id, ids)
        await self._refresh_latest(names)
        return True

    async def _discard(self, chunk_ids: frozenset[str]) -> bool:
        """새 레코드 지우기를 시도하고 예외 없이 끝났는지 돌려준다."""
        if not chunk_ids:
            return True
        try:
            await self._store.delete_records(chunk_ids)
        except Exception:
            return False
        return True

    async def _refresh_latest(self, names: Iterable[str]) -> None:
        """관련 이름마다 최신판 표시를 다시 맞춘다. 한 이름은 한 번에 하나씩 한다."""
        for name in sorted(set(names)):
            async with self._locks.hold(name):
                editions = await self._store.active_editions(name)
                await self._store.set_latest_editions(name, latest_doc_ids(editions))
