import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createLogCapture } from '../../../test/support/log-capture';
import { createTestCommonModule } from '../../../test/support/test-common.module';
import { EvaluationTasks } from './evaluation-tasks';

// ★ 캡처 stream은 파일 맨 위에서 한 번만 만든다(nestjs-pino 루트 로거가 파일당 하나)
const capture = createLogCapture();

const PINO_BASE = ['level', 'time', 'pid', 'hostname', 'context', 'msg'];

let moduleRef: TestingModule;
let tasks: EvaluationTasks;

beforeEach(async () => {
  capture.clear();
  moduleRef = await Test.createTestingModule({
    imports: [createTestCommonModule({}, capture.stream)],
    providers: [EvaluationTasks],
  }).compile();
  tasks = moduleRef.get(EvaluationTasks);
});

afterEach(async () => {
  await tasks.drain();
  await moduleRef.close();
});

describe('REQ-BE-5.2.1', () => {
  it('T-TASK-1 작업은 호출한 다음 차례에 시작하고 drain은 안에서 더한 작업도 기다린다', async () => {
    const inner = jest.fn(async (): Promise<void> => undefined);
    const work = jest.fn(async (): Promise<void> => {
      tasks.run('evaluate', 'gs-2', inner);
    });
    tasks.run('evaluate', 'gs-1', work);
    // ★ 응답이 나간 뒤에 시작한다
    expect(work).toHaveBeenCalledTimes(0);
    await tasks.drain();
    expect(work).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('REQ-BE-8.2.1', () => {
  it('T-TASK-2 작업 실패는 던지지 않고 이름만 남긴다', async () => {
    tasks.run(
      'evaluate',
      'gs-1',
      jest.fn(async (): Promise<void> => {
        throw new TypeError('boom QUERY-SENT-71');
      }),
    );
    await tasks.drain();
    const lines = capture.parsed().filter((line) => line.msg === 'evaluation.task_failed');
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe(40);
    expect(
      Object.keys(line)
        .filter((key) => !PINO_BASE.includes(key))
        .sort(),
    ).toEqual(['errorName', 'goldenSetId', 'task']);
    expect(line.errorName).toBe('TypeError');
    expect(line.goldenSetId).toBe('gs-1');
    expect(line.task).toBe('evaluate');
    for (const raw of capture.lines) {
      expect(raw).not.toContain('boom');
      expect(raw).not.toContain('QUERY-SENT-71');
    }
  });

  it('T-FU-TASK-1 fail_records는 작업 실패 로그의 task 값으로만 받고 작업 이름으로는 받지 않는다', () => {
    tasks.logFailure('fail_records', null, new Error('x'));
    const lines = capture.parsed().filter((line) => line.msg === 'evaluation.task_failed');
    expect(lines.map((line) => line.task)).toEqual(['fail_records']);
    // ★ 타입 검사만 한다 — 부르지 않는다
    const typeOnly = (): void => {
      // @ts-expect-error -- fail_records는 작업 이름(EvaluationTaskName)이 아니다
      tasks.run('fail_records', null, async () => undefined);
    };
    expect(typeof typeOnly).toBe('function');
  });
});

describe('REQ-BE-5.2.4', () => {
  it('T-TASK-3 종료가 시작된 뒤에는 새 작업을 시작하지 않는다', async () => {
    await tasks.beforeApplicationShutdown();
    expect(tasks.stopping).toBe(true);
    const work = jest.fn(async (): Promise<void> => undefined);
    tasks.run('evaluate_all', null, work);
    await tasks.drain();
    expect(work).toHaveBeenCalledTimes(0);
  });
});
