import { describe, test, expect } from 'vitest';
import { createSerialQueue } from '../../src/core/util/serialQueue';

const defer = () => {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as typeof resolve;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('serial queue', () => {
  test('never runs two tasks at once', async () => {
    // The property FTP needs structurally: a second command on the control
    // connection while the first is in flight corrupts the exchange.
    const queue = createSerialQueue();
    let running = 0;
    let maxRunning = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        queue.run(async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await new Promise(r => setTimeout(r, 1));
          running -= 1;
        })
      )
    );

    expect(maxRunning).toBe(1);
  });

  test('preserves submission order', async () => {
    const queue = createSerialQueue();
    const order: number[] = [];

    await Promise.all(
      [30, 20, 10, 0].map((delay, i) =>
        queue.run(async () => {
          await new Promise(r => setTimeout(r, delay));
          order.push(i);
        })
      )
    );

    expect(order).toEqual([0, 1, 2, 3]);
  });

  test('returns each task its own result', async () => {
    const queue = createSerialQueue();
    const results = await Promise.all([
      queue.run(async () => 'a'),
      queue.run(async () => 'b'),
    ]);
    expect(results).toEqual(['a', 'b']);
  });

  test('a failure reaches its own caller and nobody else', async () => {
    const queue = createSerialQueue();
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const following = queue.run(async () => 'still ran');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('still ran');
  });

  test('one failure does not wedge the queue', async () => {
    const queue = createSerialQueue();
    for (let i = 0; i < 5; i++) {
      await expect(queue.run(async () => { throw new Error(`e${i}`); })).rejects.toThrow();
    }
    await expect(queue.run(async () => 'alive')).resolves.toBe('alive');
  });

  test('a task starts only once the previous one has settled', async () => {
    const queue = createSerialQueue();
    const first = defer();
    const started: string[] = [];

    const a = queue.run(async () => {
      started.push('a');
      await first.promise;
    });
    const b = queue.run(async () => {
      started.push('b');
    });

    await new Promise(r => setTimeout(r, 5));
    expect(started).toEqual(['a']);

    first.resolve();
    await Promise.all([a, b]);
    expect(started).toEqual(['a', 'b']);
  });

  test('reports how many tasks are waiting', async () => {
    const queue = createSerialQueue();
    const gate = defer();
    const running = queue.run(async () => { await gate.promise; });
    const queued = [queue.run(async () => undefined), queue.run(async () => undefined)];

    await new Promise(r => setTimeout(r, 1));
    expect(queue.waiting).toBe(2);

    gate.resolve();
    await Promise.all([running, ...queued]);
    expect(queue.waiting).toBe(0);
  });
});
