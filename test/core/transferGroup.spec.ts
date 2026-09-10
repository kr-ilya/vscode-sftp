import { describe, test, expect } from 'vitest';
import { createTransferGroup, type CancellableTask } from '../../src/core/transferGroup';

const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));

function trackedTask(log: { running: number; max: number }, ms = 5): CancellableTask {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    async run() {
      if (cancelled) return;
      log.running += 1;
      log.max = Math.max(log.max, log.running);
      await tick(ms);
      log.running -= 1;
    },
  };
}

describe('concurrency is a budget for the service, not for each operation', () => {
  test('two batches together never exceed the limit', async () => {
    // Upstream gave every operation its own scheduler with its own budget, so
    // `concurrency: 2` with three overlapping uploads meant six transfers --
    // which is how a setting meant to be polite trips MaxSessions.
    const log = { running: 0, max: 0 };
    const group = createTransferGroup({ concurrency: 2 });

    const a = group.openBatch();
    const b = group.openBatch();
    for (let i = 0; i < 10; i++) a.add(trackedTask(log));
    for (let i = 0; i < 10; i++) b.add(trackedTask(log));

    await Promise.all([a.run(), b.run()]);
    expect(log.max).toBeLessThanOrEqual(2);
  });

  test('a single batch respects the limit too', async () => {
    const log = { running: 0, max: 0 };
    const group = createTransferGroup({ concurrency: 3 });
    const batch = group.openBatch();
    for (let i = 0; i < 12; i++) batch.add(trackedTask(log));

    await batch.run();
    expect(log.max).toBeLessThanOrEqual(3);
  });
});

describe('a batch observes only its own work', () => {
  test('run resolves when this batch is done, not when everything is', async () => {
    const group = createTransferGroup({ concurrency: 1 });
    const quick = group.openBatch();
    const slow = group.openBatch();

    let slowFinished = false;
    quick.add({ async run() { await tick(1); } });
    slow.add({ async run() { await tick(80); slowFinished = true; } });

    await quick.run();
    expect(slowFinished).toBe(false);
    await slow.run();
    expect(slowFinished).toBe(true);
  });

  test('an empty batch resolves immediately', async () => {
    const group = createTransferGroup({ concurrency: 2 });
    await expect(group.openBatch().run()).resolves.toBeUndefined();
  });

  test('stopping one batch leaves the others alone', async () => {
    const group = createTransferGroup({ concurrency: 1 });
    const doomed = group.openBatch();
    const survivor = group.openBatch();

    let doomedRan = 0;
    let survivorRan = 0;
    // Occupy the single slot so the rest are still queued when stop() lands.
    survivor.add({ async run() { await tick(20); survivorRan += 1; } });
    for (let i = 0; i < 5; i++) {
      doomed.add({ cancel() {}, async run() { doomedRan += 1; } });
    }
    for (let i = 0; i < 3; i++) {
      survivor.add({ async run() { survivorRan += 1; } });
    }

    doomed.stop();
    await survivor.run();

    expect(survivorRan).toBe(4);
  });
});

describe('failures', () => {
  test('the first error is reported, and the batch still completes', async () => {
    const group = createTransferGroup({ concurrency: 2 });
    const batch = group.openBatch();

    batch.add({ async run() { throw new Error('first'); } });
    batch.add({ async run() { throw new Error('second'); } });
    batch.add({ async run() { /* fine */ } });

    await batch.run();
    expect(batch.error?.message).toBe('first');
  });

  test('a batch with no failures reports none', async () => {
    const group = createTransferGroup({ concurrency: 2 });
    const batch = group.openBatch();
    batch.add({ async run() { /* fine */ } });
    await batch.run();
    expect(batch.error).toBeUndefined();
  });

  test('one batch failing does not fail another', async () => {
    const group = createTransferGroup({ concurrency: 2 });
    const failing = group.openBatch();
    const fine = group.openBatch();

    failing.add({ async run() { throw new Error('boom'); } });
    fine.add({ async run() { /* fine */ } });

    await Promise.all([failing.run(), fine.run()]);
    expect(failing.error).toBeTruthy();
    expect(fine.error).toBeUndefined();
  });
});

describe('lifecycle hooks', () => {
  test('start and done fire for every task', async () => {
    const started: number[] = [];
    const done: number[] = [];
    const group = createTransferGroup({
      concurrency: 2,
      onTaskStart: () => started.push(1),
      onTaskDone: () => done.push(1),
    });

    const batch = group.openBatch();
    for (let i = 0; i < 4; i++) batch.add({ async run() { await tick(1); } });
    await batch.run();

    expect(started).toHaveLength(4);
    expect(done).toHaveLength(4);
  });
});
