import { dropAllTestDbs } from './mongo-test-db';

/**
 * e2e가 모두 끝난 뒤 중단 등으로 남은 이번 실행의 테스트 DB(`minerva_test_<실행 식별자>_*`)를 지운다.
 * ★ 다른 실행의 DB는 지우지 않는다. Mongo에 닿지 않으면 조용히 넘어간다.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await dropAllTestDbs();
  } catch {
    // 정리는 최선 노력이다. 닿지 않으면 남은 DB도 없다고 본다
  }
}
