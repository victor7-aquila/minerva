# storage 모듈 명세 (REQ-BE-9)

MongoDB 연결과 이미지 파일 저장 인터페이스를 제공한다. 컬렉션은 각 소유 모듈이 이 연결로 다루며, storage는 컬렉션의 내용을 모른다. 파일 저장은 인터페이스로 감싸 이후 S3 호환 저장소로 바꿀 때 구현만 바꾼다. 폴더는 `apps/backend/src/storage`다.

## 요약

**핵심 계약**

- MongoDB에 연결할 수 없으면 기동하지 않는다. 연결 없이 요청을 받아 조용히 실패하지 않는다 (`REQ-BE-9.1.1`)
- 파일 키는 저장 위치 밖을 가리킬 수 없다. `..`이나 절대 경로가 든 키는 거부한다 (`REQ-BE-9.1.2`)

**기능 그룹**

| REQ | 기능 그룹 | 책임 |
| :--- | :--- | :--- |
| `REQ-BE-9.1` | 저장소 연결 | MongoDB 연결을 열어 제공하고, 이미지 파일을 설정한 위치에 읽고 쓴다 |

**비범위**

- 컬렉션별 스키마·인덱스·읽기 쓰기 — 각 소유 모듈 (`ARCHITECT.md` 「데이터·상태 소유」)
- 파일 키를 문서·버전·자리표시 ID로 만드는 규칙 — assets

## 구조

### 예상 배치

```text
src/storage/
├── index.ts
├── storage.module.ts
├── interfaces/
│   ├── file-store.ts
│   └── storage.tokens.ts
├── services/
│   ├── local-file-store.ts
│   └── mongo-connection.ts
└── MODULE.md

src/storage/**/*.spec.ts
test/                         # 실제 MongoDB·임시 폴더로 하는 e2e
```

## 의존성과 공개 표면

### 의존 관계

| 대상 | 관계 | 사용하는 계약 | 계약 소유 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| common | DI | `ConfigService`(`MONGODB_URI`, `FILE_STORAGE_DIR`), `InvalidRequestError`, `PinoLogger` (nestjs-pino) | common `MODULE.md` | `REQ-BE-9.1`, `REQ-BE-8.2.1` |
| MongoDB | 네트워크 (공식 드라이버 `mongodb`) | 연결, `Db` | MongoDB | `REQ-BE-9.1.1` |
| 파일 시스템 | 파일 | `FILE_STORAGE_DIR` 아래 | 이 문서 | `REQ-BE-9.1.2` |

### 공개 표면

| 기능 그룹 | 공개 표면 | 상세 계약 | 관련 REQ |
| :--- | :--- | :--- | :--- |
| 저장소 연결 | `StorageModule`, `MONGO_DB` 주입 토큰(`Db`) | 「저장소 연결 — REQ-BE-9.1」 | `REQ-BE-9.1.1` |
| 저장소 연결 | `FILE_STORE` 주입 토큰, `FileStore` 인터페이스 | 같은 절 | `REQ-BE-9.1.2` |

## 기능 그룹별 요구사항

### 저장소 연결 — `REQ-BE-9.1`

```typescript
/** MongoDB Db를 주입받는 토큰이다. */
export const MONGO_DB: unique symbol;

/** 파일 저장소를 주입받는 토큰이다. */
export const FILE_STORE: unique symbol;

/** 이미지 파일을 키로 읽고 쓴다. 키는 '/'로 구분한 상대 경로다. */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  deletePrefix(prefix: string): Promise<void>;
}

/** 저장소 모듈이다. MongoDB 연결과 로컬 파일 저장소를 제공한다. */
@Module({})
export class StorageModule {}
```

**`REQ-BE-9.1.1`** MongoDB 연결 실패 시 기동하지 않음

- 처리 계약: 모듈 초기화 때 `MONGODB_URI`로 연결하고 `ping`이 성공해야 초기화를 마친다. 종료할 때 연결을 닫는다
- 실패: 연결하지 못하면 `storage.mongo_connect_failed`를 error로 남기고 초기화를 실패시켜 앱이 기동하지 않는다. 로그에 연결 문자열을 넣지 않는다
- 충족 기준: 닿지 않는 주소로 초기화하면 앱 생성이 실패하고 error 로그가 남으며 그 로그에 연결 문자열이 없다. 닿는 주소면 `MONGO_DB`가 주입된다

**`REQ-BE-9.1.2`** 설정한 위치에 이미지 파일 저장

- 처리 계약: 로컬 구현은 `FILE_STORAGE_DIR` 아래 `key` 경로에 쓴다. 중간 폴더가 없으면 만든다. `read`는 없으면 `null`이다. `deletePrefix`는 그 접두사의 파일을 모두 지우고, 없으면 아무 일 없이 끝난다
- 실패: 키가 비었거나, 절대 경로이거나, `..`를 담으면 `InvalidRequestError`를 낸다
- 충족 기준: `put` 뒤 `read`가 같은 바이트를 돌려주고 파일이 설정한 위치 아래에 있으며, `../x` 키는 거부되고, `deletePrefix('doc1/')` 뒤 그 아래 파일이 없다

## 실행 계약

### 설정

정의는 common 「설정」이 소유한다. 이 모듈이 읽는 키: `MONGODB_URI`, `FILE_STORAGE_DIR`.

### 로그

| 이벤트 | 발생 시점 | 레벨 | 허용 필드 | 관련 REQ |
| :--- | :--- | :--- | :--- | :--- |
| `storage.mongo_connect_failed` | 기동 때 연결 실패 | error | `errorName` | `REQ-BE-9.1.1` |

## 테스트와 추적성

| REQ ID | 종류 | 검증 초점 | 대체 경계 | 예상 위치 |
| :--- | :--- | :--- | :--- | :--- |
| `REQ-BE-9.1.1` | e2e | 닿지 않는 주소에서 기동 실패와 로그, 정상 연결 | | `test/` |
| `REQ-BE-9.1.2` | unit | 쓰기·읽기 왕복, 없는 키 `null`, 경로 탈출 거부, 접두사 삭제 | 임시 폴더 | `src/storage/**/*.spec.ts` |
