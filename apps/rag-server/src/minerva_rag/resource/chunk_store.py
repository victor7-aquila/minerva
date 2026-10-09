"""Qdrant의 청크 컬렉션을 다룬다 (REQ-RAG-12.2)."""

import uuid
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from qdrant_client import AsyncQdrantClient, models
from qdrant_client.conversions.common_types import PointId
from qdrant_client.http.exceptions import ResponseHandlingException

from minerva_rag.core import (
    Chunk,
    ChunkKind,
    ChunkRecord,
    Edition,
    Settings,
    SparseVector,
    StoreUnavailableError,
    VectorDimensionMismatchError,
    get_logger,
)

log = get_logger(__name__)

_COLLECTION_NAME = "minerva_chunks"
_DENSE = "dense"
_SPARSE = "sparse"
# ★ 포인트 ID는 chunk_id에서 결정적으로 만든다 — 같은 chunk_id는 같은 포인트다
_POINT_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "urn:minerva:rag:chunk")
_UPSERT_BATCH = 128
_SCROLL_PAGE = 256

_NOT_CONNECTED = "ChunkStore.connect 전에 호출했습니다"


@dataclass(frozen=True)
class ChunkFilter:
    """조회 범위다. 모든 조회는 active 레코드 안에서만 한다."""

    doc_ids: tuple[str, ...] | None = None
    edition_name: str | None = None
    edition_label: str | None = None
    latest_or_unversioned: bool = False

    def __post_init__(self) -> None:
        """edition_name과 edition_label이 함께 있거나 함께 없는지 검사한다."""
        if (self.edition_name is None) != (self.edition_label is None):
            raise ValueError("edition_name과 edition_label은 함께 주거나 함께 비워야 합니다")


@dataclass(frozen=True)
class ScoredRecord:
    """점수가 붙은 조회 결과다."""

    record: ChunkRecord
    score: float


# ── 비공개 팩토리 (테스트가 바꿔 끼우는 경계) ────────────────────────


def _create_qdrant_client(settings: Settings) -> AsyncQdrantClient:
    """설정한 주소의 Qdrant 클라이언트를 만든다."""
    # ★ check_compatibility는 생성자에서 동기 HTTP 요청을 해 이벤트 루프를 막는다
    return AsyncQdrantClient(url=settings.qdrant_url, check_compatibility=False)


# ── 변환 헬퍼 ───────────────────────────────────────────────────────


def _point_id(chunk_id: str) -> str:
    """chunk_id에서 결정적으로 포인트 ID(UUID 문자열)를 만든다."""
    return str(uuid.uuid5(_POINT_NAMESPACE, chunk_id))


def _edition_payload(edition: Edition | None) -> dict[str, str] | None:
    """판 정보를 페이로드 형태로 바꾼다."""
    if edition is None:
        return None
    return {"label": edition.label, "edition_date": edition.edition_date.isoformat()}


def _to_payload(record: ChunkRecord) -> dict[str, Any]:
    """레코드를 페이로드로 바꾼다. ★ 필드를 명시해 튜플·Enum의 직렬화가 흔들리지 않게 한다."""
    chunk = record.chunk
    return {
        "chunk_id": record.chunk_id,
        "doc_id": record.doc_id,
        "version": record.version,
        "job_id": record.job_id,
        "active": record.active,
        "name": record.name,
        # ★ 판이 없어도 키는 두고 값만 null로 한다 — IsNullCondition이 맞춘다
        "edition": _edition_payload(record.edition),
        "is_latest_edition": record.is_latest_edition,
        "chunk": {
            "chunk_key": chunk.chunk_key,
            "kind": chunk.kind.value,
            "order": chunk.order,
            "heading_path": list(chunk.heading_path),
            "title": chunk.title,
            "summary": chunk.summary,
            "text": chunk.text,
            "placeholder_ids": list(chunk.placeholder_ids),
            "split_group": chunk.split_group,
            "split_index": chunk.split_index,
            "split_total": chunk.split_total,
        },
    }


def _edition_from_payload(value: Mapping[str, Any] | None) -> Edition | None:
    """페이로드의 판 정보를 Edition으로 되돌린다."""
    if value is None:
        return None
    return Edition(label=value["label"], edition_date=date.fromisoformat(value["edition_date"]))


