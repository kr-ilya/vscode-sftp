import { describe, test, expect } from 'vitest';
import {
  createStateStore,
  serializeState,
  deserializeState,
  factsMatch,
  recordFrom,
  STATE_FORMAT_VERSION,
  type StateRecord,
  type EntryFacts,
} from '../../../src/core/watch/state';
import type { PathKey } from '../../../src/core/watch/pathkey';

const key = (s: string) => s as PathKey;

/** The watched root these tests store paths relative to. */
const BASE = '/w/project';

function record(over: Partial<StateRecord> = {}): StateRecord {
  return { size: 10, mtimeMs: 100, ino: 1, dev: 2, algorithm: 'sha256', hash: 'h', at: 50, ...over };
}

function facts(over: Partial<EntryFacts> = {}): EntryFacts {
  return { type: 'file', size: 10, mtimeMs: 100, ino: 1, dev: 2, ...over };
}

describe('scenario 11: state survives a window reload', () => {
  test('a round trip preserves every record', () => {
    const store = createStateStore();
    store.set(key(`${BASE}/b.txt`), record({ hash: 'one' }));
    store.set(key(`${BASE}/src/c.txt`), record({ hash: 'two', size: 20 }));

    const { store: restored, accepted } = deserializeState(
      'scope-1',
      JSON.parse(JSON.stringify(serializeState('scope-1', store, BASE))),
      BASE
    );

    expect(accepted).toBe(true);
    expect(restored.size).toBe(2);
    expect(restored.get(key(`${BASE}/b.txt`))?.hash).toBe('one');
    expect(restored.get(key(`${BASE}/src/c.txt`))?.size).toBe(20);
  });
});

