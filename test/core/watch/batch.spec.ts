import { describe, test, expect } from 'vitest';
import { createEventBatcher, type PendingEvent } from '../../../src/core/watch/batch';
import { createPathKeyer } from '../../../src/core/watch/pathkey';
import { makeClock } from '../../helpers/clock';

function setup(caseSensitivity: 'sensitive' | 'insensitive' = 'sensitive') {
  const { clock, advance } = makeClock();
  const batches: PendingEvent[][] = [];
  const batcher = createEventBatcher({
    keyer: createPathKeyer(caseSensitivity),
    onBatch: events => void batches.push(events),
    clock,
    windowMs: 400,
    maxWaitMs: 3000,
  });
  return { batcher, batches, advance };
}

describe('scenario 9: many events for one path collapse to one entry', () => {
  test('five events, one batch entry', () => {
    // Upstream used `new Set<vscode.Uri>()`. A Set compares by identity and
    // VS Code hands out a fresh Uri per event, so nothing was deduplicated:
    // five events meant five concurrent uploads to the same remote path.
    const { batcher, batches, advance } = setup();
    for (let i = 0; i < 5; i++) batcher.add('/w/a.txt', 'change');
    advance(400);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0]).toMatchObject({ path: '/w/a.txt', kind: 'change', count: 5 });
  });

  test('different paths stay separate', () => {
    const { batcher, batches, advance } = setup();
    batcher.add('/w/a.txt', 'change');
    batcher.add('/w/b.txt', 'change');
    advance(400);
    expect(batches[0]).toHaveLength(2);
  });

  test('spellings that differ only in case collapse on an insensitive policy', () => {
    const { batcher, batches, advance } = setup('insensitive');
    batcher.add('C:\\W\\A.txt', 'change');
    batcher.add('c:/w/a.txt', 'change');
    advance(400);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].count).toBe(2);
  });
});

describe('timing', () => {
  test('nothing is emitted on the leading edge', () => {
    // A leading edge fires on the first event of a storm, which is exactly when
    // waiting is the point. Upstream used leading: true with a 550ms window.
    const { batcher, batches, advance } = setup();
    batcher.add('/w/a.txt', 'change');
    advance(399);
    expect(batches).toHaveLength(0);
    advance(1);
    expect(batches).toHaveLength(1);
  });

  test('a continuing storm is bounded by maxWait', () => {
    const { batcher, batches, advance } = setup();
    // An event every 200ms would defer forever on the window alone.
    for (let i = 0; i < 40; i++) {
      batcher.add('/w/a.txt', 'change');
      advance(200);
    }
    expect(batches.length).toBeGreaterThan(0);
  });

  test('separate bursts produce separate batches', () => {
    const { batcher, batches, advance } = setup();
    batcher.add('/w/a.txt', 'change');
    advance(400);
    batcher.add('/w/a.txt', 'change');
    advance(400);
    expect(batches).toHaveLength(2);
  });
});

describe('kind resolution within a window', () => {
  test('create then delete settles on delete', () => {
    const { batcher, batches, advance } = setup();
    batcher.add('/w/a.txt', 'create');
    batcher.add('/w/a.txt', 'delete');
    advance(400);
    expect(batches[0][0].kind).toBe('delete');
  });

  test('delete then create settles on create', () => {
    // What an atomic save by an external tool looks like.
    const { batcher, batches, advance } = setup();
    batcher.add('/w/a.txt', 'delete');
    batcher.add('/w/a.txt', 'create');
    advance(400);
    expect(batches[0][0].kind).toBe('create');
  });
});

describe('flush and cancel', () => {
  test('flush emits immediately', () => {
    const { batcher, batches } = setup();
    batcher.add('/w/a.txt', 'change');
    batcher.flush();
    expect(batches).toHaveLength(1);
  });

  test('flush with nothing pending emits nothing', () => {
    const { batcher, batches } = setup();
    batcher.flush();
    expect(batches).toHaveLength(0);
  });

  test('cancel discards pending events', () => {
    const { batcher, batches, advance } = setup();
    batcher.add('/w/a.txt', 'change');
    batcher.cancel();
    advance(1000);
    expect(batches).toHaveLength(0);
  });

  test('pendingCount reflects distinct paths', () => {
    const { batcher } = setup();
    batcher.add('/w/a.txt', 'change');
    batcher.add('/w/a.txt', 'change');
    batcher.add('/w/b.txt', 'change');
    expect(batcher.pendingCount).toBe(2);
  });
});
