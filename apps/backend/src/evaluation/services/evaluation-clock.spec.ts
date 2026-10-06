import { EvaluationClock } from './evaluation-clock';

describe('REQ-BE-5.3.2', () => {
  let spy: jest.SpyInstance<number, []>;

  afterEach(() => {
    // ★ spy는 매번 되돌린다
    spy.mockRestore();
  });

  it('T-PR3-CLK-1 시각이 고정되거나 뒤로 돌아가도 값이 엄격히 증가한다', () => {
    spy = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const clock = new EvaluationClock();

    // 같은 밀리초에 여러 번 불려도 1ms씩 늦어진다
    expect([clock.now(), clock.now(), clock.now()].map((d) => d.getTime())).toEqual([
      1000, 1001, 1002,
    ]);

    // 시계가 뒤로 돌아가도 직전 값보다 늦다
    spy.mockReturnValue(500);
    expect(clock.now().getTime()).toBe(1003);

    // 시계가 앞서 있으면 그 시각을 그대로 준다
    spy.mockReturnValue(5000);
    expect(clock.now().getTime()).toBe(5000);
  });
});
