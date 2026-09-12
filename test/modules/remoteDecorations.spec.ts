import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fse from 'fs-extra';

vi.mock('../../src/modules/serviceManager', () => ({
  getAllFileService: () => [],
}));

import { Uri } from '../fakes/vscode';
import RemoteDecorationProvider from '../../src/modules/remoteExplorer/decorations';
import { FileType, type FileEntry } from '../../src/core';

/**
 * The badges on the remote explorer.
 *
 * What matters here is what they are allowed to claim. A badge saying a file is
 * up to date is the one somebody acts on, so the rule is that a difference gets
 * a mark, an unknown gets none, and neither ever borrows the other's meaning.
 */

let workDir: string;
const at = (...parts: string[]) => path.join(workDir, ...parts);

beforeEach(async () => {
  workDir = await fse.mkdtemp(path.join(os.tmpdir(), 'syncx-decor-'));
});

afterEach(async () => {
  await fse.remove(workDir);
});

const remoteUri = (name: string) => Uri.parse(`syncx://example.com/${name}?remoteId=1`);

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'a.txt',
    fspath: '/srv/a.txt',
    type: FileType.File,
    size: 11,
    mtime: 1_700_000_000_000,
    atime: 1_700_000_000_000,
    mode: 0o644,
    ...over,
  } as FileEntry;
}

/** A provider whose one listed file is `local`, described by `remote`. */
function provider(localPath: string, remote: Partial<FileEntry> = {}) {
  return new RemoteDecorationProvider(uri =>
    uri.scheme === 'syncx' ? { entry: entry(remote), localPath } : undefined
  );
}

/** Puts the local file's modification time where the server says it should be. */
async function setMtime(file: string, epochMs: number) {
  await fse.utimes(file, new Date(epochMs), new Date(epochMs));
}

describe('marking differences', () => {
  test('a size that disagrees is marked modified', async () => {
    await fse.outputFile(at('a.txt'), 'much longer than eleven bytes');

    const decoration = await provider(at('a.txt')).provideFileDecoration(remoteUri('a.txt'));

    expect(decoration?.badge).toBe('M');
    expect(decoration?.tooltip).toContain('sizes differ');
  });

  test('a file with no local copy is marked as being on the server only', async () => {
    const decoration = await provider(at('missing.txt')).provideFileDecoration(
      remoteUri('missing.txt')
    );

    expect(decoration?.badge).toBe('↓');
    expect(decoration?.tooltip).toContain('no local copy');
  });
});

describe('staying quiet', () => {
  test('a file that matches gets no badge, only an explanation', async () => {
    await fse.outputFile(at('a.txt'), 'hello world');
    await setMtime(at('a.txt'), 1_700_000_000_000);

    const decoration = await provider(at('a.txt')).provideFileDecoration(remoteUri('a.txt'));

    expect(decoration?.badge).toBeUndefined();
    expect(decoration?.tooltip).toContain('Matches the local file');
  });

  test('a file that could not be compared gets no badge either', async () => {
    // Same size, different times, and no record to settle it -- which is every
    // file on an FTP server that cannot set modification times. A tree full of
    // question marks would say nothing anybody can act on.
    await fse.outputFile(at('a.txt'), 'hello world');
    await setMtime(at('a.txt'), 1_600_000_000_000);

    const decoration = await provider(at('a.txt')).provideFileDecoration(remoteUri('a.txt'));

    expect(decoration?.badge).toBeUndefined();
    expect(decoration?.tooltip).toContain('Not compared');
  });

  test('directories are not judged', async () => {
    await fse.ensureDir(at('sub'));

    const decoration = await provider(at('sub'), {
      type: FileType.Directory,
    }).provideFileDecoration(remoteUri('sub'));

    expect(decoration).toBeUndefined();
  });

  test('a local file in the way, which is not a file, is not judged', async () => {
    await fse.ensureDir(at('a.txt'));

    const decoration = await provider(at('a.txt')).provideFileDecoration(remoteUri('a.txt'));

    expect(decoration).toBeUndefined();
  });
});

describe('what it refuses to answer', () => {
  test('a URI from another extension is not ours to decorate', async () => {
    const decoration = await provider(at('a.txt')).provideFileDecoration(
      Uri.file(at('a.txt')) as never
    );

    expect(decoration).toBeUndefined();
  });

  test('a file the tree has not listed has no facts to judge', async () => {
    const empty = new RemoteDecorationProvider(() => undefined);

    expect(await empty.provideFileDecoration(remoteUri('a.txt'))).toBeUndefined();
  });
});

describe('keeping up to date', () => {
  test('a refresh tells the explorer the badges may have moved', () => {
    // A decoration is cached until its provider says otherwise, so without this
    // the badges would keep showing what was true when the folder was opened.
    const decorations = provider(at('a.txt'));
    const fired: Array<unknown> = [];
    decorations.onDidChangeFileDecorations(uri => fired.push(uri));

    decorations.refresh();

    expect(fired).toEqual([undefined]);
  });
});
