import { describe, test, expect } from 'vitest';
import { processBatch, recordSynced, type PipelineDeps } from '../../../src/core/watch/pipeline';
import { createStateStore, recordFrom, type EntryFacts } from '../../../src/core/watch/state';
import { createExpectationRegistry } from '../../../src/core/watch/expectations';
import { createPathKeyer, type PathKey } from '../../../src/core/watch/pathkey';
import { createCounters } from '../../../src/core/watch/diagnostics';
import type { PendingEvent } from '../../../src/core/watch/batch';

const keyer = createPathKeyer('sensitive');

/** An in-memory disk. `readDigest` counts calls, so "was the file read?" is testable. */
function makeDisk(files: Record<string, { content: string; mtimeMs: number; type?: EntryFacts['type'] }>) {
  const reads: string[] = [];
  return {
    reads,
    async readFacts(path: string): Promise<EntryFacts> {
      const entry = files[path];
      if (!entry) return { type: 'missing', size: 0, mtimeMs: 0 };
      return {
        type: entry.type ?? 'file',
        size: entry.content.length,
        mtimeMs: entry.mtimeMs,
        ino: 1,
        dev: 1,
      };
    },
    async readDigest(path: string) {
      reads.push(path);
      const entry = files[path];
      if (!entry) throw new Error('missing');
      // Content is its own digest here; equality is all that matters.
      return { algorithm: 'sha256', hash: entry.content };
    },
  };
}

function setup(files: Parameters<typeof makeDisk>[0], overrides: Partial<PipelineDeps> = {}) {
  const disk = makeDisk(files);
  const store = createStateStore();
  const counters = createCounters();
  let clock = 1000;
  const deps: PipelineDeps = {
    store,
    expectations: createExpectationRegistry(keyer, () => clock),
    keyer,
    policy: { autoUpload: true, autoDelete: false, followSymlinks: false },
    isIgnored: () => false,
    readFacts: disk.readFacts,
    readDigest: disk.readDigest,
    now: () => clock,
    counters,
    ...overrides,
  };
  return { deps, disk, store, counters, tick: (ms = 1) => void (clock += ms) };
}

const event = (path: string, kind: PendingEvent['kind'] = 'change', count = 1): PendingEvent => ({
  key: keyer(path),
  path,
  kind,
  count,
});

describe('the cheap gate stops before the expensive one', () => {
  test('unchanged metadata never reads the file', () => {
    const { deps, disk, store } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 100 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    ));

    return processBatch([event('/w/a.txt')], deps).then(outcomes => {
      expect(outcomes).toHaveLength(0);
      expect(disk.reads).toEqual([]);
    });
  });

  test('a thousand re-emitted events read the disk zero times', async () => {
    // Whichever way whole-tree re-emission happens -- watcher restart, network
    // file system, a burst before a file is closed -- it costs nothing.
    const { deps, disk, store } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 100 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    ));

    for (let i = 0; i < 1000; i++) await processBatch([event('/w/a.txt')], deps);
    expect(disk.reads).toEqual([]);
  });
});

describe('content gate', () => {
  test('mtime moved but content identical: nothing is sent, state is refreshed', async () => {
    const { deps, disk, store, counters } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 200 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    ));

    const outcomes = await processBatch([event('/w/a.txt')], deps);

    expect(outcomes).toHaveLength(0);
    expect(disk.reads).toEqual(['/w/a.txt']);
    expect(counters.recordedOnly).toBe(1);
    // Refreshed, so the next event is settled cheaply.
    expect(store.get(keyer('/w/a.txt'))?.mtimeMs).toBe(200);
  });

  test('a second event after a record-only pass reads nothing', async () => {
    const { deps, disk, store } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 200 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    ));

    await processBatch([event('/w/a.txt')], deps);
    await processBatch([event('/w/a.txt')], deps);

    expect(disk.reads).toEqual(['/w/a.txt']);
  });

  test('changed content is uploaded', async () => {
    const { deps, store } = setup({ '/w/a.txt': { content: 'goodbye', mtimeMs: 200 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    ));

    const outcomes = await processBatch([event('/w/a.txt')], deps);
    expect(outcomes.map(o => o.decision.action)).toEqual(['upload']);
  });

  test('an unreadable file is uploaded rather than guessed at', async () => {
    // A spurious upload is recoverable; a silently skipped one leaves the
    // server wrong with no signal.
    const { deps, store } = setup({ '/w/a.txt': { content: 'x', mtimeMs: 200 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    ));
    deps.readDigest = async () => {
      throw new Error('EACCES');
    };

    const outcomes = await processBatch([event('/w/a.txt')], deps);
    expect(outcomes.map(o => o.decision.action)).toEqual(['upload']);
  });
});

describe('scenario 6 and 7: git checkout', () => {
  test('a mass rewrite restoring identical content uploads nothing', async () => {
    const files: Record<string, { content: string; mtimeMs: number }> = {};
    for (let i = 0; i < 300; i++) files[`/w/f${i}.ts`] = { content: `body-${i}`, mtimeMs: 500 };

    const { deps, store, counters } = setup(files);
    for (let i = 0; i < 300; i++) {
      store.set(keyer(`/w/f${i}.ts`), recordFrom(
        { type: 'file', size: `body-${i}`.length, mtimeMs: 100, ino: 1, dev: 1 },
        { algorithm: 'sha256', hash: `body-${i}` },
        0
      ));
    }

    const outcomes = await processBatch(Object.keys(files).map(p => event(p)), deps);

    expect(outcomes).toHaveLength(0);
    expect(counters.recordedOnly).toBe(300);
  });

  test('only the files whose bytes actually differ are uploaded', async () => {
    const files: Record<string, { content: string; mtimeMs: number }> = {};
    for (let i = 0; i < 100; i++) files[`/w/f${i}.ts`] = { content: `body-${i}`, mtimeMs: 500 };
    files['/w/f7.ts'] = { content: 'changed', mtimeMs: 500 };
    files['/w/f42.ts'] = { content: 'also changed', mtimeMs: 500 };

    const { deps, store } = setup(files);
    for (let i = 0; i < 100; i++) {
      store.set(keyer(`/w/f${i}.ts`), recordFrom(
        { type: 'file', size: `body-${i}`.length, mtimeMs: 100, ino: 1, dev: 1 },
        { algorithm: 'sha256', hash: `body-${i}` },
        0
      ));
    }

    const outcomes = await processBatch(Object.keys(files).map(p => event(p)), deps);

    expect(outcomes.map(o => o.path).sort()).toEqual(['/w/f42.ts', '/w/f7.ts']);
  });
});

