/** MongoDB Db를 주입받는 토큰이다. */
export const MONGO_DB: unique symbol = Symbol('MONGO_DB');

/** 파일 저장소를 주입받는 토큰이다. */
export const FILE_STORE: unique symbol = Symbol('FILE_STORE');

// ★ 내부 토큰. 배럴로 내보내지 않는다
/** 연결된 MongoClient를 주입받는 내부 토큰이다. */
export const MONGO_CLIENT: unique symbol = Symbol('MONGO_CLIENT');
