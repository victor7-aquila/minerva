# minerva

AI가 개발 문서를 검색해 활용할 수 있도록 하는 RAG(Retrieval-Augmented Generation) 서버.

Markdown 문서를 **Agentic Chunking**으로 의미 단위로 나누고, **Hybrid Search(Dense + BM25)** 와 **Reranker**로 검색한다.
개인 개발용으로 시작했지만 사내 폐쇄망 배포를 가정해, 모든 모델을 로컬에서 실행하는 구조로 설계했다.

> **현재 상태:** 초기 설계 단계

---

## 주요 기능

- **Agentic Chunking** — LLM이 문서 구조와 문맥을 보고 의미 단위로 분할
- **Hybrid Search + Reranker** — Dense 벡터 검색과 BM25를 RRF로 결합하고 Cross-Encoder로 재정렬
- **표·이미지 처리** — 표 요약·이미지 캡션 기반 색인, 검색 결과에서는 원본 표·이미지로 복원
- **검색 API** — AI 에이전트와 개발 도구를 위한 REST API
- **Console** — 문서 관리, 청크·요약·캡션 확인, 검색 테스트, 로그 조회

---

## 아키텍처

```
┌──────────────┐
│   Console    │ ──┐
│  (Next.js)   │   │      ┌──────────────────┐      ┌────────────────────┐
└──────────────┘   ├────▶ │     Backend      │ ───▶ │     RAG Server     │
┌──────────────┐   │      │    (NestJS)      │      │      (Python)      │
│   AI Agent   │ ──┘      └────────┬─────────┘      └─────────┬──────────┘
│   / Tools    │                   │                          │
└──────────────┘                   ▼                          ▼
                          ┌──────────────────┐      ┌────────────────────┐
                          │     MongoDB      │      │       Qdrant       │
                          │  + File Storage  │      │                    │
                          └──────────────────┘      └────────────────────┘
```

| 구성 요소 | 역할 |
| --- | --- |
| **Backend** | Console과 AI 요청의 진입점. 문서 관리, 검색 API, 검색 결과 복원 |
| **RAG Server** | 내부 연산 서비스. 요약·캡션 생성, 청킹, 임베딩, 검색, 리랭킹 |
| **Console** | 관리용 웹 UI |
| **MongoDB / File Storage** | 원본 문서, 표·이미지, 요약·캡션, 메타데이터, 로그 |
| **Qdrant** | Dense·BM25 벡터 인덱스 |

---

## 기술 스택

| 구분 | 선택 |
| --- | --- |
| Backend | NestJS |
| RAG Server | Python |
| Console | Next.js |
| Database | MongoDB, Qdrant |
| 청킹·표 요약 LLM | Qwen3-14B (4bit) |
| 이미지 캡션 VLM | Qwen3-VL-8B (4bit) |
| Embedding | Qwen3-Embedding-4B |
| Sparse Retrieval | BM25 |
| Fusion | RRF (Reciprocal Rank Fusion) |
| Reranker | bge-reranker-v2-m3 |
| Model Serving | Ollama (LLM·VLM), sentence-transformers (Embedding·Reranker) |
| API | REST (이후 MCP 지원) |

---

## 동작 방식

**색인**

```
MD 문서 → 전처리 (표·이미지 분리) → 요약·캡션 생성 → Agentic Chunking → 임베딩 + BM25 → Qdrant
```

**검색**

```
질의 → Dense + BM25 검색 → RRF → Reranker → 원본 표·이미지 복원 → 응답
```

---

## 로드맵

| 단계 | 내용 |
| --- | --- |
| **Phase 1** | MD 문서 기준 [주요 기능](#주요-기능) 구현 |
| **Phase 2** | PDF → MD 변환 |
| **Phase 3** | 형태소 분석 적용, 한/영 혼용 문서 처리 개선 |
| **이후** | IAM 도입과 MCP 지원, 검색 품질 평가, 이미지 저장소 S3 전환 |

---

## 모노레포 구조 (예정)

```
minerva/
├── apps/
│   ├── backend/            # NestJS — 문서 관리·검색 API
│   ├── rag-server/         # Python — RAG 파이프라인
│   └── console/            # Next.js — 관리용 웹 UI
├── docs/                   # 설계 문서
├── docker-compose.yml      # 로컬 개발용 인프라
├── LICENSE
└── README.md
```

---

## License

[MIT](./LICENSE)
