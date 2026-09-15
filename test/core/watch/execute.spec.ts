import { describe, test, expect, vi } from 'vitest';
import { executeOutcomes, type ExecuteDeps } from '../../../src/core/watch/execute';
import type { Outcome } from '../../../src/core/watch/pipeline';
import type { PathKey } from '../../../src/core/watch/pathkey';

/**
 * Carrying out a batch.
 *
 * This replaced a loop that awaited one path at a time. The ordering was
 * obvious then and is now a property that has to be asserted: directories
 * before what goes inside them, deletions from the leaves inward, and never
 * more in flight than the budget allows.
 *
 * Every test here drives a stand-in with controllable latency, so "did these
 * two overlap" is a fact rather than a race.
 */

const outcome = (action: Outcome['decision']['action'], path: string): Outcome =>
  ({ key: path as PathKey, path, decision: { action } }) as Outcome;

/** Records when each call starts and ends, so overlap can be measured. */
function recorder(latencyMs = 10) {
  const order: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const failures = new Set<string>();

  const run = async (label: string, path: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    order.push(`start ${label} ${path}`);
    await new Promise(resolve => setTimeout(resolve, latencyMs));
    order.push(`end ${label} ${path}`);
    inFlight -= 1;
    if (failures.has(path)) throw new Error(`failed on ${path}`);
  };

  return {
    order,
    failures,
    get peak() {
      return peak;
    },
    startIndex: (label: string, path: string) => order.indexOf(`start ${label} ${path}`),
    endIndex: (label: string, path: string) => order.indexOf(`end ${label} ${path}`),
    deps(over: Partial<ExecuteDeps> = {}): ExecuteDeps {
      return {
        concurrency: 4,
        ensureDirectory: path => run('dir', path),
        upload: path => run('upload', path),
        remove: path => run('remove', path),
        onApplied: () => undefined,
        onFailed: () => undefined,
        ...over,
      };
    },
  };
}

describe('directories', () => {
  test('a parent is finished before a child is started', async () => {
    // `mkdir` is not recursive, so /a must exist before /a/b is attempted.
    const r = recorder();
    await executeOutcomes(
      [outcome('ensure-directory', '/a/b/c'), outcome('ensure-directory', '/a'), outcome('ensure-directory', '/a/b')],
      r.deps()
    );

    expect(r.endIndex('dir', '/a')).toBeLessThan(r.startIndex('dir', '/a/b'));
    expect(r.endIndex('dir', '/a/b')).toBeLessThan(r.startIndex('dir', '/a/b/c'));
  });

  test('siblings at one depth run together', async () => {
    const r = recorder();
    await executeOutcomes(
      [outcome('ensure-directory', '/a/one'), outcome('ensure-directory', '/a/two')],
      r.deps()
    );

    expect(r.peak).toBe(2);
  });

  test('every directory is finished before any upload starts', async () => {
    const r = recorder();
    await executeOutcomes(
      [outcome('upload', '/a/file.txt'), outcome('ensure-directory', '/a')],
      r.deps()
    );

    expect(r.endIndex('dir', '/a')).toBeLessThan(r.startIndex('upload', '/a/file.txt'));
  });
});

describe('uploads', () => {
  test('run in parallel regardless of depth', async () => {
    // An upload creates its own chain of directories before writing, so it
    // waits on nothing -- not even on one higher up the tree.
    const r = recorder();
    const files = ['/a.txt', '/a/b.txt', '/a/b/c.txt', '/a/b/c/d.txt'];

    await executeOutcomes(files.map(p => outcome('upload', p)), r.deps({ concurrency: 4 }));

    expect(r.peak).toBe(4);
  });

  test('never more in flight than the budget', async () => {
    const r = recorder();
    const files = Array.from({ length: 20 }, (_, i) => `/file-${i}.txt`);

    await executeOutcomes(files.map(p => outcome('upload', p)), r.deps({ concurrency: 3 }));

    expect(r.peak).toBe(3);
  });

  test('a budget of one is still sequential', async () => {
    const r = recorder();
    await executeOutcomes(
      [outcome('upload', '/a.txt'), outcome('upload', '/b.txt')],
      r.deps({ concurrency: 1 })
    );

    expect(r.peak).toBe(1);
    expect(r.endIndex('upload', '/a.txt')).toBeLessThan(r.startIndex('upload', '/b.txt'));
  });
});

