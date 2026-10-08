import { DOC_A, DOC_B, docRecord, versionRecord } from '../../../test/support/documents-fixtures';
import { createFakeDb } from '../../../test/support/fake-mongo';
import { DocumentsCrudService } from './documents-crud.service';

describe('REQ-BE-1.1.1', () => {
  it('T-PR3-F2-3 deleteDocumentRecord는 그 문서 레코드만 지우고 버전 레코드와 다른 문서는 둔다', async () => {
    const db = createFakeDb();
    // ★ 가짜 Db는 드라이버 Db와 모양이 달라 never로 넘긴다
    const repo = new DocumentsCrudService(db as never);
    await repo.insertDocument(docRecord({ docId: DOC_A, name: 'a' }));
    await repo.insertDocument(docRecord({ docId: DOC_B, name: 'b' }));
    await repo.insertVersion(versionRecord({ docId: DOC_A, version: '1' }));

    await repo.deleteDocumentRecord(DOC_A);

    expect(db.dump('documents').map((doc) => doc.docId)).toEqual([DOC_B]);
    expect(db.dump('document_versions')).toHaveLength(1);
  });
});

describe('REQ-BE-1.5.5', () => {
  it('T-PR3-TYPE-1 갱신 인자의 필드 이름·점 경로·조건 키 오타는 컴파일되지 않는다', () => {
    // ★ 실행하지 않는다 — 타입 검사만 본다
    function typeOnly(repo: DocumentsCrudService): void {
      void repo.updateDocument(
        { docId: 'x' },
        { processingState: 'failed', 'pendingRag.metadata': true },
      );
      // @ts-expect-error 없는 필드 이름은 컴파일되지 않는다
      void repo.updateDocument({ docId: 'x' }, { procesingState: 'failed' });
      // @ts-expect-error 점 경로는 pendingRag 두 개만이다
      void repo.updateDocument({ docId: 'x' }, { 'pendingRag.other': true });
      // @ts-expect-error 버전 갱신에 없는 필드
      void repo.updateVersion('x', '1', { jobID: 'j' });
      // @ts-expect-error 조건 키는 VersionCondition 범위뿐이다
      void repo.updateVersion('x', '1', { failure: null }, { 'failure.cod': 'X' });
    }
    expect(typeof typeOnly).toBe('function');
  });
});
