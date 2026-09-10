import type { Clock } from '../../src/core/util/debounce';

/**
 * A clock the test drives by hand.
 *
 * No `vi.useFakeTimers`, no `sleep`: time moves only when `advance` is called,
 * so assertions about debouncing are exact rather than tolerant of a wall-clock
 * window. Timers are fired in chronological order and handlers may re-arm.
 */
export function makeClock(start = 0) {
  let now = start;
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

  return { clock, advance, now: () => now, pendingTimers: () => timers.size };
}
