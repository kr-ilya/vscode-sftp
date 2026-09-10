import { describe, test, expect, beforeEach, vi } from 'vitest';
import { vol } from 'memfs';
import { readFacts, readDigest, readFileState } from '../../../src/core/watch/facts';

vi.mock('node:fs');

beforeEach(() => {
  vol.reset();
});

describe('readFacts', () => {
  test('reports a regular file with its size and mtime', async () => {
    vol.fromJSON({ '/w/a.txt': 'hello' }, '/');
    const facts = await readFacts('/w/a.txt');
    expect(facts.type).toBe('file');
    expect(facts.size).toBe(5);
    expect(facts.mtimeMs).toBeGreaterThan(0);
  });

  test('reports a directory as a directory', async () => {
    vol.fromJSON({ '/w/sub/a.txt': 'x' }, '/');
    expect((await readFacts('/w/sub')).type).toBe('directory');
  });

  test('a missing path is "missing" rather than an error', async () => {
    // Callers must be able to decide about a deletion, which means the absence
    // of a file is an answer, not a failure.
    expect(await readFacts('/w/gone.txt')).toEqual({ type: 'missing', size: 0, mtimeMs: 0 });
  });

  test('a symlink is reported as a symlink, not as its target', async () => {
    // lstat, not stat: resolving it would upload a file living outside the
    // synced tree without saying so.
    vol.fromJSON({ '/w/real.txt': 'hello' }, '/');
    vol.symlinkSync('/w/real.txt', '/w/link.txt');
    expect((await readFacts('/w/link.txt')).type).toBe('symlink');
  });
});

describe('readDigest', () => {
  test('hashes the content', async () => {
    vol.fromJSON({ '/w/a.txt': 'hello' }, '/');
    const digest = await readDigest('/w/a.txt');
    expect(digest.algorithm).toBe('sha256');
    // sha256("hello")
    expect(digest.hash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  test('identical content in different files hashes the same', async () => {
    vol.fromJSON({ '/w/a.txt': 'same', '/w/b.txt': 'same' }, '/');
    expect((await readDigest('/w/a.txt')).hash).toBe((await readDigest('/w/b.txt')).hash);
  });

  test('a one-byte difference changes the hash', async () => {
    vol.fromJSON({ '/w/a.txt': 'abc', '/w/b.txt': 'abd' }, '/');
    expect((await readDigest('/w/a.txt')).hash).not.toBe((await readDigest('/w/b.txt')).hash);
  });

  test('rejects for a file that is not there', async () => {
    await expect(readDigest('/w/gone.txt')).rejects.toThrow();
  });
});

describe('readFileState', () => {
  test('returns facts and digest together for a regular file', async () => {
    vol.fromJSON({ '/w/a.txt': 'hello' }, '/');
    const state = await readFileState('/w/a.txt');
    expect(state?.facts.size).toBe(5);
    expect(state?.digest.hash).toHaveLength(64);
  });

  test('returns null for anything that is not a regular file', async () => {
    vol.fromJSON({ '/w/sub/a.txt': 'x' }, '/');
    expect(await readFileState('/w/sub')).toBeNull();
    expect(await readFileState('/w/missing')).toBeNull();
  });
});