describe('scenario 4: directories', () => {
  test('a change on a directory produces no outcome at all', async () => {
    const { deps } = setup({ '/w/src': { content: '', mtimeMs: 100, type: 'directory' } });
    const outcomes = await processBatch([event('/w/src', 'change')], deps);
    expect(outcomes).toHaveLength(0);
  });

  test('a new directory is ensured, not walked', async () => {
    const { deps } = setup({ '/w/src': { content: '', mtimeMs: 100, type: 'directory' } });
    const outcomes = await processBatch([event('/w/src', 'create')], deps);
    expect(outcomes.map(o => o.decision.action)).toEqual(['ensure-directory']);
  });
});

describe('scenario 8: our own writes', () => {
  test('a download we just made does not bounce back', async () => {
    const { deps, store } = setup({ '/w/a.txt': { content: 'from-server', mtimeMs: 900 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'old' },
      0
    ));

    deps.expectations.expect('/w/a.txt', { size: 'from-server'.length, mtimeMs: 900 });

    const outcomes = await processBatch([event('/w/a.txt')], deps);
    expect(outcomes).toHaveLength(0);
  });

  test('a user edit on top of our download is still uploaded', async () => {
    const { deps, store } = setup({ '/w/a.txt': { content: 'edited-by-user', mtimeMs: 901 } });
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'old' },
      0
    ));

    // We expected the download's facts, but the disk shows something else.
    deps.expectations.expect('/w/a.txt', { size: 11, mtimeMs: 900 });

    const outcomes = await processBatch([event('/w/a.txt')], deps);
    expect(outcomes.map(o => o.decision.action)).toEqual(['upload']);
  });
});

describe('dry run', () => {
  test('reports what would happen without touching the store', async () => {
    const { deps, store } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 200 } });
    const before = recordFrom(
      { type: 'file', size: 5, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'hello' },
      0
    );
    store.set(keyer('/w/a.txt'), before);

    await processBatch([event('/w/a.txt')], deps, /* apply */ false);

    expect(store.get(keyer('/w/a.txt'))?.mtimeMs).toBe(100);
  });
});

describe('ignore rules', () => {
  test('an ignored path is never read', async () => {
    const { deps, disk } = setup({ '/w/.git/index': { content: 'x', mtimeMs: 1 } }, {
      isIgnored: path => path.includes('/.git/'),
    });

    const outcomes = await processBatch([event('/w/.git/index')], deps);
    expect(outcomes).toHaveLength(0);
    expect(disk.reads).toEqual([]);
  });
});

describe('recordSynced', () => {
  test('records the file after a successful transfer', async () => {
    const { deps, store } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 300 } });
    await recordSynced(keyer('/w/a.txt') as PathKey, '/w/a.txt', deps);
    expect(store.get(keyer('/w/a.txt'))).toMatchObject({ mtimeMs: 300, hash: 'hello' });
  });

  test('records nothing when the file cannot be read, so the next event retries', async () => {
    const { deps, store } = setup({ '/w/a.txt': { content: 'hello', mtimeMs: 300 } });
    deps.readDigest = async () => {
      throw new Error('EACCES');
    };
    await recordSynced(keyer('/w/a.txt') as PathKey, '/w/a.txt', deps);
    expect(store.get(keyer('/w/a.txt'))).toBeUndefined();
  });
});

describe('counters', () => {
  test('tally decisions by outcome and skip reason', async () => {
    const { deps, store, counters } = setup({
      '/w/same.txt': { content: 'a', mtimeMs: 100 },
      '/w/changed.txt': { content: 'new', mtimeMs: 200 },
      '/w/dir': { content: '', mtimeMs: 100, type: 'directory' },
    });
    store.set(keyer('/w/same.txt'), recordFrom(
      { type: 'file', size: 1, mtimeMs: 100, ino: 1, dev: 1 },
      { algorithm: 'sha256', hash: 'a' },
      0
    ));

    await processBatch(
      [event('/w/same.txt'), event('/w/changed.txt'), event('/w/dir', 'change')],
      deps
    );

    expect(counters.uploaded).toBe(1);
    expect(counters.skipped['unchanged-metadata']).toBe(1);
    expect(counters.skipped['directory-change']).toBe(1);
  });
});

describe('forget', () => {
  test('drops a record once the remote file is gone', async () => {
    const { forget } = await import('../../../src/core/watch/pipeline');
    const { store } = setup({});
    store.set(keyer('/w/a.txt'), recordFrom(
      { type: 'file', size: 1, mtimeMs: 1 },
      { algorithm: 'sha256', hash: 'x' },
      0
    ));
    forget(keyer('/w/a.txt'), store);
    expect(store.get(keyer('/w/a.txt'))).toBeUndefined();
  });
});
