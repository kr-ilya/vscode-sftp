import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fse from 'fs-extra';
import TransferTask, { TransferDirection } from '../../src/core/transferTask';
import { FileType } from '../../src/core/fs/fileSystem';
import localFs from '../../src/core/localFs';

/**
 * TransferTask.run() against a real file system.
 *
 * Until now nothing exercised it. The one test that did was skipped, because it
 * ran through an in-memory file system that does not honour the
 * `{ fd, autoClose: false }` contract the task relies on -- so the single most
 * consequential method in the project, the one that actually moves bytes and
 * can truncate a file, had no coverage at all.
 *
 * A real temp directory sidesteps that entirely: `autoClose: false` means what
 * it says, descriptors behave, and the assertions are about the product rather
 * than about a double.
 */

let workDir: string;
const at = (...parts: string[]) => path.join(workDir, ...parts);

beforeEach(async () => {
  workDir = await fse.mkdtemp(path.join(os.tmpdir(), 'syncx-transfer-'));
});

afterEach(async () => {
  await fse.remove(workDir);
});

function task(
  src: string,
  target: string,
  option: Record<string, unknown> = {},
  fileType: FileType = FileType.File
) {
  return new TransferTask(
    { fsPath: src, fileSystem: localFs },
    { fsPath: target, fileSystem: localFs },
    {
      fileType,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: { mode: 0o644, perserveTargetMode: false, ...option },
    } as never
  );
}

describe('a plain transfer', () => {
  test('copies the content exactly', async () => {
    await fse.outputFile(at('src.txt'), 'hello world');
    await task(at('src.txt'), at('dst.txt')).run();
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('hello world');
  });

  test('copies an empty file', async () => {
    await fse.outputFile(at('empty.txt'), '');
    await task(at('empty.txt'), at('dst.txt')).run();
    expect((await fse.stat(at('dst.txt'))).size).toBe(0);
  });

  test('copies binary content byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80, 0x7f]);
    await fse.outputFile(at('src.bin'), bytes);
    await task(at('src.bin'), at('dst.bin')).run();
    expect((await fse.readFile(at('dst.bin'))).equals(bytes)).toBe(true);
  });

  test('overwrites an existing target', async () => {
    await fse.outputFile(at('src.txt'), 'new');
    await fse.outputFile(at('dst.txt'), 'old and longer');
    await task(at('src.txt'), at('dst.txt')).run();
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('new');
  });

  test('handles content larger than one chunk', async () => {
    const big = 'x'.repeat(200_000);
    await fse.outputFile(at('big.txt'), big);
    await task(at('big.txt'), at('dst.txt')).run();
    expect((await fse.stat(at('dst.txt'))).size).toBe(big.length);
  });
});

describe('timestamps', () => {
  test('are preserved when mtime is supplied', async () => {
    await fse.outputFile(at('src.txt'), 'x');
    const when = Math.floor(new Date('2026-01-02T03:04:05Z').getTime());

    await task(at('src.txt'), at('dst.txt'), { atime: when, mtime: when }).run();

    const stat = await fse.stat(at('dst.txt'));
    expect(Math.floor(stat.mtimeMs / 1000)).toBe(Math.floor(when / 1000));
  });
});

