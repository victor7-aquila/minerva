# AGENTS.md — Backend

minerva의 Backend 앱(NestJS)이다. Console과 AI 에이전트 요청의 진입점으로, 문서 관리·검색 API·검색 결과 복원을 맡는다. 전체 구성은 저장소 루트 `README.md`의 「아키텍처」를 본다.

## 절대 규칙

이 절은 아래 모든 절보다 우선한다.

### 금지

- Qdrant에 직접 접속하지 않는다. 검색은 RAG Server에 요청한다 — Qdrant는 RAG Server만 다룬다

## 코딩 규칙

- 로그는 nestjs-pino의 `PinoLogger`로 남긴다. 첫 인자에 필드 객체를, 메시지 자리에 `모듈.동작` 형식의 이벤트명을 쓴다 (예: `this.logger.info({ docId, chunks }, 'document.indexed')`). `console.log`와 템플릿 문자열로 조립한 메시지를 로그로 남기지 않는다
- 설정값은 `ConfigService`로만 읽는다. 설정 모듈 밖에서 `process.env`를 직접 읽지 않는다
- 컨트롤러·서비스에서 try/catch로 HTTP 응답을 만들지 않는다. 실패는 도메인 예외로 던지고, 전역 Exception Filter가 HTTP 상태 코드와 한국어 메시지로 바꾼다
- 요청 바디·쿼리·경로 파라미터는 DTO 클래스와 class-validator 데코레이터로 검증한다. 컨트롤러 안에서 값을 직접 검사하지 않는다
- provider는 생성자 주입으로만 쓴다. 서비스·리포지토리를 `new`로 만들지 않는다

## 테스트 규칙

- 도구는 Jest를 쓴다
- 테스트는 검증하는 REQ ID를 이름으로 한 `describe` 블록 안에 둔다 (예: `describe('REQ-BE-1.2.3', () => { ... })`). REQ ID 없는 테스트를 추가하지 않는다
