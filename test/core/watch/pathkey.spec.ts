import { describe, test, expect } from 'vitest';
import { createPathKeyer, isAtOrUnder } from '../../../src/core/watch/pathkey';

const sensitive = createPathKeyer('sensitive');
const insensitive = createPathKeyer('insensitive');

describe('separator normalisation', () => {
  test('backslashes and forward slashes produce the same key', () => {
    expect(sensitive('a\\b\\c.txt')).toBe(sensitive('a/b/c.txt'));
  });

  test('repeated separators collapse', () => {
    expect(sensitive('a//b///c.txt')).toBe(sensitive('a/b/c.txt'));
  });

  test('a trailing separator is irrelevant', () => {
    expect(sensitive('/srv/app/')).toBe(sensitive('/srv/app'));
  });

  test('"." segments are removed', () => {
    expect(sensitive('/srv/./app/./index.js')).toBe(sensitive('/srv/app/index.js'));
  });

  test('".." resolves against the preceding segment', () => {
    expect(sensitive('/srv/app/../lib/x.js')).toBe(sensitive('/srv/lib/x.js'));
  });

  test('a leading ".." in a relative path is preserved', () => {
    // There is nothing to pop, and silently dropping it would collapse two
    // genuinely different paths onto one key.
    expect(sensitive('../outside/x.js')).toBe('../outside/x.js');
  });

  test('a UNC prefix survives', () => {
    expect(sensitive('\\\\server\\share\\file.txt')).toBe('//server/share/file.txt');
  });

  test('absolute and relative stay distinct', () => {
    expect(sensitive('/a/b')).not.toBe(sensitive('a/b'));
  });
});

describe('scenario 13: a case-insensitive file system', () => {
  test('differently cased spellings collapse to one key', () => {
    // VS Code documents that the casing it reports may differ from the casing
    // on disk, because a workspace folder can be opened with any casing.
    expect(insensitive('C:\\Code\\App\\Index.TS')).toBe(insensitive('c:/code/app/index.ts'));
  });

  test('a drive letter differing only in case is the same file', () => {
    expect(insensitive('C:/x')).toBe(insensitive('c:/x'));
  });

  test('under a case-sensitive policy they stay distinct', () => {
    expect(sensitive('/srv/App.js')).not.toBe(sensitive('/srv/app.js'));
  });
});

describe('isAtOrUnder', () => {
  test('a path is under its own root', () => {
    expect(isAtOrUnder(sensitive, '/srv/app', '/srv/app')).toBe(true);
  });

  test('a descendant is under the root', () => {
    expect(isAtOrUnder(sensitive, '/srv/app', '/srv/app/src/index.js')).toBe(true);
  });

  test('a sibling sharing a prefix is not', () => {
    // The trap a plain startsWith falls into.
    expect(isAtOrUnder(sensitive, '/srv/app', '/srv/app-legacy/index.js')).toBe(false);
  });

  test('the comparison respects the case policy', () => {
    expect(isAtOrUnder(insensitive, '/Srv/App', '/srv/app/x.js')).toBe(true);
    expect(isAtOrUnder(sensitive, '/Srv/App', '/srv/app/x.js')).toBe(false);
  });

  test('separators are normalised on both sides', () => {
    expect(isAtOrUnder(sensitive, 'C:/work', 'C:\\work\\sub\\f.txt')).toBe(true);
  });
});