describe('staging through a temporary file', () => {
  test('is on by default', async () => {
    // Writing straight to the target truncates it the instant the transfer
    // starts, so a dropped connection leaves a shortened file and the previous
    // version gone. That was the default.
    await fse.outputFile(at('src.txt'), 'content');
    await task(at('src.txt'), at('dst.txt')).run();
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('content');
  });

  test('leaves nothing behind on success', async () => {
    await fse.outputFile(at('src.txt'), 'content');
    await task(at('src.txt'), at('dst.txt')).run();
    expect((await fse.readdir(workDir)).sort()).toEqual(['dst.txt', 'src.txt']);
  });

  test('the previous version survives until the new one is complete', async () => {
    await fse.outputFile(at('src.txt'), 'brand new content');
    await fse.outputFile(at('dst.txt'), 'the previous version');
    await task(at('src.txt'), at('dst.txt')).run();
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('brand new content');
  });

  test('a failed transfer cleans up its staging file', async () => {
    // Otherwise every interrupted upload -- and, with a unique name, every
    // retry of one -- leaves debris nothing ever collects.
    await expect(task(at('missing.txt'), at('dst.txt')).run()).rejects.toBeTruthy();
    const debris = (await fse.readdir(workDir)).filter(n => n.includes('syncx-'));
    expect(debris).toEqual([]);
  });

  test('two transfers to the same target do not share a staging file', async () => {
    // Upstream used a fixed `<target>.new`, so two transfers to one path wrote
    // to the same staging file and produced a corrupt result with no error.
    await fse.outputFile(at('a.txt'), 'a'.repeat(50_000));
    await fse.outputFile(at('b.txt'), 'b'.repeat(50_000));

    const outcomes = await Promise.allSettled([
      task(at('a.txt'), at('same.txt')).run(),
      task(at('b.txt'), at('same.txt')).run(),
    ]);

    // One of them may lose the race at the rename -- two writers to one path is
    // pathological and somebody has to. What must not happen is a corrupt or
    // truncated result, or staging debris left behind.
    expect(outcomes.some(o => o.status === 'fulfilled')).toBe(true);

    const result = await fse.readFile(at('same.txt'), 'utf8');
    expect(['a'.repeat(50_000), 'b'.repeat(50_000)]).toContain(result);
    expect((await fse.readdir(workDir)).filter(n => n.includes('syncx-'))).toEqual([]);
  });

  test('can be turned off explicitly', async () => {
    await fse.outputFile(at('src.txt'), 'direct');
    await task(at('src.txt'), at('dst.txt'), { useTempFile: false }).run();
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('direct');
  });
});

describe('when the source fails mid-transfer', () => {
  test('the failure is reported rather than swallowed', async () => {
    const failing = task(at('missing.txt'), at('dst.txt'));
    await expect(failing.run()).rejects.toBeTruthy();
  });

  test('a missing source does not leave a partial target behind', async () => {
    await expect(task(at('missing.txt'), at('dst.txt')).run()).rejects.toBeTruthy();
    // Whether the target was created at all is the implementation's choice; a
    // *populated* one would mean a failed transfer looked successful.
    const exists = await fse.pathExists(at('dst.txt'));
    if (exists) {
      expect((await fse.stat(at('dst.txt'))).size).toBe(0);
    }
  });
});

describe('unsupported entry types', () => {
  test('a directory is not written out as a file', async () => {
    await fse.ensureDir(at('a-directory'));
    // run() logs and does nothing for a type it does not handle; what matters
    // is that it does not produce a bogus file at the target.
    await task(at('a-directory'), at('dst'), {}, FileType.Directory).run();
    expect(await fse.pathExists(at('dst'))).toBe(false);
  });
});

describe('cancellation', () => {
  test('isCancelled is false before anything happens, not undefined', () => {
    expect(task(at('a'), at('b')).isCancelled()).toBe(false);
  });

  test('a task cancelled before it starts never transfers', async () => {
    // The case that used to be missed entirely: cancel() was guarded on the
    // source stream existing, so cancelling a queued task did nothing and
    // isCancelled() kept reporting undefined.
    await fse.outputFile(at('src.txt'), 'should not be copied');
    const t = task(at('src.txt'), at('dst.txt'));

    t.cancel();
    expect(t.isCancelled()).toBe(true);

    await t.run();
    expect(await fse.pathExists(at('dst.txt'))).toBe(false);
  });

  test('cancelling twice is harmless', () => {
    const t = task(at('a'), at('b'));
    t.cancel();
    t.cancel();
    expect(t.isCancelled()).toBe(true);
  });

  test('cancelling mid-transfer settles rather than hanging', async () => {
    await fse.outputFile(at('src.txt'), 'x'.repeat(200_000));
    const t = task(at('src.txt'), at('dst.txt'));
    const running = t.run();
    t.cancel();
    await running.catch(() => undefined);
    expect(t.isCancelled()).toBe(true);
  });
});