def _from_payload(payload: Mapping[str, Any]) -> ChunkRecord:
    """페이로드를 레코드로 되돌린다. 저장 전과 같아야 한다."""
    c = payload["chunk"]
    chunk = Chunk(
        chunk_key=c["chunk_key"],
        kind=ChunkKind(c["kind"]),
        order=c["order"],
        heading_path=tuple(c["heading_path"]),
        title=c["title"],
        summary=c["summary"],
        text=c["text"],
        placeholder_ids=tuple(c["placeholder_ids"]),
        split_group=c["split_group"],
        split_index=c["split_index"],
        split_total=c["split_total"],
    )
    return ChunkRecord(
        chunk_id=payload["chunk_id"],
        doc_id=payload["doc_id"],
        version=payload["version"],
        job_id=payload["job_id"],
        active=payload["active"],
        name=payload["name"],
        edition=_edition_from_payload(payload.get("edition")),
        is_latest_edition=payload["is_latest_edition"],
        chunk=chunk,
    )


def _to_qdrant_sparse(vector: SparseVector) -> models.SparseVector:
    """키워드 벡터를 Qdrant 형식으로 바꾼다."""
    return models.SparseVector(indices=list(vector.indices), values=list(vector.values))


# ── 필터 헬퍼 ───────────────────────────────────────────────────────


def _match(key: str, value: str | bool) -> models.FieldCondition:
    """키가 값과 같은 조건을 만든다."""
    return models.FieldCondition(key=key, match=models.MatchValue(value=value))


def _active() -> models.FieldCondition:
    """active가 True인 조건을 만든다."""
    return _match("active", True)


def _has_ids(chunk_ids: Collection[str]) -> models.HasIdCondition:
    """chunk_id들에 해당하는 포인트 조건을 만든다."""
    return models.HasIdCondition(
        has_id=[_point_id(chunk_id) for chunk_id in sorted(set(chunk_ids))]
    )


def _doc_in(doc_ids: Collection[str]) -> models.FieldCondition:
    """doc_id가 목록 안에 있는 조건을 만든다."""
    return models.FieldCondition(key="doc_id", match=models.MatchAny(any=sorted(set(doc_ids))))


def _search_filter(flt: ChunkFilter) -> models.Filter:
    """ChunkFilter를 active 조건이 붙은 Qdrant 필터로 바꾼다."""
    must: list[models.Condition] = [_active()]
    if flt.doc_ids is not None:
        must.append(_doc_in(flt.doc_ids))
    if flt.edition_name is not None and flt.edition_label is not None:
        must.append(_match("name", flt.edition_name))
        must.append(_match("edition.label", flt.edition_label))
    if flt.latest_or_unversioned:
        # ★ should는 중첩 필터로 감싸 다른 조건과 AND가 되게 한다
        must.append(
            models.Filter(
                should=[
                    _match("is_latest_edition", True),
                    models.IsNullCondition(is_null=models.PayloadField(key="edition")),
                ]
            )
        )
    return models.Filter(must=must)


def _stored_dimension(info: models.CollectionInfo) -> int | None:
    """컬렉션의 dense 벡터 차원을 읽는다. 읽을 수 없는 구성이면 None이다."""
    vectors = info.config.params.vectors
    if not isinstance(vectors, dict):
        return None
    params = vectors.get(_DENSE)
    return params.size if params is not None else None


