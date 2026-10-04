# AGENTS.md — Console

minerva의 Console 앱(Next.js App Router)이다. 문서 관리, 청크·요약·캡션 확인, 골든셋 평가, 로그 조회를 하는 관리용 웹 UI다. 전체 구성은 저장소 루트 `README.md`의 「아키텍처」를 본다.

## 절대 규칙

이 절은 아래 모든 절보다 우선한다.

### 금지

- RAG Server, MongoDB, Qdrant를 직접 호출하지 않는다. 데이터는 모두 Backend API로 주고받는다 — Backend가 Console 요청의 유일한 진입점이다
- 비밀 값을 `NEXT_PUBLIC_` 환경 변수에 넣지 않는다 — 브라우저 번들에 그대로 포함된다

## 코딩 규칙

- 서버 컴포넌트를 기본으로 쓴다. `'use client'`는 상태·이벤트 핸들러·브라우저 API가 필요한 파일에만 붙인다
- Backend 호출은 API 클라이언트 모듈 한 곳을 거친다. 컴포넌트에서 `fetch`를 직접 부르지 않고, 클라이언트 컴포넌트는 TanStack Query 훅으로 서버 데이터를 읽고 쓴다
- 버튼·표·다이얼로그·폼 요소처럼 MUI에 있는 컴포넌트는 직접 만들지 않고 MUI 것을 쓴다
- 색과 글꼴 크기는 MUI theme 값(`theme.palette`, `theme.typography`)으로만 준다. 배치와 간격은 Tailwind 기본 스케일 클래스로 준다. 색 코드, px 값, Tailwind 임의값(`p-[13px]` 같은)을 컴포넌트에 직접 쓰지 않는다
- 화면 문구(버튼, 안내, 오류 표시)는 한국어로 쓴다

## 테스트 규칙

- 도구는 Vitest와 Testing Library를 쓴다
- 테스트는 검증하는 REQ ID를 이름으로 한 `describe` 블록 안에 둔다 (예: `describe('REQ-FE-1.2.3', () => { ... })`). REQ ID 없는 테스트를 추가하지 않는다
