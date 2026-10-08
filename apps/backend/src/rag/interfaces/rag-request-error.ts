/** RAG Server가 4xx·5xx(503 제외)로 응답했다. code는 RAG Server의 오류 코드다. */
export class RagRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    // ★ RAG Server의 error.message와 요청 내용을 넣지 않는다
    super(`RAG Server가 오류로 응답했습니다 (상태 ${status}, 코드 ${code})`);
    this.name = 'RagRequestError';
    this.status = status;
    this.code = code;
  }
}