class ChunkStore:
    """Qdrant의 청크 컬렉션을 다룬다."""

    def __init__(self, settings: Settings) -> None:
        """설정을 받는다. I/O는 하지 않는다."""
        self._settings = settings
        self._client: AsyncQdrantClient | None = None
        # ★ 생성 시점에 모듈 전역을 읽는다 — 테스트가 그 전에 바꿔 끼운다
        self._collection = _COLLECTION_NAME
        self._dimension: int | None = None
        self._mismatch = False

    # ── 연결 ─────────────────────────────────────────────────────

    async def connect(self, dense_dimension: int) -> None:
        """Qdrant에 연결해 컬렉션을 맞춘다. 차원이 다르면 기동은 막지 않고 이후 호출을 막는다."""
        await self.close()
        client = _create_qdrant_client(self._settings)
        try:
            if not await client.collection_exists(self._collection):
                await self._create_collection(client, dense_dimension)
                mismatch = False
            else:
                # ★ 인덱스 생성이 중간에 끊긴 컬렉션을 보완한다. 멱등이고 데이터는 건드리지 않는다
                await self._ensure_payload_indexes(client)
                info = await client.get_collection(self._collection)
                stored = _stored_dimension(info)
                mismatch = stored != dense_dimension
                if mismatch:
                    log.error(
                        "resource.dimension_mismatch",
                        stored_dimension=stored,
                        model_dimension=dense_dimension,
                    )
        except ResponseHandlingException as exc:
            await self._close_quietly(client)
            raise self._unavailable("connect", exc) from exc
        except BaseException:
            # ★ 예상 밖 실패에도 만든 클라이언트를 닫는다
            await self._close_quietly(client)
            raise
        self._client = client
        self._dimension = dense_dimension
        self._mismatch = mismatch

    async def _create_collection(self, client: AsyncQdrantClient, dense_dimension: int) -> None:
        """dense 코사인·sparse IDF 구성의 컬렉션과 페이로드 인덱스를 만든다."""
        await client.create_collection(
            collection_name=self._collection,
            vectors_config={
                _DENSE: models.VectorParams(size=dense_dimension, distance=models.Distance.COSINE)
            },
            sparse_vectors_config={
                _SPARSE: models.SparseVectorParams(modifier=models.Modifier.IDF)
            },
        )
        await self._ensure_payload_indexes(client)

    async def _ensure_payload_indexes(self, client: AsyncQdrantClient) -> None:
        """필터에 쓰는 페이로드 인덱스를 만든다. 이미 있으면 같은 결과다."""
        indexed = {
            "doc_id": models.PayloadSchemaType.KEYWORD,
            "job_id": models.PayloadSchemaType.KEYWORD,
            "name": models.PayloadSchemaType.KEYWORD,
            "edition.label": models.PayloadSchemaType.KEYWORD,
            "active": models.PayloadSchemaType.BOOL,
            "is_latest_edition": models.PayloadSchemaType.BOOL,
        }
        for key, schema in indexed.items():
            await client.create_payload_index(self._collection, field_name=key, field_schema=schema)

    @staticmethod
    async def _close_quietly(client: AsyncQdrantClient) -> None:
        """클라이언트를 닫되 실패는 무시한다."""
        try:
            await client.close()
        except Exception:
            return

    async def close(self) -> None:
        """클라이언트를 닫고 미연결 상태로 돌린다. 여러 번 불러도 된다."""
        client, self._client = self._client, None
        self._dimension = None
        self._mismatch = False
        if client is not None:
            await client.close()

    async def ping(self) -> bool:
        """Qdrant에 닿는지만 돌려준다. 오류를 내지 않는다."""
        client = self._client
        if client is None:
            return False
        try:
            await client.get_collections()
        except Exception:
            return False
        return True

    # ── 공통 경로 ────────────────────────────────────────────────

    def _ready(self) -> AsyncQdrantClient:
        """연결·차원 상태를 확인하고 클라이언트를 돌려준다."""
        if self._client is None:
            raise RuntimeError(_NOT_CONNECTED)
        if self._mismatch:
            raise VectorDimensionMismatchError()
        return self._client

    @staticmethod
    def _unavailable(operation: str, exc: Exception) -> StoreUnavailableError:
        """연결 불가 로그를 남기고 StoreUnavailableError를 돌려준다. ★ 예외 문자열은 싣지 않는다."""
        log.warning("resource.store_unavailable", operation=operation)
        return StoreUnavailableError()

    # ── 쓰기 (indexing만 부른다) ─────────────────────────────────

    async def upsert(
        self,
        records: Sequence[ChunkRecord],
        dense: Sequence[Sequence[float]],
        sparse: Sequence[SparseVector],
    ) -> None:
        """레코드와 벡터를 받은 그대로 저장한다. 같은 chunk_id는 덮어쓴다."""
        client = self._ready()
        if not len(records) == len(dense) == len(sparse):
            raise ValueError("records, dense, sparse의 길이가 다릅니다")
        if self._dimension is not None and any(len(v) != self._dimension for v in dense):
            raise ValueError("dense 벡터의 길이가 connect에 준 차원과 다릅니다")
        if not records:
            return
        points = [
            models.PointStruct(
                id=_point_id(record.chunk_id),
                vector={
                    _DENSE: [float(x) for x in vector],
                    _SPARSE: _to_qdrant_sparse(keyword),
                },
                payload=_to_payload(record),
            )
            for record, vector, keyword in zip(records, dense, sparse, strict=True)
        ]
        try:
            for start in range(0, len(points), _UPSERT_BATCH):
                await client.upsert(
                    self._collection, points=points[start : start + _UPSERT_BATCH], wait=True
                )
        except ResponseHandlingException as exc:
            raise self._unavailable("upsert", exc) from exc
        grouped = Counter((record.doc_id, record.version) for record in records)
        for (doc_id, version), chunks in grouped.items():
            log.info("resource.upsert", doc_id=doc_id, version=version, chunks=chunks)

    async def activate_records(self, doc_id: str, chunk_ids: Collection[str]) -> None:
        """그 문서에서 chunk_ids에 든 레코드를 active=True로 바꾼다."""
        client = self._ready()
        if not chunk_ids:
            return
        # ★ 문서 조건을 함께 걸어 다른 문서의 같은 ID는 바꾸지 않는다
        target = models.Filter(must=[_match("doc_id", doc_id), _has_ids(chunk_ids)])
        await self._set_payload(client, "activate_records", {"active": True}, target)

    async def delete_records_except(self, doc_id: str, chunk_ids: Collection[str]) -> None:
        """그 문서에서 chunk_ids에 들지 않은 레코드를 모두 지운다. 빈 집합이면 모두 지운다."""
        client = self._ready()
        target = models.Filter(
            must=[_match("doc_id", doc_id)],
            must_not=[_has_ids(chunk_ids)] if chunk_ids else None,
        )
        await self._delete(client, "delete_records_except", target)

    async def delete_records(self, chunk_ids: Collection[str]) -> None:
        """chunk_ids의 레코드만 지운다."""
        client = self._ready()
        if not chunk_ids:
            return
        selector = models.PointIdsList(points=[_point_id(c) for c in sorted(set(chunk_ids))])
        try:
            await client.delete(self._collection, points_selector=selector, wait=True)
        except ResponseHandlingException as exc:
            raise self._unavailable("delete_records", exc) from exc

    async def delete_document(self, doc_id: str) -> None:
        """그 문서의 모든 버전 레코드를 지운다. 레코드가 없어도 오류가 아니다."""
        client = self._ready()
        await self._delete(
            client, "delete_document", models.Filter(must=[_match("doc_id", doc_id)])
        )

    async def set_document_metadata(self, doc_id: str, name: str, edition: Edition | None) -> None:
        """그 문서의 모든 버전 레코드의 이름과 판 정보를 바꾼다."""
        client = self._ready()
        await self._set_payload(
            client,
            "set_document_metadata",
            {"name": name, "edition": _edition_payload(edition)},
            models.Filter(must=[_match("doc_id", doc_id)]),
        )

    async def set_latest_editions(self, name: str, latest_doc_ids: frozenset[str]) -> None:
        """name이 같은 active 레코드의 최신판 표시를 latest_doc_ids 기준으로 맞춘다."""
        client = self._ready()
        base: list[models.Condition] = [_active(), _match("name", name)]
        if latest_doc_ids:
            await self._set_payload(
                client,
                "set_latest_editions",
                {"is_latest_edition": True},
                models.Filter(must=[*base, _doc_in(latest_doc_ids)]),
            )
        await self._set_payload(
            client,
            "set_latest_editions",
            {"is_latest_edition": False},
            models.Filter(
                must=base, must_not=[_doc_in(latest_doc_ids)] if latest_doc_ids else None
            ),
        )

    async def _set_payload(
        self,
        client: AsyncQdrantClient,
        operation: str,
        payload: dict[str, Any],
        target: models.Filter,
    ) -> None:
        """필터에 맞는 포인트의 페이로드 일부를 바꾼다."""
        try:
            await client.set_payload(self._collection, payload=payload, points=target, wait=True)
        except ResponseHandlingException as exc:
            raise self._unavailable(operation, exc) from exc

    async def _delete(
        self, client: AsyncQdrantClient, operation: str, target: models.Filter
    ) -> None:
        """필터에 맞는 포인트를 지운다."""
        try:
            await client.delete(
                self._collection, points_selector=models.FilterSelector(filter=target), wait=True
            )
        except ResponseHandlingException as exc:
            raise self._unavailable(operation, exc) from exc

    # ── 조회 ─────────────────────────────────────────────────────

    async def search_dense(
        self, vector: Sequence[float], flt: ChunkFilter, limit: int
    ) -> list[ScoredRecord]:
        """dense 벡터로 active 레코드를 찾아 점수 내림차순으로 최대 limit개를 돌려준다."""
        client = self._ready()
        self._check_limit(limit)
        if flt.doc_ids == ():
            return []
        return await self._query(
            client, "search_dense", [float(x) for x in vector], _DENSE, flt, limit
        )

    async def search_sparse(
        self, vector: SparseVector, flt: ChunkFilter, limit: int
    ) -> list[ScoredRecord]:
        """키워드 벡터로 active 레코드를 찾아 점수 내림차순으로 최대 limit개를 돌려준다."""
        client = self._ready()
        self._check_limit(limit)
        if flt.doc_ids == () or not vector.indices:
            return []
        return await self._query(
            client, "search_sparse", _to_qdrant_sparse(vector), _SPARSE, flt, limit
        )

    @staticmethod
    def _check_limit(limit: int) -> None:
        """limit이 1 이상인지 검사한다."""
        if limit < 1:
            raise ValueError("limit은 1 이상이어야 합니다")

    async def _query(
        self,
        client: AsyncQdrantClient,
        operation: str,
        query: list[float] | models.SparseVector,
        using: str,
        flt: ChunkFilter,
        limit: int,
    ) -> list[ScoredRecord]:
        """벡터 질의를 실행해 점수 붙은 레코드로 바꾼다. 순서는 Qdrant가 준 그대로다."""
        try:
            response = await client.query_points(
                self._collection,
                query=query,
                using=using,
                query_filter=_search_filter(flt),
                limit=limit,
                with_payload=True,
                with_vectors=False,
            )
        except ResponseHandlingException as exc:
            raise self._unavailable(operation, exc) from exc
        return [
            ScoredRecord(record=_from_payload(point.payload or {}), score=float(point.score))
            for point in response.points
        ]

    async def active_records(self, doc_id: str) -> list[ChunkRecord]:
        """그 문서의 active 레코드를 돌려준다. 순서는 보장하지 않는다."""
        client = self._ready()
        found = await self._scroll_all(
            client, "active_records", models.Filter(must=[_active(), _match("doc_id", doc_id)])
        )
        return [_from_payload(payload) for payload in found]

    async def active_editions(self, name: str) -> dict[str, Edition | None]:
        """name이 같은 active 레코드의 문서마다 판 정보를 돌려준다."""
        client = self._ready()
        found = await self._scroll_all(
            client, "active_editions", models.Filter(must=[_active(), _match("name", name)])
        )
        return {
            payload["doc_id"]: _edition_from_payload(payload.get("edition")) for payload in found
        }

    async def job_records(self, doc_id: str, job_id: str) -> list[ChunkRecord]:
        """그 문서에서 job_id가 같은 레코드를 active 여부와 관계없이 돌려준다."""
        client = self._ready()
        found = await self._scroll_all(
            client,
            "job_records",
            models.Filter(must=[_match("doc_id", doc_id), _match("job_id", job_id)]),
        )
        return [_from_payload(payload) for payload in found]

    async def _scroll_all(
        self, client: AsyncQdrantClient, operation: str, target: models.Filter
    ) -> list[Mapping[str, Any]]:
        """필터에 맞는 포인트의 페이로드를 끝까지 모은다."""
        payloads: list[Mapping[str, Any]] = []
        offset: PointId | None = None
        try:
            while True:
                points, offset = await client.scroll(
                    self._collection,
                    scroll_filter=target,
                    limit=_SCROLL_PAGE,
                    offset=offset,
                    with_payload=True,
                    with_vectors=False,
                )
                payloads.extend(point.payload or {} for point in points)
                if offset is None:
                    return payloads
        except ResponseHandlingException as exc:
            raise self._unavailable(operation, exc) from exc