describe('refusing to guess', () => {
  // Every rejection below yields an empty store, which the controller treats as
  // "seed from disk, upload nothing" -- never as "upload everything".
  test.each([
    [
      'a different format version',
      { version: STATE_FORMAT_VERSION + 1, scope: 's', base: BASE, entries: {} },
    ],
    [
      'a different scope',
      { version: STATE_FORMAT_VERSION, scope: 'other', base: BASE, entries: {} },
    ],
    // Keys are relative now, so a file written for another root would name
    // files that do not exist here -- and the gate would read every real one as
    // new.
    [
      // Sound in every other respect, so the base is the only thing that can
      // reject it -- otherwise the missing algorithm would, and this row would
      // pass whether the base were checked or not.
      'a different base',
      {
        version: STATE_FORMAT_VERSION,
        scope: 's',
        base: '/w/other',
        algorithm: 'sha256',
        entries: { 'a.txt': { s: 1, m: 2, h: 'h', t: 3 } },
      },
    ],
    ['no entries', { version: STATE_FORMAT_VERSION, scope: 's', base: BASE }],
    ['not an object', 'nonsense'],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    const { store, accepted, reason } = deserializeState('s', raw, BASE);
    expect(accepted).toBe(false);
    expect(reason).toBeTruthy();
    expect(store.size).toBe(0);
  });

  test('drops malformed entries but keeps the sound ones', () => {
    const { store, accepted } = deserializeState(
      's',
      {
        version: STATE_FORMAT_VERSION,
        scope: 's',
        base: BASE,
        algorithm: 'sha256',
        entries: {
          good: { s: 10, m: 100, i: 1, d: 2, h: 'h', t: 50 },
          bad: { s: 'huge' },
          alsoBad: null,
        },
      },
      BASE
    );
    expect(accepted).toBe(true);
    expect(store.size).toBe(1);
    expect(store.get(key(`${BASE}/good`))).toBeTruthy();
  });

  test('rejects a file with no algorithm, rather than assuming one', () => {
    // The algorithm is written once for the whole file now. A file without it
    // is from some other format; guessing sha256 would mean comparing hashes
    // that were never comparable.
    const { accepted, store } = deserializeState(
      's',
      {
        version: STATE_FORMAT_VERSION,
        scope: 's',
        base: BASE,
        entries: { a: { s: 1, m: 2, h: 'h', t: 3 } },
      },
      BASE
    );
    expect(accepted).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe('what actually goes on disk', () => {
  // The file holds one record per file in the workspace and is rewritten whole
  // whenever anything changes, so its shape is a cost paid repeatedly. These
  // pin it: long names here would not fail any behavioural test.
  const stored = () => {
    const store = createStateStore();
    store.set(key(`${BASE}/b.txt`), record());
    return serializeState('scope-1', store, BASE).entries['b.txt'] as unknown as Record<
      string,
      unknown
    >;
  };

  test('every field name is one character', () => {
    expect(Object.keys(stored()).every(name => name.length === 1)).toBe(true);
  });

  test('the algorithm is written once for the file, not per record', () => {
    const store = createStateStore();
    store.set(key(`${BASE}/b.txt`), record());
    store.set(key(`${BASE}/c.txt`), record());
    const serialized = serializeState('scope-1', store, BASE);

    expect(serialized.algorithm).toBe('sha256');
    expect(JSON.stringify(serialized.entries)).not.toContain('sha256');
  });

  test('so is the watched root, and keys are written relative to it', () => {
    // The same reasoning as the algorithm: one value repeated in every key, in
    // a file rewritten whole on every change. On a 10,000-file tree the prefix
    // alone is 12% of it.
    const store = createStateStore();
    store.set(key(`${BASE}/src/deep/file.ts`), record());
    const serialized = serializeState('scope-1', store, BASE);

    expect(serialized.base).toBe(BASE);
    expect(Object.keys(serialized.entries)).toEqual(['src/deep/file.ts']);
    expect(JSON.stringify(serialized.entries)).not.toContain(BASE);
  });

  test('a path outside the root is written whole, and comes back whole', () => {
    // It cannot arise today -- records are only made for files under the
    // watched root -- but rebasing one onto the root would silently rename it.
    const store = createStateStore();
    store.set(key('/elsewhere/file.ts'), record({ hash: 'outside' }));
    const serialized = serializeState('scope-1', store, BASE);

    expect(Object.keys(serialized.entries)).toEqual(['/elsewhere/file.ts']);

    const { store: restored } = deserializeState(
      'scope-1',
      JSON.parse(JSON.stringify(serialized)),
      BASE
    );
    expect(restored.get(key('/elsewhere/file.ts'))?.hash).toBe('outside');
  });

  test('a Windows root round trips, folded as the keyer leaves it', () => {
    const base = 'd:/code/p/project';
    const store = createStateStore();
    store.set(key(`${base}/src/app.ts`), record({ hash: 'win' }));
    const serialized = serializeState('scope-1', store, base);

    expect(Object.keys(serialized.entries)).toEqual(['src/app.ts']);

    const { store: restored } = deserializeState(
      'scope-1',
      JSON.parse(JSON.stringify(serialized)),
      base
    );
    expect(restored.get(key(`${base}/src/app.ts`))?.hash).toBe('win');
  });

  test('a root written with a trailing slash does not double it', () => {
    const store = createStateStore();
    store.set(key(`${BASE}/b.txt`), record());

    expect(Object.keys(serializeState('scope-1', store, `${BASE}/`).entries)).toEqual(['b.txt']);
  });

  test('a record round trips through the short form unchanged', () => {
    const store = createStateStore();
    const original = record({ hash: 'abc', size: 42, mtimeMs: 1744187977276.0037 });
    store.set(key(`${BASE}/b.txt`), original);

    const { store: restored } = deserializeState(
      'scope-1',
      JSON.parse(JSON.stringify(serializeState('scope-1', store, BASE))),
      BASE
    );

    expect(restored.get(key(`${BASE}/b.txt`))).toEqual(original);
  });
});

describe('factsMatch', () => {
  test('matches on identical facts', () => {
    expect(factsMatch(facts(), record())).toBe(true);
  });

  test.each([
    ['size', { size: 11 }],
    ['mtime', { mtimeMs: 101 }],
    ['inode', { ino: 9 }],
    ['device', { dev: 9 }],
  ])('a differing %s is a mismatch', (_label, over) => {
    expect(factsMatch(facts(over), record())).toBe(false);
  });

  test('identity absent on either side is not a mismatch', () => {
    // A file system that does not report a usable inode must not force every
    // file to be hashed on every event.
    expect(factsMatch(facts({ ino: undefined }), record())).toBe(true);
    expect(factsMatch(facts(), record({ ino: undefined }))).toBe(true);
  });

  test('millisecond precision is kept', () => {
    // Comparing at whole seconds -- as one fork does -- makes an edit made
    // within the same second indistinguishable from no edit at all.
    expect(factsMatch(facts({ mtimeMs: 100.5 }), record({ mtimeMs: 100 }))).toBe(false);
  });
});

describe('recordFrom', () => {
  test('carries the facts and the digest', () => {
    const r = recordFrom(facts({ size: 42 }), { algorithm: 'sha256', hash: 'abc' }, 1234);
    expect(r).toMatchObject({ size: 42, algorithm: 'sha256', hash: 'abc', at: 1234 });
  });
});

describe('store operations', () => {
  test('delete removes an entry and keys reflects it', () => {
    const store = createStateStore();
    store.set(key('/a'), record());
    store.set(key('/b'), record());
    store.delete(key('/a'));
    expect([...store.keys()]).toEqual(['/b']);
    expect(store.size).toBe(1);
  });
});
