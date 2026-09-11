import { describe, test, expect } from 'vitest';
import * as path from 'node:path';
import { toRemotePath, toLocalPath } from '../../src/helper/paths';

/**
 * Mapping between the local tree and the remote one.
 *
 * Worth pinning down because getting it wrong is invisible at the type level:
 * every path is a `string`, so handing a *local* path to a remote operation
 * compiles cleanly and fails only against a real server. That is exactly what
 * the rename handler did -- it asked the server to rename one local Windows
 * path to another, so renaming never worked at all.
 */

const localRoot = path.resolve(path.sep, 'work', 'project');
const at = (...parts: string[]) => path.join(localRoot, ...parts);

describe('toRemotePath', () => {
  test('maps a file at the root', () => {
    expect(toRemotePath(at('index.ts'), localRoot, '/var/www')).toBe('/var/www/index.ts');
  });

  test('maps a nested file, and always with forward slashes', () => {
    // The remote side is POSIX regardless of what the local platform uses.
    expect(toRemotePath(at('src', 'app', 'main.ts'), localRoot, '/var/www')).toBe(
      '/var/www/src/app/main.ts'
    );
  });

  test('the workspace root maps to the remote root', () => {
    expect(toRemotePath(localRoot, localRoot, '/var/www')).toBe('/var/www');
  });

  test('a trailing separator on the remote root does not double up', () => {
    expect(toRemotePath(at('index.ts'), localRoot, '/var/www/')).toBe('/var/www/index.ts');
  });
});

describe('toLocalPath', () => {
  test('round-trips a nested file', () => {
    const local = at('src', 'app', 'main.ts');
    const remote = toRemotePath(local, localRoot, '/var/www');
    expect(toLocalPath(remote, '/var/www', localRoot)).toBe(local);
  });

  test('maps a file at the remote root', () => {
    expect(toLocalPath('/var/www/index.ts', '/var/www', localRoot)).toBe(at('index.ts'));
  });
});

describe('paths that no longer exist locally', () => {
  test('map without throwing', () => {
    // The routine case, not an edge one: a renamed file is gone under its old
    // name and a deleted one is gone entirely, yet both still need their remote
    // path computed. An unguarded realpath -- used only to recover the on-disk
    // casing -- made every such mapping throw ENOENT on Windows and macOS.
    expect(() => toRemotePath(at('deleted-yesterday.ts'), localRoot, '/var/www')).not.toThrow();
    expect(toRemotePath(at('deleted-yesterday.ts'), localRoot, '/var/www')).toBe(
      '/var/www/deleted-yesterday.ts'
    );
  });
});

describe('a rename maps both ends through the same context', () => {
  test('old and new are remote paths under the remote root, not local ones', () => {
    const from = toRemotePath(at('old-name.ts'), localRoot, '/var/www');
    const to = toRemotePath(at('sub', 'new-name.ts'), localRoot, '/var/www');

    expect(from).toBe('/var/www/old-name.ts');
    expect(to).toBe('/var/www/sub/new-name.ts');

    for (const remote of [from, to]) {
      expect(remote.startsWith('/var/www/')).toBe(true);
      // A native separator here would mean a local path reached the server.
      expect(remote.includes(path.win32.sep)).toBe(false);
    }
  });
});
