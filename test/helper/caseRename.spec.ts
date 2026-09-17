import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toRemotePath } from '../../src/helper/paths';

/**
 * Renaming a file to change only the case of its name.
 *
 * On Windows and macOS the watcher cannot see this one: path keys are folded to
 * lower case -- deliberately, so that one file cannot occupy several records --
 * so the delete of `readme.md` and the create of `README.md` collapse into a
 * single event whose facts are identical to what was recorded. Nothing is sent,
 * and the server keeps the old name. It is an old complaint in both projects
 * this one descends from.
 *
 * The editor reports it properly, through `onDidRenameFiles`, which is the path
 * that now carries renames to the server. What has to hold for that to work is
 * that the two remote paths differ -- and they are built from local paths, one
 * of which no longer exists by the time they are built.
 */

let root: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'syncx-case-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the remote paths a case-only rename produces', () => {
  test('differ, which is what makes the rename a rename', () => {
    const before = path.join(root, 'readme.md');
    const after = path.join(root, 'README.md');
    fs.writeFileSync(before, 'x');
    // As the editor does it, and as the file system then reports it.
    fs.renameSync(before, after);

    // The old side keeps the spelling it was given, which is what the rename
    // handler asks for; resolving it against the disk would find the file under
    // its new name and produce two identical paths.
    const from = toRemotePath(before, root, '/srv/www', { resolveCasing: false });
    const to = toRemotePath(after, root, '/srv/www');

    expect(from).toBe('/srv/www/readme.md');
    expect(to).toBe('/srv/www/README.md');
    expect(from).not.toBe(to);
  });

  test('resolving the old side against the disk is what used to break it', () => {
    // Kept as the reason the option exists: on a case-insensitive file system
    // the old name still finds the file, now spelled the new way.
    const before = path.join(root, 'notes.md');
    const after = path.join(root, 'NOTES.md');
    fs.writeFileSync(before, 'x');
    fs.renameSync(before, after);

    const resolved = toRemotePath(before, root, '/srv/www');
    const asGiven = toRemotePath(before, root, '/srv/www', { resolveCasing: false });

    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(resolved).toBe('/srv/www/NOTES.md');
    }
    expect(asGiven).toBe('/srv/www/notes.md');
  });

  test('the old one is still built after the file has gone', () => {
    // Its path is resolved through the file system, and there is nothing left
    // to resolve -- which is exactly the moment a rename asks for it.
    const gone = path.join(root, 'deleted.md');

    expect(toRemotePath(gone, root, '/srv/www')).toBe('/srv/www/deleted.md');
  });

  test('a nested file keeps its directories', () => {
    const nested = path.join(root, 'src', 'deep', 'File.ts');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'x');

    expect(toRemotePath(nested, root, '/srv/www')).toBe('/srv/www/src/deep/File.ts');
  });
});
