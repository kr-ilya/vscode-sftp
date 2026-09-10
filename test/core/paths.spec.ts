import { describe, test, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  replaceHomePath,
  resolvePath,
  isSubpathOf,
  fileDepth,
} from '../../src/core/util/paths';

describe('replaceHomePath', () => {
  test('expands a leading ~/', () => {
    expect(replaceHomePath('~/keys/id_ed25519')).toBe(
      path.join(os.homedir(), 'keys/id_ed25519')
    );
  });

  test('leaves other paths alone', () => {
    expect(replaceHomePath('/etc/ssh/config')).toBe('/etc/ssh/config');
    // A bare `~` is a filename here, not a home reference.
    expect(replaceHomePath('~backup')).toBe('~backup');
    expect(replaceHomePath('./relative')).toBe('./relative');
  });
});

describe('resolvePath', () => {
  test('resolves relative to the given base', () => {
    expect(resolvePath('/srv/app', 'public')).toBe(path.resolve('/srv/app', 'public'));
  });

  test('an absolute target wins over the base', () => {
    expect(resolvePath('/srv/app', '/etc/nginx')).toBe(path.resolve('/etc/nginx'));
  });

  test('expands ~ before resolving', () => {
    expect(resolvePath('/srv/app', '~/keys')).toBe(path.resolve(os.homedir(), 'keys'));
  });
});

describe('isSubpathOf', () => {
  test('recognises a descendant', () => {
    expect(isSubpathOf('/srv', '/srv/app/index.js')).toBe(true);
  });

  test('rejects an unrelated path', () => {
    expect(isSubpathOf('/srv', '/var/www')).toBe(false);
  });
});

describe('fileDepth', () => {
  test('counts segments so deeper paths sort first', () => {
    expect(fileDepth('a/b/c.txt')).toBeGreaterThan(fileDepth('a/c.txt'));
  });

  test('treats backslashes as separators', () => {
    expect(fileDepth('a\\b\\c.txt')).toBe(fileDepth('a/b/c.txt'));
  });
});
