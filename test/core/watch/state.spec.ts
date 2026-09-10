import { describe, test, expect } from 'vitest';
import {
  createStateStore,
  serializeState,
  deserializeState,
  factsMatchRecord,
  recordFrom,
  STATE_FORMAT_VERSION,
  type StateRecord,
  type EntryFacts,
} from '../../../src/core/watch/state';
import type { PathKey } from '../../../src/core/watch/pathkey';

const key = (s: string) => s as PathKey;

function record(over: Partial<StateRecord> = {}): StateRecord {
  return { size: 10, mtimeMs: 100, ino: 1, dev: 2, algorithm: 'sha256', hash: 'h', at: 50, ...over };
}

function facts(over: Partial<EntryFacts> = {}): EntryFacts {
  return { type: 'file', size: 10, mtimeMs: 100, ino: 1, dev: 2, ...over };
}

describe('scenario 11: state survives a window reload', () => {
  test('a round trip preserves every record', () => {
    const store = createStateStore();
    store.set(key('/a/b.txt'), record({ hash: 'one' }));
    store.set(key('/a/c.txt'), record({ hash: 'two', size: 20 }));

    const { store: restored, accepted } = deserializeState(
      'scope-1',
      JSON.parse(JSON.stringify(serializeState('scope-1', store)))
    );

    expect(accepted).toBe(true);
    expect(restored.size).toBe(2);
    expect(restored.get(key('/a/b.txt'))?.hash).toBe('one');
    expect(restored.get(key('/a/c.txt'))?.size).toBe(20);
  });
});

describe('refusing to guess', () => {
  // Every rejection below yields an empty store, which the controller treats as
  // "seed from disk, upload nothing" -- never as "upload everything".
  test.each([
    ['a different format version', { version: STATE_FORMAT_VERSION + 1, scope: 's', entries: {} }],
    ['a different scope', { version: STATE_FORMAT_VERSION, scope: 'other', entries: {} }],
    ['no entries', { version: STATE_FORMAT_VERSION, scope: 's' }],
    ['not an object', 'nonsense'],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    const { store, accepted, reason } = deserializeState('s', raw);
    expect(accepted).toBe(false);
    expect(reason).toBeTruthy();
    expect(store.size).toBe(0);
  });

  test('drops malformed entries but keeps the sound ones', () => {
    const { store, accepted } = deserializeState('s', {
      version: STATE_FORMAT_VERSION,
      scope: 's',
      entries: { '/good': record(), '/bad': { size: 'huge' }, '/alsoBad': null },
    });
    expect(accepted).toBe(true);
    expect(store.size).toBe(1);
    expect(store.get(key('/good'))).toBeTruthy();
  });
});

describe('factsMatchRecord', () => {
  test('matches on identical facts', () => {
    expect(factsMatchRecord(facts(), record())).toBe(true);
  });

  test.each([
    ['size', { size: 11 }],
    ['mtime', { mtimeMs: 101 }],
    ['inode', { ino: 9 }],
    ['device', { dev: 9 }],
  ])('a differing %s is a mismatch', (_label, over) => {
    expect(factsMatchRecord(facts(over), record())).toBe(false);
  });

  test('identity absent on either side is not a mismatch', () => {
    // A file system that does not report a usable inode must not force every
    // file to be hashed on every event.
    expect(factsMatchRecord(facts({ ino: undefined }), record())).toBe(true);
    expect(factsMatchRecord(facts(), record({ ino: undefined }))).toBe(true);
  });

  test('millisecond precision is kept', () => {
    // Comparing at whole seconds -- as one fork does -- makes an edit made
    // within the same second indistinguishable from no edit at all.
    expect(factsMatchRecord(facts({ mtimeMs: 100.5 }), record({ mtimeMs: 100 }))).toBe(false);
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
