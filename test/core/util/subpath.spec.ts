import { describe, test, expect } from 'vitest';
import * as path from 'node:path';
import { isSubpathOf } from '../../../src/core/util/paths';

/**
 * Whether one path lies inside another.
 *
 * It compared string prefixes, so a folder answered yes for any sibling whose
 * name merely started the same way. Two things depend on the answer: which
 * watcher a saved file belongs to, and which root the ignore rules are
 * evaluated against -- so `~/work/proj-backup` was being handled as part of
 * `~/work/proj`.
 */

const p = (...parts: string[]) => path.join(...parts);

describe('a sibling whose name starts the same way', () => {
  test.each([
    ['proj-backup', p('/work', 'proj-backup', 'file.txt')],
    ['projects', p('/work', 'projects', 'file.txt')],
    ['proj2', p('/work', 'proj2')],
  ])('%s is not inside proj', (_label, candidate) => {
    expect(isSubpathOf(p('/work', 'proj'), candidate)).toBe(false);
  });
});

describe('what is inside', () => {
  test.each([
    ['a file directly in it', p('/work', 'proj', 'file.txt')],
    ['a file deeper down', p('/work', 'proj', 'src', 'deep', 'file.txt')],
    ['a directory in it', p('/work', 'proj', 'src')],
  ])('%s', (_label, candidate) => {
    expect(isSubpathOf(p('/work', 'proj'), candidate)).toBe(true);
  });
});

describe('edges', () => {
  test('a path is not inside itself', () => {
    // Callers that accept the root itself compare for equality first, and say
    // so where they do.
    expect(isSubpathOf(p('/work', 'proj'), p('/work', 'proj'))).toBe(false);
  });

  test('the parent is not inside its child', () => {
    expect(isSubpathOf(p('/work', 'proj', 'src'), p('/work', 'proj'))).toBe(false);
  });

  test('an unrelated path is not inside', () => {
    expect(isSubpathOf(p('/work', 'proj'), p('/elsewhere', 'file.txt'))).toBe(false);
  });

  test('a trailing separator on the root changes nothing', () => {
    expect(isSubpathOf(p('/work', 'proj') + path.sep, p('/work', 'proj', 'file.txt'))).toBe(true);
  });

  test('a path that walks back out is not inside', () => {
    expect(isSubpathOf(p('/work', 'proj'), p('/work', 'proj', '..', 'other', 'f.txt'))).toBe(false);
  });
});
