import { describe, test, expect } from 'vitest';
import { transfer, TransferDirection } from '../../src/fileHandlers/transfer/transfer';
import { FileType, type FileEntry, type FileSystem } from '../../src/core';
import upath from '../../src/core/upath';

/**
 * How wide the walk opens while it looks for what to transfer.
 *
 * `concurrency` bounded the transfers and nothing else. Finding them -- a
 * `mkdir` for each directory, a listing for each directory, recursively, with a
 * plain `Promise.all` at every level -- ran as wide as the tree was: measured
 * at eighty concurrent operations against a budget of two. That is what a
 * server sees as a burst of sessions, and what the user sees as an unreliable
 * network rather than a setting that was never applied.
 */

/** A tree that answers instantly but counts how many callers are inside it. */
function fakeTree(options: { directories: number; filesPerDirectory: number; delayMs?: number }) {
  const { directories, filesPerDirectory, delayMs = 2 } = options;
  const meter = { active: 0, peak: 0, calls: 0 };

  // One level of directories under the root, files inside each of them.
  const children = (dir: string): FileEntry[] => {
    const entries: FileEntry[] = [];
    if (!dir.includes('/dir-')) {
      for (let i = 0; i < directories; i++) {
        entries.push(entry(`${dir}/dir-${i}`, FileType.Directory));
      }
      return entries;
    }
    for (let i = 0; i < filesPerDirectory; i++) {
      entries.push(entry(`${dir}/file-${i}.txt`, FileType.File));
    }
    return entries;
  };

  const entry = (fspath: string, type: FileType): FileEntry => ({
    fspath,
    name: fspath.split('/').pop() as string,
    type,
    mode: 0o644,
    size: 10,
    mtime: 0,
    atime: 0,
  });

  async function measured<T>(produce: () => T): Promise<T> {
    meter.active += 1;
    meter.peak = Math.max(meter.peak, meter.active);
    meter.calls += 1;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    meter.active -= 1;
    return produce();
  }

  const fs = {
    pathResolver: upath,
    lstat: (p: string) =>
      measured(() => entry(p, p.endsWith('.txt') ? FileType.File : FileType.Directory)),
    list: (p: string) => measured(() => children(p)),
    ensureDir: () => measured(() => undefined),
    chmod: () => measured(() => undefined),
  } as unknown as FileSystem;

  return { fs, meter };
}

async function walk(concurrency: number, shape: { directories: number; filesPerDirectory: number }) {
  const source = fakeTree(shape);
  const target = fakeTree(shape);
  const collected: string[] = [];

  await transfer(
    {
      srcFsPath: '/local/project',
      srcFs: source.fs,
      targetFsPath: '/remote/project',
      targetFs: target.fs,
      transferOption: { preserveTargetMode: false },
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      concurrency,
    },
    task => collected.push(task.localFsPath),
  );

  return { collected, source: source.meter, target: target.meter };
}

describe('the walk draws on the same budget as the transfers', () => {
  test('a wide tree never exceeds the configured concurrency', async () => {
    const { target, source } = await walk(2, { directories: 12, filesPerDirectory: 4 });

    expect(target.peak).toBeLessThanOrEqual(2);
    expect(source.peak).toBeLessThanOrEqual(2);
    // And it really did walk: a budget honoured by doing nothing proves nothing.
    expect(target.calls).toBeGreaterThan(12);
  }, 20_000);

  test('a larger budget is used', async () => {
    const { target } = await walk(4, { directories: 12, filesPerDirectory: 4 });

    expect(target.peak).toBeGreaterThan(1);
    expect(target.peak).toBeLessThanOrEqual(4);
  }, 20_000);

  test('every file is still found', async () => {
    const { collected } = await walk(2, { directories: 5, filesPerDirectory: 3 });

    expect(collected).toHaveLength(15);
    expect(collected).toContain('/local/project/dir-4/file-2.txt');
  }, 20_000);

  test('a budget of one walks strictly one operation at a time', async () => {
    const { target } = await walk(1, { directories: 4, filesPerDirectory: 2 });

    expect(target.peak).toBe(1);
  }, 20_000);
});