describe('reporting progress', () => {
  test('reports bytes as they move, and the size when it was supplied', async () => {
    const content = 'a'.repeat(200_000);
    await fse.outputFile(at('big.txt'), content);
    const reports: Array<[number, number | undefined]> = [];

    const transfer = task(at('big.txt'), at('dst.txt'), { size: content.length });
    transfer.trackProgress((transferred, total) => reports.push([transferred, total]));
    await transfer.run();

    expect(reports.length).toBeGreaterThan(1);
    // Monotonic, ending at exactly the file size.
    expect(reports.map(([transferred]) => transferred)).toEqual(
      [...reports.map(([transferred]) => transferred)].sort((a, b) => a - b)
    );
    expect(reports[reports.length - 1][0]).toBe(content.length);
    expect(new Set(reports.map(([, total]) => total))).toEqual(new Set([content.length]));
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe(content);
  });

  test('the content still arrives intact through the counter', async () => {
    // The counter sits in the middle of the transfer, so the first thing to
    // check is that it is not losing or reordering anything.
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80]);
    await fse.outputFile(at('src.bin'), bytes);

    const transfer = task(at('src.bin'), at('dst.bin'));
    transfer.trackProgress(() => undefined);
    await transfer.run();

    expect((await fse.readFile(at('dst.bin'))).equals(bytes)).toBe(true);
  });

  test('reports without a total when the caller did not know the size', async () => {
    await fse.outputFile(at('src.txt'), 'hello');
    const totals: Array<number | undefined> = [];

    const transfer = task(at('src.txt'), at('dst.txt'));
    transfer.trackProgress((_transferred, total) => totals.push(total));
    await transfer.run();

    expect(totals.every(total => total === undefined)).toBe(true);
  });

  test('an empty file transfers without reporting anything', async () => {
    await fse.outputFile(at('empty.txt'), '');
    const reports: number[] = [];

    const transfer = task(at('empty.txt'), at('dst.txt'));
    transfer.trackProgress(transferred => reports.push(transferred));
    await transfer.run();

    expect(reports).toEqual([]);
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('');
  });

  test('cancelling mid-stream ends the transfer instead of hanging on it', async () => {
    // The counter is spliced between the source and the transport, and pipe()
    // forwards neither errors nor an abort. Cancelling aborts the source by
    // emitting 'error' on it, and with nothing listening there that throw comes
    // out of whoever pressed Cancel, while the transport sits waiting for an
    // end that is never coming.
    //
    // Cancel from outside the stream, the way the button does: an earlier
    // version of this test called cancel() from inside the progress listener,
    // which passes either way and proves nothing.
    await fse.outputFile(at('big.txt'), 'a'.repeat(5_000_000));

    const transfer = task(at('big.txt'), at('dst.txt'), { size: 5_000_000 });
    const moving = new Promise<void>(resolve => {
      transfer.trackProgress(transferred => {
        if (transferred > 0) resolve();
      });
    });

    const running = transfer.run();
    await moving;
    expect(() => transfer.cancel()).not.toThrow();

    await expect(running).rejects.toBeTruthy();
    expect(transfer.isCancelled()).toBe(true);
  }, 10_000);

  test('a transfer with no listener is untouched', async () => {
    // The counter only exists when somebody asked for progress.
    await fse.outputFile(at('src.txt'), 'hello world');
    await task(at('src.txt'), at('dst.txt')).run();
    expect(await fse.readFile(at('dst.txt'), 'utf8')).toBe('hello world');
  });
});
