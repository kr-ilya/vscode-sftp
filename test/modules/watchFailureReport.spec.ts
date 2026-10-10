import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A transfer that fails must be visible, not only a line in the log.
 *
 * The watcher leaves a failed file unsent until it changes again, so a timeout
 * at the wrong moment used to mean a file the user believed was on the server
 * and was not. The failure is reported once per batch: the status bar goes to
 * its error state and a single notification says how many files are affected.
 */

const mocks = vi.hoisted(() => ({
  upload: vi.fn(async (_path: string) => undefined),
  markDirty: vi.fn(),
  showErrorMessage: vi.fn(async (_message: string, ..._items: string[]) => undefined as string | undefined),
  updateStatus: vi.fn(),
  showOutput: vi.fn(),
}));

vi.mock('../../src/fileHandlers', () => ({
  upload: (uri: { fsPath: string }) => mocks.upload(uri.fsPath),
  removeRemote: async () => undefined,
  createRemoteFolder: async () => undefined,
}));

vi.mock('../../src/host', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/host')>()),
  showErrorMessage: mocks.showErrorMessage,
}));

vi.mock('../../src/app', () => ({ default: { sftpBarItem: { updateStatus: mocks.updateStatus } } }));
vi.mock('../../src/ui/statusBarItem', () => ({ default: { Status: { error: 'error' } } }));
vi.mock('../../src/ui/output', () => ({ show: mocks.showOutput }));

vi.mock('../../src/modules/watch/output', () => ({
  getWatchOutput: () => ({ append: () => undefined, appendLine: () => undefined, show: () => undefined }),
}));

vi.mock('../../src/modules/watch/stateStore', async () => {
  const { createStateStore } = await import('../../src/core/watch/state');
  return {
    loadPersistentState: async () => ({
      store: createStateStore(),
      markDirty: mocks.markDirty,
      flush: async () => undefined,
      dispose: () => undefined,
    }),
  };
});

vi.mock('../../src/modules/watch/walk', () => ({
  walkFiles: async () => [],
  MAX_WALK_FILES: 20_000,
}));

import { createdWatchers } from '../fakes/vscode';
import { DestinationDeclinedError } from '../../src/helper';
import watcherService, { getTreeHandles } from '../../src/modules/watch/watcherService';

let dir: string;
let files: string[];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  mocks.upload.mockReset();
  mocks.upload.mockImplementation(async () => undefined);
  mocks.showErrorMessage.mockClear();
  mocks.showErrorMessage.mockImplementation(async () => undefined);
  mocks.updateStatus.mockClear();
  mocks.showOutput.mockClear();
  mocks.markDirty.mockClear();
  createdWatchers.length = 0;
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'syncx-failure-')));
  files = ['a.txt', 'b.txt'].map(name => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, name);
    return file;
  });
});

afterEach(() => {
  watcherService.dispose(dir);
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Watches the temp directory, fires a change for every file, and settles the batch. */
async function changeAll(): Promise<void> {
  watcherService.create(
    dir,
    { files: '**/*', autoUpload: true, autoDelete: false },
    { scope: 'test-scope', isIgnored: () => false, concurrency: 1 }
  );
  await vi.waitFor(() => expect(getTreeHandles().has(dir)).toBe(true));
  for (const file of files) createdWatchers[0].fire('change', file);

  await vi.advanceTimersByTimeAsync(3_500);
  // Raised once per batch and once per outcome: batch + every file.
  await vi.waitFor(() => expect(mocks.markDirty.mock.calls.length).toBeGreaterThanOrEqual(1 + files.length));
}

describe('a failed upload by the watcher', () => {
  test('puts the status bar in its error state and tells the user once', async () => {
    mocks.upload.mockRejectedValue(new Error('Timed out while waiting for handshake'));

    await changeAll();

    expect(mocks.updateStatus).toHaveBeenCalledWith('error');
    // Two files failed, one notification.
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(mocks.showErrorMessage.mock.calls[0][0]).toContain('2 files');
  });

  test('names the file when it is the only one', async () => {
    files = [files[0]];
    mocks.upload.mockRejectedValue(new Error('boom'));

    await changeAll();

    expect(mocks.showErrorMessage.mock.calls[0][0]).toContain(files[0]);
  });

  test('Detail opens the output', async () => {
    mocks.upload.mockRejectedValue(new Error('boom'));
    mocks.showErrorMessage.mockImplementation(async () => 'Detail');

    await changeAll();

    await vi.waitFor(() => expect(mocks.showOutput).toHaveBeenCalledTimes(1));
  });

  test('a declined upload is not a failure', async () => {
    mocks.upload.mockRejectedValue(new DestinationDeclinedError('server'));

    await changeAll();

    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
  });

  test('a successful batch says nothing', async () => {
    await changeAll();

    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
  });
});
