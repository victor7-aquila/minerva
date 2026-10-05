/** 이미지 파일을 키로 읽고 쓴다. 키는 '/'로 구분한 상대 경로다. */
export interface FileStore {
  /** 키 자리에 데이터를 쓴다. 중간 폴더가 없으면 만든다. */
  put(key: string, data: Buffer): Promise<void>;
  /** 키 자리의 데이터를 읽는다. 없으면 null이다. */
  read(key: string): Promise<Buffer | null>;
  /** 접두사로 시작하는 키의 파일을 모두 지운다. 없으면 아무 일 없이 끝난다. */
  deletePrefix(prefix: string): Promise<void>;
}
