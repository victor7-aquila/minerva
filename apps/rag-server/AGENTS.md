# AGENTS.md — RAG Server

minerva의 RAG Server 앱(Python)이다. Backend만 호출하는 내부 연산 서비스로, 요약·캡션 생성, Agentic Chunking, 색인, 검색, 리랭킹, 골든셋 평가, 색인 작업 관리를 맡는다. 전체 구성과 모델 선택은 저장소 루트 `README.md`의 「아키텍처」와 「기술 스택」을 본다.

## 절대 규칙

이 절은 아래 모든 절보다 우선한다.

### 금지

- MongoDB와 파일 저장소에 접속하지 않는다. 처리할 데이터는 Backend가 요청에 담아 보낸 것만 쓴다 — 원본 문서·표·이미지·요약·캡션은 Backend가 저장한다
- 외부에서 호스팅하는 모델 API(클라우드 LLM·임베딩·리랭커 API)를 호출하지 않는다. 모델은 로컬에서 Ollama(LLM·VLM)와 sentence-transformers(임베딩·리랭커)로 실행한다 — 사내 폐쇄망 배포를 가정한다

## 명령어

모든 명령은 `apps/rag-server`에서 실행한다. `uv run`은 bash와 Windows PowerShell에서 같게 쓴다.

| 목적 | 명령 | 비고 |
| :--- | :--- | :--- |
| 설치 | `uv sync` | `uv.lock` 기준. torch는 CPU 휠 인덱스에서 받는다 |
| 포맷 검사 | `uv run ruff format --check .` | |
| 린트 | `uv run ruff check .` | |
| 타입 검사 | `uv run basedpyright` | |
| 의존 방향 | `uv run lint-imports` | 계약은 `pyproject.toml` `[tool.importlinter]` |
| 미사용 의존성 | `uv run deptry .` | |
| 단위 테스트 | `uv run pytest tests/unit` | 외부 자원 없이 돈다 |
| 통합 테스트 | `uv run pytest tests/integration` | Qdrant·설정이 없으면 skip. 실제 모델 테스트는 `MINERVA_IT_MODELS=1`과 Ollama가 있어야 돈다 |
| 서버 실행 | `uv run uvicorn minerva_rag.api:create_app --factory` | Qdrant·Ollama가 먼저 떠 있어야 하고 설정 모델이 준비돼 있어야 한다. 설정은 `.env` 또는 환경 변수(`.env.example` 참고) |

인프라는 저장소 루트에서 띄운다.

| 목적 | 명령 | 비고 |
| :--- | :--- | :--- |
| Qdrant | `docker compose up -d qdrant` | |
| Ollama (compose) | `docker compose --profile ollama up -d ollama` | 호스트에 Ollama를 설치했으면 띄우지 않는다(같은 포트). Windows는 GPU를 쓰는 호스트 설치를 권장한다 |

환경 변수로 설정할 때의 문법만 셸마다 다르다: bash는 `RAG_QDRANT_URL=http://127.0.0.1:6333 uv run …`, PowerShell은 `$env:RAG_QDRANT_URL="http://127.0.0.1:6333"; uv run …`.

**Windows에서 주의할 점**

- 주소는 `localhost` 대신 `127.0.0.1`을 쓴다. `localhost`는 IPv6(`::1`)를 먼저 시도해 Qdrant 호출마다 수백 ms 늦어진다
- `.env`는 UTF-8로 저장한다. PowerShell 5.1의 `>`·`Set-Content` 기본값(UTF-16, cp949)으로 저장하면 기동하지 못한다
- 서버 출력을 파일·파이프로 리디렉션할 때는 `$env:PYTHONUTF8="1"`을 준다. 한국어 Windows는 리디렉션 출력이 cp949라 일부 문자가 이스케이프돼 기록된다
- pytest 출력의 `Windows fatal exception: access violation` 스택 덤프는 네이티브 라이브러리 안에서 이미 처리된 예외를 faulthandler가 찍은 것이다. 테스트 결과(passed·failed)로 판정한다
- 서버는 Ctrl+C로 정상 종료하고 종료 코드 0을 낸다. Ctrl+Break도 종료 처리는 같지만 종료 코드가 0이 아니다

## 코딩 규칙

- 로그는 structlog 구조화 이벤트로만 남긴다. 모듈 맨 위에 `log = get_logger(__name__)`를 두고, 이벤트명은 `모듈.동작` 형식으로 쓴다 (예: `log.info("resource.upsert", doc_id=doc_id, chunks=len(chunks))`). `print()`나 f-string으로 조립한 메시지를 로그로 남기지 않는다
- 서비스 계층의 공개 함수는 진입 시 로그 이벤트를 남긴다. 실패해도 정상 응답이 나갈 수 있는 함수(폴백이 있는 함수)는 종료 시에도 남긴다
- 서비스 계층에서 도메인 예외는 `log.warning`으로 남기고 그대로 전파한다. 그 밖의 예외는 `log.exception`으로 스택을 남긴다. 라우터마다 try/except를 두지 않고 전역 예외 핸들러로 처리한다
- Ollama·Qdrant 같은 I/O 호출은 `async`로 쓴다. BM25 스코어링·PyTorch 추론 같은 CPU 작업은 `asyncio.to_thread`로 감싼다 — 이벤트 루프를 막지 않기 위해서다
- 공개 함수·클래스에는 `"""~한다."""` 형태의 한 줄 한국어 docstring을 단다. Args/Returns 블록은 쓰지 않는다
- 모듈 안에서만 쓰는 헬퍼 함수 이름에는 `_` 접두사를 붙인다
- 설정값은 캐시된 설정 팩토리 함수로만 읽는다. 설정이 필요한 곳에서 설정 클래스를 직접 생성하지 않는다
- `pyproject.toml`의 의존성에는 버전 하한(`>=`)만 적는다. 정확한 버전은 lock 파일이 고정한다
- `# noqa`를 쓸 때는 규칙 코드와 사유를 함께 적는다 (예: `# noqa: E501 — URL이라 줄을 나눌 수 없음`)

## 테스트 규칙

- 도구는 pytest를 쓴다
- 모든 테스트에 검증하는 REQ ID를 `@pytest.mark.req("REQ-RAG-4.1.1")` 마커로 달고, docstring 첫 줄에도 `[REQ-RAG-4.1.1]`으로 적는다. REQ ID 없는 테스트를 추가하지 않는다
- 테스트 함수명은 영문 snake_case로 짧게 쓰고, 무엇을 왜 검증하는지는 한국어 docstring에 쓴다
- LLM 호출은 mock으로 대체한다. LLM 응답·임베딩 벡터처럼 실행마다 달라지는 값은 정확한 값이 아니라 지켜야 할 성질만 검증한다
- 검색 품질(정확도 임계값)은 pytest에서 검증하지 않는다 — 품질은 평가 API(`REQ-RAG-6`)로 Console의 골든셋 평가에서 잰다. pytest는 평가 지표의 계산 규칙만 검증한다
