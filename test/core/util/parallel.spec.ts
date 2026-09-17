import { describe, test, expect } from 'vitest';
import { createLimit, inParallel } from '../../../src/core/util/parallel';

const tick = (ms = 1) => new Promise(resolve => setTimeout(resolve, ms));

describe('createLimit', () => {
  test('never runs more than the budget at once', async () => {
    const limit = createLimit(3);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick(2);
          active -= 1;
        })
      )
    );

    expect(peak).toBe(3);
  });

  test('a slot is given back when the work throws', async () => {
    // Otherwise the budget shrinks with every failure until nothing can start.
    const limit = createLimit(1);

    await expect(
      limit.run(async () => {
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');

    await expect(limit.run(async () => 'went through')).resolves.toBe('went through');
    expect(limit.active).toBe(0);
  });

  test('waiters are let in first come, first served', async () => {
    const limit = createLimit(1);
    const order: number[] = [];

    const first = limit.run(() => tick(5));
    const rest = [1, 2, 3].map(n => limit.run(async () => void order.push(n)));

    await Promise.all([first, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('a budget below one is still one, not none', async () => {
    const limit = createLimit(0);
    await expect(limit.run(async () => 'ran')).resolves.toBe('ran');
  });

  test('the result of the work is what comes back', async () => {
    const limit = createLimit(2);
    expect(await limit.run(async () => 42)).toBe(42);
  });
});

describe('inParallel', () => {
  test('covers every item, at most `limit` at a time', async () => {
    const seen: number[] = [];
    let active = 0;
    let peak = 0;

    await inParallel([1, 2, 3, 4, 5, 6, 7], 2, async item => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(2);
      seen.push(item);
      active -= 1;
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(2);
  });

  test('an empty list resolves without starting a worker', async () => {
    let started = false;
    await inParallel([], 4, async () => void (started = true));
    expect(started).toBe(false);
  });
});
