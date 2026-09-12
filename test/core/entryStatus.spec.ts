import { describe, test, expect } from 'vitest';
import { compareEntry } from '../../src/core/explorer/entryStatus';
import type { EntryFacts, StateRecord } from '../../src/core/watch/state';

/**
 * What the remote explorer is allowed to claim about a file.
 *
 * The trap here is the temptation to report "in sync" whenever nothing
 * contradicts it. Sizes matching is not the same as contents matching, and a
 * badge that says a file is up to date when nobody checked is worse than no
 * badge -- it is the one a person would act on.
 */

const local = (over: Partial<EntryFacts> = {}): EntryFacts => ({
  type: 'file',
  size: 100,
  mtimeMs: 1_700_000_000_000,
  ...over,
});

const remote = (over: Partial<{ size: number; mtime: number; type: string }> = {}) =>
  ({ type: 'file', size: 100, mtime: 1_700_000_000_000, ...over }) as never;

const record = (over: Partial<StateRecord> = {}): StateRecord => ({
  size: 100,
  mtimeMs: 1_700_000_000_000,
  algorithm: 'sha256',
  hash: 'abc',
  at: 0,
  ...over,
});

describe('what can be settled from the facts alone', () => {
  test('no local copy is reported as remote only', () => {
    expect(compareEntry({ remote: remote(), local: local({ type: 'missing' }) }).status).toBe(
      'remote-only'
    );
  });

  test('different sizes are a definite difference', () => {
    expect(compareEntry({ remote: remote({ size: 200 }), local: local() }).status).toBe('different');
  });

  test('the same size and the same second is a match', () => {
    expect(compareEntry({ remote: remote(), local: local() }).status).toBe('same');
  });

  test('times are compared in whole seconds', () => {
    // SFTP reports seconds and local file systems report milliseconds; any
    // finer and every single file would be marked different.
    const verdict = compareEntry({
      remote: remote({ mtime: 1_700_000_000_000 }),
      local: local({ mtimeMs: 1_700_000_000_999 }),
    });
    expect(verdict.status).toBe('same');
  });

  test('a directory is not compared', () => {
    expect(compareEntry({ remote: remote({ type: 'directory' }), local: local() }).status).toBe(
      'not-applicable'
    );
  });

  test('a local entry that is not a file is not compared either', () => {
    expect(compareEntry({ remote: remote(), local: local({ type: 'symlink' }) }).status).toBe(
      'not-applicable'
    );
  });
});

describe('what the facts cannot settle', () => {
  test('matching sizes with different times is reported as unverified, not as a match', () => {
    // Claiming "up to date" here would be a guess, and it is exactly the guess
    // somebody would deploy on.
    const verdict = compareEntry({
      remote: remote({ mtime: 1_700_000_500_000 }),
      local: local(),
    });

    expect(verdict.status).toBe('unverified');
    expect(verdict.reason).toContain('not compared');
  });

  test('the change tracker settles it when the local file has not moved', () => {
    const verdict = compareEntry({
      remote: remote({ mtime: 1_700_000_500_000 }),
      local: local(),
      record: record(),
    });

    expect(verdict.status).toBe('same');
    expect(verdict.reason).toContain('last transfer');
  });

  test('and settles it the other way when the local file has', () => {
    const verdict = compareEntry({
      remote: remote({ mtime: 1_700_000_500_000 }),
      local: local({ mtimeMs: 1_700_000_900_000 }),
      record: record(),
    });

    expect(verdict.status).toBe('different');
  });

  test('a record for a different file does not make it a match', () => {
    // Same size, different identity: an editor's atomic save replaces the file
    // rather than writing through it.
    const verdict = compareEntry({
      remote: remote({ mtime: 1_700_000_500_000 }),
      local: local({ ino: 42, dev: 1 }),
      record: record({ ino: 7, dev: 1 }),
    });

    expect(verdict.status).toBe('different');
  });
});

describe('every verdict explains itself', () => {
  test.each([
    ['remote only', { remote: remote(), local: local({ type: 'missing' }) }],
    ['different sizes', { remote: remote({ size: 1 }), local: local() }],
    ['a match', { remote: remote(), local: local() }],
    ['unverified', { remote: remote({ mtime: 0 }), local: local() }],
    ['not applicable', { remote: remote({ type: 'directory' }), local: local() }],
  ])('%s carries a reason', (_label, input) => {
    expect(compareEntry(input).reason.length).toBeGreaterThan(0);
  });
});
