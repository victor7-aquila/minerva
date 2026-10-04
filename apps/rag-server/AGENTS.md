# AGENTS.md — RAG Server

minerva의 RAG Server 앱(Python)이다. Backend만 호출하는 내부 연산 서비스로, 요약·캡션 생성, Agentic Chunking, 색인, 검색, 리랭킹, 골든셋 평가, 색인 작업 관리를 맡는다. 전체 구성과 모델 선택은 저장소 루트 `README.md`의 「아키텍처」와 「기술 스택」을 본다.

## 절대 규칙

이 절은 아래 모든 절보다 우선한다.

### 금지

- MongoDB와 파일 저장소에 접속하지 않는다. 처리할 데이터는 Backend가 요청에 담아 보낸 것만 쓴다 — 원본 문서·표·이미지·요약·캡션은 Backend가 저장한다
- 외부에서 호스팅하는 모델 API(클라우드 LLM·임베딩·리랭커 API)를 호출하지 않는다. 모델은 로컬에서 Ollama(LLM·VLM)와 sentence-transformers(임베딩·리랭커)로 실행한다 — 사내 폐쇄망 배포를 가정한다

## 코딩 규칙

- 로그는 structlog 구조화 이벤트로만 남긴다. 모듈 맨 위에 `log = get_logger(__name__)`를 두고, 이벤트명은 `모듈.동작` 형식으로 쓴다 (예: `log.info("store.upsert", doc_id=doc_id, chunks=len(chunks))`). `print()`나 f-string으로 조립한 메시지를 로그로 남기지 않는다
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
- 모든 테스트에 검증하는 REQ ID를 `@pytest.mark.req("REQ-RAG-1.2.3")` 마커로 달고, docstring 첫 줄에도 `[REQ-RAG-1.2.3]`으로 적는다. REQ ID 없는 테스트를 추가하지 않는다
- 테스트 함수명은 영문 snake_case로 짧게 쓰고, 무엇을 왜 검증하는지는 한국어 docstring에 쓴다
- LLM 호출은 mock으로 대체한다. LLM 응답·임베딩 벡터처럼 실행마다 달라지는 값은 정확한 값이 아니라 지켜야 할 성질만 검증한다
- 검색 품질(정확도 임계값)은 pytest에서 검증하지 않는다 — 품질은 평가 API(`REQ-RAG-6`)로 Console의 골든셋 평가에서 잰다. pytest는 평가 지표의 계산 규칙만 검증한다