describe('deletions', () => {
  test('children are removed before the directory holding them', async () => {
    // Running both at once is a race: the child goes with the parent, and its
    // own removal then fails against a path that is no longer there.
    const r = recorder();
    await executeOutcomes(
      [outcome('delete-remote', '/a'), outcome('delete-remote', '/a/b'), outcome('delete-remote', '/a/b/c')],
      r.deps()
    );

    expect(r.endIndex('remove', '/a/b/c')).toBeLessThan(r.startIndex('remove', '/a/b'));
    expect(r.endIndex('remove', '/a/b')).toBeLessThan(r.startIndex('remove', '/a'));
  });

  test('and they happen after the uploads', async () => {
    const r = recorder();
    await executeOutcomes(
      [outcome('delete-remote', '/gone.txt'), outcome('upload', '/kept.txt')],
      r.deps()
    );

    expect(r.endIndex('upload', '/kept.txt')).toBeLessThan(r.startIndex('remove', '/gone.txt'));
  });
});

describe('when something fails', () => {
  test('the rest of the batch still runs', async () => {
    // One unreadable file aborting the remainder is how a pull leaves a server
    // half updated.
    const r = recorder();
    r.failures.add('/bad.txt');
    const failed: string[] = [];

    await executeOutcomes(
      ['/a.txt', '/bad.txt', '/c.txt'].map(p => outcome('upload', p)),
      r.deps({ concurrency: 1, onFailed: (_e, o) => failed.push(o.path) })
    );

    expect(failed).toEqual(['/bad.txt']);
    expect(r.endIndex('upload', '/c.txt')).toBeGreaterThan(-1);
  });

  test('a failed upload is not recorded as synced', async () => {
    const r = recorder();
    r.failures.add('/bad.txt');
    const applied: string[] = [];

    await executeOutcomes(
      ['/good.txt', '/bad.txt'].map(p => outcome('upload', p)),
      r.deps({ onApplied: o => void applied.push(o.path) })
    );

    expect(applied).toEqual(['/good.txt']);
  });

  test('a directory that already exists is not an error', async () => {
    // mkdir on an existing directory is the normal case, not a failure.
    const r = recorder();
    r.failures.add('/a');
    const onFailed = vi.fn();

    await executeOutcomes([outcome('ensure-directory', '/a')], r.deps({ onFailed }));

    expect(onFailed).not.toHaveBeenCalled();
  });

  test('a failure in one depth group does not stop the next', async () => {
    const r = recorder();
    r.failures.add('/a/b/c');

    await executeOutcomes(
      [outcome('delete-remote', '/a'), outcome('delete-remote', '/a/b/c')],
      r.deps()
    );

    expect(r.endIndex('remove', '/a')).toBeGreaterThan(-1);
  });
});

describe('bookkeeping', () => {
  test('every outcome is settled exactly once, successes and failures alike', async () => {
    const r = recorder();
    r.failures.add('/bad.txt');
    const settled: string[] = [];

    await executeOutcomes(
      [outcome('upload', '/a.txt'), outcome('upload', '/bad.txt'), outcome('delete-remote', '/x')],
      r.deps({ onSettled: o => settled.push(o.path) })
    );

    expect(settled.sort()).toEqual(['/a.txt', '/bad.txt', '/x']);
  });

  test('an empty batch does nothing and resolves', async () => {
    const r = recorder();
    await expect(executeOutcomes([], r.deps())).resolves.toBeUndefined();
    expect(r.order).toEqual([]);
  });
});
