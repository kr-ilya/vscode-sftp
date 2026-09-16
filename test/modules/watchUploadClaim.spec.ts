import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `uploadOnSave` and the watcher answering the same save.
 *
 * One save arrives twice: as the editor's save event, which `uploadOnSave`
 * acts on, and as a file-system event, which the watcher gates. The gate would
 * settle the second by itself -- the facts on disk match what was recorded --
 * but the record is only written when the upload finishes. An event examined
 * before then finds the old record and sends the file again, so whether it goes
 * once or twice depends on whether the transfer beats the 400ms batching
 * window: never on a fast link, every save on a slow one.
 *
 * The claim is what closes that window. These tests drive the whole loop the
 * user sees -- claim, file-system event, release -- rather than the registry on
 * its own.
 */

const mocks = vi.hoisted(() => ({
  upload: vi.fn(async (_path: string) => undefined),
  // Raised once per batch and once per outcome carried out, so waiting for it
  // is an exact barrier: by the time the second call lands, the outcome has
  // been applied or reported and anything it records has been written.
  markDirty: vi.fn(),
}));

vi.mock('../../src/fileHandlers', () => ({
  upload: (uri: { fsPath: string }) => mocks.upload(uri.fsPath),
  removeRemote: async () => undefined,
  createRemoteFolder: async () => undefined,
}));

vi.mock('../../src/modules/watch/output', () => ({
  getWatchOutput: () => ({
    append: () => undefined,
    appendLine: () => undefined,
    show: () => undefined,
  }),
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

import { createdWatchers, type FakeFileSystemWatcher } from '../fakes/vscode';
import { DestinationDeclinedError } from '../../src/helper';
import type { WatchCounters } from '../../src/core/watch/diagnostics';
import watcherService, {
  claimUpload,
  getTreeHandles,
} from '../../src/modules/watch/watcherService';

let dir: string;
let file: string;

beforeEach(() => {
  // The clock is faked down to `Date`, because the debounce behind the batching
  // window reads `Date.now()` as well as setting timers -- leaving it real made
  // these tests wait on the wall clock without saying so. `setImmediate` is
  // deliberately left alone: `quiet()` drains the event loop with it.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  mocks.upload.mockReset();
  mocks.upload.mockImplementation(async () => undefined);
  mocks.markDirty.mockClear();
  createdWatchers.length = 0;
  // A directory of our own, removed again below: nothing here writes anywhere
  // a test did not create.
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'syncx-claim-')));
  file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'saved content');
});

afterEach(() => {
  watcherService.dispose(dir);
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Starts watching the temp directory and waits until the tree is registered. */
async function watch(): Promise<{ watcher: FakeFileSystemWatcher; counters: WatchCounters }> {
  watcherService.create(
    dir,
    { files: '**/*', autoUpload: true, autoDelete: false },
    { scope: 'test-scope', isIgnored: () => false, concurrency: 1 }
  );
  await vi.waitFor(() => expect(getTreeHandles().has(dir)).toBe(true));
  return { watcher: createdWatchers[0], counters: getTreeHandles().get(dir)!.counters };
}

/**
 * Closes the batching window, then waits for the tree's own counters to show
 * the outcome.
 *
 * Waiting on the counters is what makes these tests deterministic. A batch is
 * examined and carried out asynchronously, so advancing the clock proves
 * nothing on its own: an upload the assertion ran past would simply land during
 * the next test, where it is someone else's problem.
 */
async function until(counters: WatchCounters, reached: (c: WatchCounters) => boolean) {
  await vi.advanceTimersByTimeAsync(3_500);
  await vi.waitFor(() => expect(reached(counters)).toBe(true));
}

/**
 * Closes the batching window, for tests that then assert nothing happened.
 *
 * What those tests assert on is `counters.batches`, which the watcher raises
 * synchronously the moment a batch is released -- so once the clock has been
 * advanced past the window, that number is final. Waiting for the *decisions*
 * instead would mean waiting for real disk reads to finish, with no signal
 * saying when they have: work missed by the assertion would simply surface as a
 * failure in whichever test ran next, which is how this test file first
 * misreported which rule it was checking.
 */
async function quiet(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_500);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

/** Waits until one batch has been decided and its outcome carried out. */
async function untilSettled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_500);
  await vi.waitFor(() => expect(mocks.markDirty.mock.calls.length).toBeGreaterThanOrEqual(2));
}

/** What the tracker holds for the test file, if anything. */
function recordFor(): unknown {
  const handle = getTreeHandles().get(dir)!;
  return handle.deps.store.get(handle.deps.keyer(file));
}

const uploaded = (c: WatchCounters) => c.uploaded === 1;
const suppressed = (c: WatchCounters) => c.skipped['upload-in-flight'] === 1;

