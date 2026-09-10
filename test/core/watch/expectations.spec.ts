import { describe, test, expect } from 'vitest';
import { createExpectationRegistry } from '../../../src/core/watch/expectations';
import { createPathKeyer } from '../../../src/core/watch/pathkey';
import type { EntryFacts } from '../../../src/core/watch/state';

const keyer = createPathKeyer('sensitive');

function makeRegistry(ttlMs = 30_000) {
  let now = 1000;
  const registry = createExpectationRegistry(keyer, () => now, ttlMs);
  return { registry, advance: (ms: number) => void (now += ms), at: () => now };
}

function facts(over: Partial<EntryFacts> = {}): EntryFacts {
  return { type: 'file', size: 200, mtimeMs: 5000, ...over };
}

describe('scenario 8: suppressing our own writes', () => {
  test('an event matching the expected facts is suppressed', () => {
    const { registry } = makeRegistry();
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });

    expect(registry.consume('/w/a.txt', facts())).toEqual({
      matched: true,
      reason: 'facts-match',
    });
  });

  test('the decision is by facts, not by clock', () => {
    // The point of the design: both forks suppress by timeout, which drops a
    // real edit made inside the window and lets a slow write through outside it.
    const { registry, advance } = makeRegistry();
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });

    // Far into the window, but the file is not what we wrote: not ours.
    advance(10);
    expect(registry.consume('/w/a.txt', facts({ size: 999 })).matched).toBe(false);
  });

  test('a user edit landing on top of our download is not suppressed', () => {
    const { registry } = makeRegistry();
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });

    expect(registry.consume('/w/a.txt', facts({ mtimeMs: 5001 }))).toEqual({
      matched: false,
      reason: 'facts-differ',
    });
    // And the stale claim is gone, so the next event is judged on its own.
    expect(registry.consume('/w/a.txt', facts()).reason).toBe('no-expectation');
  });

  test('one write suppresses several events', () => {
    // A single write is visible as repeated events on Linux, before the file is
    // even closed. Consuming on first use would let the rest through.
    const { registry } = makeRegistry();
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });

    for (let i = 0; i < 5; i++) {
      expect(registry.consume('/w/a.txt', facts()).matched).toBe(true);
    }
  });

  test('paths are compared by normalised key', () => {
    const { registry } = makeRegistry();
    registry.expect('/w//sub/./a.txt', { size: 200, mtimeMs: 5000 });
    expect(registry.consume('/w/sub/a.txt', facts()).matched).toBe(true);
  });

  test('an unrelated path is unaffected', () => {
    const { registry } = makeRegistry();
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });
    expect(registry.consume('/w/b.txt', facts()).reason).toBe('no-expectation');
  });
});

describe('settle and abandon', () => {
  test('settle updates the expectation to what was actually written', () => {
    const { registry } = makeRegistry();
    const handle = registry.expect('/w/a.txt', { size: 0, mtimeMs: 0 });

    // The write turned out different from the estimate.
    handle.settle({ size: 200, mtimeMs: 5000 });

    expect(registry.consume('/w/a.txt', facts()).matched).toBe(true);
  });

  test('abandon withdraws a write that never happened', () => {
    const { registry } = makeRegistry();
    const handle = registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });
    handle.abandon();
    expect(registry.consume('/w/a.txt', facts()).reason).toBe('no-expectation');
  });

  test('a superseded handle does not clobber the newer expectation', () => {
    const { registry } = makeRegistry();
    const first = registry.expect('/w/a.txt', { size: 1, mtimeMs: 1 });
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });

    first.settle({ size: 1, mtimeMs: 1 });
    first.abandon();

    expect(registry.consume('/w/a.txt', facts()).matched).toBe(true);
  });
});

describe('the TTL is garbage collection, not a decision', () => {
  test('an unclaimed expectation is eventually swept', () => {
    const { registry, advance } = makeRegistry(1000);
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });
    expect(registry.size).toBe(1);

    advance(1001);
    expect(registry.consume('/w/a.txt', facts()).reason).toBe('no-expectation');
    expect(registry.size).toBe(0);
  });

  test('within the window, expiry still never decides on its own', () => {
    // Facts govern. Time only bounds how long we remember.
    const { registry, advance } = makeRegistry(1000);
    registry.expect('/w/a.txt', { size: 200, mtimeMs: 5000 });
    advance(999);
    expect(registry.consume('/w/a.txt', facts({ size: 3 })).matched).toBe(false);
  });
});
