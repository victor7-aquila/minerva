import { randomBytes } from 'node:crypto';

/** e2e 시작 전에 이번 실행의 식별자를 정한다. 환경 변수로 워커와 global-teardown에 전달된다. */
export default function globalSetup(): void {
  process.env.E2E_RUN_ID = randomBytes(4).toString('hex');
}