describe('a save that both routes react to', () => {
  test('without a claim, the watcher uploads what uploadOnSave is already sending', async () => {
    // The state this defends against, asserted first so the test below is
    // known to be measuring something.
    const { watcher, counters } = await watch();
    watcher.fire('change', file);

    await until(counters, uploaded);
    expect(mocks.upload).toHaveBeenCalledWith(file);
  });

  test('with a claim, the same event sends nothing', async () => {
    const { watcher, counters } = await watch();
    const claim = await claimUpload(file);

    watcher.fire('change', file);
    await until(counters, suppressed);

    expect(mocks.upload).not.toHaveBeenCalled();
    claim.release('uploaded');
  });

  test('a second save during the upload is still sent', async () => {
    const { watcher, counters } = await watch();
    const claim = await claimUpload(file);

    // The user saves again while the first upload is still running: these are
    // different bytes, and nothing has sent them.
    fs.writeFileSync(file, 'saved again, and longer');
    watcher.fire('change', file);
    await until(counters, uploaded);

    expect(mocks.upload).toHaveBeenCalledWith(file);
    claim.release('uploaded');
  });
});

describe('releasing the claim', () => {
  test('a successful upload asks for nothing further', async () => {
    const { counters } = await watch();
    const claim = await claimUpload(file);

    claim.release('uploaded');
    await quiet();

    expect(counters.batches).toBe(0);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  test('a failed upload puts back the event it held up', async () => {
    // That event was suppressed on the strength of a transfer that then did not
    // happen. Without this the file would sit unsent until it was next touched
    // -- the one way this change could lose an upload.
    const { watcher, counters } = await watch();
    const claim = await claimUpload(file);

    watcher.fire('change', file);
    await until(counters, suppressed);
    claim.release('failed');
    await until(counters, uploaded);

    expect(mocks.upload).toHaveBeenCalledWith(file);
  });

  test('a failed upload the watcher never saw is left alone', async () => {
    // Nothing was held back -- the file is outside what this watcher covers, or
    // no event came -- so there is nothing to undo, and uploading it here would
    // be a retry nobody asked for.
    const { counters } = await watch();
    const claim = await claimUpload(file);

    claim.release('failed');
    await quiet();

    expect(counters.batches).toBe(0);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  test('a tree disposed in the meantime is not asked to do anything', async () => {
    // A config reload replaces the tree, and a slow transfer can outlive it.
    // Putting a file back through a gate that has been taken down would upload
    // it under the configuration that was just replaced.
    const { watcher, counters } = await watch();
    const claim = await claimUpload(file);

    watcher.fire('change', file);
    await until(counters, suppressed);

    watcherService.dispose(dir);
    claim.release('failed');
    await quiet();

    // The one batch is the event that was held back; nothing followed it.
    expect(counters.batches).toBe(1);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe('a destination the user declines', () => {
  /** What the guard does when the prompt is answered with Cancel. */
  const declines = () =>
    mocks.upload.mockImplementation(async () => {
      throw new DestinationDeclinedError('deploy@example.com:/srv/www');
    });

  test('for comparison: an upload that goes through is recorded as synced', async () => {
    const { watcher } = await watch();
    watcher.fire('change', file);

    await untilSettled();

    expect(recordFor()).toBeDefined();
  });

  test('a declined upload is not recorded as synced', async () => {
    // It used to be. The guard returned quietly, which the watcher could not
    // tell from a finished transfer, so the tracker ended up claiming the
    // server held content that had never been sent -- and every later event for
    // that file was then dropped at the metadata gate.
    declines();
    const { watcher } = await watch();
    watcher.fire('change', file);

    await untilSettled();

    expect(recordFor()).toBeUndefined();
  });

  test('declining uploadOnSave does not ask again about the same save', async () => {
    // Putting the file back through the gate is for transfers that *failed*.
    // The user was asked and said no; asking twice about one save is not a
    // safeguard, it is a nag.
    const { watcher, counters } = await watch();
    const claim = await claimUpload(file);

    watcher.fire('change', file);
    await until(counters, suppressed);

    claim.release('declined');
    await quiet();

    expect(counters.batches).toBe(1);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe('files no watcher covers', () => {
  test('are not claimed, and releasing is harmless', async () => {
    // `uploadOnSave` runs whether or not a watcher is configured, so this is
    // the ordinary case for a configuration without one.
    const { counters } = await watch();
    const elsewhere = path.join(dir, '..', 'not-watched.txt');
    const claim = await claimUpload(elsewhere);

    claim.release('failed');
    await quiet();

    expect(counters.batches).toBe(0);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
