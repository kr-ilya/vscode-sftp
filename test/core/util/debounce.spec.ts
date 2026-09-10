import { describe, test, expect } from 'vitest';
import { debounce, Clock } from '../../../src/core/util/debounce';

/**
 * A clock the test drives by hand. No `vi.useFakeTimers`, no `sleep`: time only
 * moves when `advance` is called, so every assertion below is exact rather than
 * tolerant of a wall-clock window.
 */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();

  const clock: Clock = {
    now: () => now,
    setTimeout(handler, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };

  function advance(ms: number) {
    const target = now + ms;
    // Fire due timers in chronological order, allowing handlers to re-arm.
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, t] of timers) {
        if (t.at <= target && t.at < dueAt) {
          dueAt = t.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const timer = timers.get(dueId)!;
      timers.delete(dueId);
      now = timer.at;
      timer.handler();
    }
    now = target;
  }

  return { clock, advance };
}

describe('debounce', () => {
  test('trailing only: one invocation after the window closes', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, { clock });

    d();
    expect(calls).toEqual([]);
    advance(99);
    expect(calls).toEqual([]);
    advance(1);
    expect(calls).toEqual([100]);
  });

  test('trailing only: a burst collapses to a single invocation', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, { clock });

    // Calls land at t=0,50,100,150,200; the window closes 100ms after the last.
    for (let i = 0; i < 5; i++) {
      d();
      advance(50);
    }
    advance(100);
    expect(calls).toEqual([300]);
  });

  test('leading only: fires immediately, then not again within the window', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, {
      leading: true,
      trailing: false,
      clock,
    });

    d();
    expect(calls).toEqual([0]);
    advance(50);
    d();
    advance(50);
    expect(calls).toEqual([0]);
  });

  test('leading + trailing: a lone call fires once, not twice', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, {
      leading: true,
      trailing: true,
      clock,
    });

    d();
    advance(500);
    expect(calls).toEqual([0]);
  });

  test('leading + trailing: a burst fires at both edges', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, {
      leading: true,
      trailing: true,
      clock,
    });

    d();
    advance(50);
    d();
    advance(200);
    expect(calls).toEqual([0, 150]);
  });

  test('maxWait bounds how long continuous calls can defer an invocation', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, {
      trailing: true,
      maxWait: 250,
      clock,
    });

    // A call every 50ms would defer forever without maxWait.
    for (let i = 0; i < 10; i++) {
      d();
      advance(50);
    }
    // Bound is measured from the last invocation, not from the burst start.
    expect(calls).toEqual([250, 500]);
  });

  test('maxWait shorter than wait is rejected', () => {
    const { clock } = makeClock();
    expect(() => debounce(() => undefined, 100, { maxWait: 50, clock })).toThrow(/maxWait/);
  });

  test('disabling both edges is rejected', () => {
    const { clock } = makeClock();
    expect(() =>
      debounce(() => undefined, 100, { leading: false, trailing: false, clock })
    ).toThrow(/leading or trailing/);
  });

  test('the most recent arguments win', () => {
    const { clock, advance } = makeClock();
    const seen: string[] = [];
    const d = debounce((v: string) => seen.push(v), 100, { clock });

    d('first');
    d('second');
    d('third');
    advance(100);
    expect(seen).toEqual(['third']);
  });

  test('cancel drops the pending invocation', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, { clock });

    d();
    expect(d.pending()).toBe(true);
    d.cancel();
    expect(d.pending()).toBe(false);
    advance(500);
    expect(calls).toEqual([]);
  });

  test('flush invokes immediately and clears the timer', () => {
    const { clock, advance } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, { clock });

    d();
    advance(20);
    d.flush();
    expect(calls).toEqual([20]);
    expect(d.pending()).toBe(false);
    advance(500);
    expect(calls).toEqual([20]);
  });

  test('flush with nothing pending does nothing', () => {
    const { clock } = makeClock();
    const calls: number[] = [];
    const d = debounce(() => calls.push(clock.now()), 100, { clock });

    d.flush();
    expect(calls).toEqual([]);
  });

  test('a backwards clock jump does not wedge the timer', () => {
    let now = 1000;
    const timers: Array<{ at: number; handler: () => void }> = [];
    const clock: Clock = {
      now: () => now,
      setTimeout(handler, ms) {
        const t = { at: now + ms, handler };
        timers.push(t);
        return t;
      },
      clearTimeout(handle) {
        const i = timers.indexOf(handle as { at: number; handler: () => void });
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const calls: number[] = [];
    const d = debounce(() => calls.push(now), 100, { clock });

    d();
    // System clock steps backwards (NTP correction, VM resume).
    now = 500;
    const timer = timers.shift()!;
    timer.handler();

    expect(calls).toEqual([500]);
  });
});
