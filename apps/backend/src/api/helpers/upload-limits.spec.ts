import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../common';
import {
  fileTooLargeMessage,
  formatBytes,
  readUploadLimits,
  requestTooLargeMessage,
  tooManyFilesMessage,
} from './upload-limits';

/** 표 값을 돌려주는 가짜 ConfigService를 만든다. */
function fakeConfig(values: Record<string, number>): ConfigService<AppConfig, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

describe('REQ-BE-7.1.1', () => {
  it('T-LIM-1 파일 하나 한도는 MD와 이미지 중 큰 쪽이다', () => {
    expect(
      readUploadLimits(
        fakeConfig({
          UPLOAD_MAX_MD_BYTES: 10,
          UPLOAD_MAX_IMAGE_BYTES: 20,
          UPLOAD_MAX_FILES: 3,
          UPLOAD_MAX_TOTAL_BYTES: 100,
        }),
      ),
    ).toEqual({ maxFiles: 3, maxFileBytes: 20, maxTotalBytes: 100 });
    expect(
      readUploadLimits(
        fakeConfig({
          UPLOAD_MAX_MD_BYTES: 30,
          UPLOAD_MAX_IMAGE_BYTES: 20,
          UPLOAD_MAX_FILES: 3,
          UPLOAD_MAX_TOTAL_BYTES: 100,
        }),
      ).maxFileBytes,
    ).toBe(30);
  });
});

describe('REQ-BE-1.1.10', () => {
  it.each([
    [10485760, '10MB'],
    [20971520, '20MB'],
    [209715200, '200MB'],
    [2048, '2KB'],
    [2000, '2000바이트'],
    [1, '1바이트'],
  ])('T-LIM-2 formatBytes(%d)는 %s이다', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('T-LIM-3 413 메시지는 고정 한국어 문장이다', () => {
    expect(tooManyFilesMessage(3)).toBe('파일은 한 요청에 3개까지 올릴 수 있습니다');
    expect(fileTooLargeMessage('큰 문서.md', 2000)).toBe(
      '파일 하나의 크기 한도(2000바이트)를 넘었습니다: 큰 문서.md',
    );
    expect(fileTooLargeMessage('', 2000)).not.toContain(':');
    expect(requestTooLargeMessage(209715200)).toBe('요청 전체 크기 한도(200MB)를 넘었습니다');
    for (const message of [
      tooManyFilesMessage(3),
      fileTooLargeMessage('', 2000),
      requestTooLargeMessage(209715200),
    ]) {
      expect(message).toMatch(/[가-힣]/);
      expect(message).not.toMatch(/[\\/]/);
    }
  });
});
