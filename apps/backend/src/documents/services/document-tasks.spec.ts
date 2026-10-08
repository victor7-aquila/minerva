import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import { deferred, MD_SENT } from '../../../test/support/documents-fixtures';
import { DocumentClock } from './document-clock';
import { DocumentTasks } from './document-tasks';

// ★ nestjs-pino 루트 로거는 파일당 하나다. 캡처는 파일 맨 위에서 한 번만 만든다
const capture = createLogCapture();

let moduleRef: TestingModule;
let tasks: DocumentTasks;

beforeEach(async () => {
  capture.clear();
  moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({}, capture.stream)],
    providers: [DocumentTasks],
  }).compile();
  tasks = moduleRef.get(DocumentTasks);
});

afterEach(async () => {
  await tasks.drain();
  await moduleRef.close();
});

describe('REQ-BE-1.1.9', () => {
  it('T-TASK-1 run은 작업을 바로 부르지 않고 drain 뒤에는 중첩 작업까지 끝나 있다', async () => {
    const calls: string[] = [];
    tasks.run('process', 'doc-1', async () => {
      calls.push('outer');
      // 작업 안에서 또 run한다
      tasks.run('index', 'doc-1', async () => {
        calls.push('inner');
      });
    });
    expect(calls).toEqual([]);
    await tasks.drain();
    expect(calls).toEqual(['outer', 'inner']);
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-TASK-2 실패한 작업은 drain을 막지 않고 메시지 없는 한 줄만 남긴다', async () => {
    tasks.run('process', 'doc-1', async () => {
      throw new Error(MD_SENT);
    });
    await expect(tasks.drain()).resolves.toBeUndefined();
    const lines = capture.parsed().filter((line) => line.msg === 'documents.task_failed');
    expect(lines).toHaveLength(1);
    const pino = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];
    const keys = Object.keys(lines[0])
      .filter((key) => !pino.includes(key))
      .sort();
    expect(keys).toEqual(['docId', 'errorName', 'task']);
    expect(lines[0].errorName).toBe('Error');
    expect(lines[0].task).toBe('process');
    expect(lines[0].docId).toBe('doc-1');
    expect(capture.lines.join('\n')).not.toContain(MD_SENT);
  });
});

describe('REQ-BE-1.9.9', () => {
  it('T-TASK-3 종료 전에 stopping이 켜지고 진행 중인 작업이 끝나야 돌아오며 새 작업은 시작하지 않는다', async () => {
    const gate = deferred();
    let finished = false;
    tasks.run('process', 'doc-1', async () => {
      await gate.promise;
      finished = true;
    });
    // 작업이 시작될 때까지 기다린다
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(tasks.stopping).toBe(false);

    const shutdown = tasks.beforeApplicationShutdown();
    expect(tasks.stopping).toBe(true);
    let returned = false;
    void shutdown.then(() => {
      returned = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    gate.resolve();
    await shutdown;
    expect(finished).toBe(true);

    let called = false;
    tasks.run('index', 'doc-2', async () => {
      called = true;
    });
    await tasks.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(called).toBe(false);
  });
});

describe('REQ-BE-1.8.4', () => {
  it('T-TASK-4 종료는 stopSignal을 먼저 중단해, 그 신호를 기다리는 작업이 종료를 붙잡지 않는다', async () => {
    expect(tasks.stopSignal.aborted).toBe(false);
    let abortedInTask = false;
    tasks.run('delete_chunks', 'doc-1', async () => {
      // 오래 기다리는 RAG 요청 대신, 신호가 중단될 때까지 끝나지 않는 작업이다
      await new Promise<void>((resolve) => {
        tasks.stopSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      abortedInTask = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await tasks.beforeApplicationShutdown();
    expect(tasks.stopSignal.aborted).toBe(true);
    expect(abortedInTask).toBe(true);
  });
});

describe('REQ-BE-1.2.4', () => {
  it('T-CLK-1 같은 밀리초 안에서 1000번 불러도 값이 계속 커진다', () => {
    const clock = new DocumentClock();
    let previous = clock.now().getTime();
    for (let i = 0; i < 1000; i += 1) {
      const current = clock.now().getTime();
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });
});
