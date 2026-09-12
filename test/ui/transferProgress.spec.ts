import { describe, test, expect, vi, beforeEach } from 'vitest';
import TransferProgress, { humanBytes } from '../../src/ui/transferProgress';
import { openedProgress } from '../fakes/vscode';

/**
 * What the user sees while bytes are moving, and how they stop it.
 *
 * Before this, a transfer was a spinner in the status bar: a five-hundred
 * megabyte upload and a stalled one looked identical, and the "cancel all
 * transfers" command existed but nothing offered it to the person watching.
 *
 * The awkward requirement is that `uploadOnSave` transfers on every save, so a
 * notification that appeared instantly would interrupt constantly. It has to
 * stay out of the way until the work is worth interrupting for -- which is what
 * most of these tests are about.
 */

/** A clock the test moves by hand; the quiet period is measured against it. */
function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Both match the constants in the module under test. */
const RENDER_INTERVAL_MS = 100;
const QUIET_PERIOD_MS = 2000;

const upload = (name: string, total?: number) => ({ name, verb: 'Uploading', total });

beforeEach(() => {
  openedProgress.length = 0;
});

describe('staying out of the way', () => {
  test('a transfer that finishes quickly never shows a notification', async () => {
    // The uploadOnSave case: one small file, over in milliseconds.
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const task = {};

    progress.begin(task, upload('a.txt', 400));
    time.advance(50);
    progress.advance(task, 400);
    progress.end(task);
    await Promise.resolve();

    expect(openedProgress).toEqual([]);
    expect(progress.isShowing).toBe(false);
  });

  test('work still running just under the quiet period shows nothing yet', async () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const task = {};

    progress.begin(task, upload('big.zip', 10 * 1024 * 1024));
    time.advance(QUIET_PERIOD_MS - 1);
    progress.advance(task, 1024);
    await Promise.resolve();

    expect(openedProgress).toEqual([]);
  });

  test('work still running after the quiet period does show one', async () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const task = {};

    progress.begin(task, upload('big.zip', 10 * 1024 * 1024));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(task, 1024 * 1024);
    await Promise.resolve();

    expect(openedProgress).toHaveLength(1);
    expect(openedProgress[0].options.cancellable).toBe(true);
  });
});

describe('what it says', () => {
  test('one file reports its own bytes against its size', async () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const task = {};

    progress.begin(task, upload('big.zip', 4 * 1024 * 1024));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(task, 1024 * 1024);
    await Promise.resolve();

    expect(openedProgress[0].lastMessage).toBe('Uploading big.zip — 1.0 MB of 4.0 MB');
  });

  test('a file of unknown size reports what has moved so far', async () => {
    // Nothing takes an extra round trip just to learn a size, so some
    // transfers genuinely have no total.
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const task = {};

    progress.begin(task, upload('stream.bin'));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(task, 2048);
    await Promise.resolve();

    expect(openedProgress[0].lastMessage).toBe('Uploading stream.bin — 2.0 KB');
  });

  test('several files report a running total, not a percentage', async () => {
    // The whole size is unknown until the walk producing the transfers ends,
    // and a bar that jumps backwards as work is discovered is worse than none.
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const first = {};
    const second = {};

    progress.begin(first, upload('one.bin', 1024));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.begin(second, upload('two.bin', 1024));
    progress.advance(first, 512);
    // Chunks arrive over time; the message is throttled, so give it a moment.
    time.advance(RENDER_INTERVAL_MS);
    progress.advance(second, 512);
    await Promise.resolve();

    expect(openedProgress[0].lastMessage).toBe('Uploading 2 files — 1.0 KB');
  });

  test('a mixed batch does not claim to be doing one of them', async () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const up = {};
    const down = {};

    progress.begin(up, { name: 'a', verb: 'Uploading' });
    time.advance(QUIET_PERIOD_MS + 50);
    progress.begin(down, { name: 'b', verb: 'Downloading' });
    time.advance(RENDER_INTERVAL_MS);
    progress.advance(up, 10);
    await Promise.resolve();

    expect(openedProgress[0].lastMessage).toBe('Transferring 2 files — 10 B');
  });

  test('the message is not rewritten on every chunk', async () => {
    // A chunk is tens of kilobytes, so a large file would otherwise redraw the
    // notification thousands of times a second.
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const task = {};

    progress.begin(task, upload('big.zip', 10_000_000));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(task, 1);
    await Promise.resolve();
    const afterOpening = openedProgress[0].messages.length;

    for (let i = 2; i < 500; i += 1) {
      time.advance(1);
      progress.advance(task, i * 64 * 1024);
    }

    expect(openedProgress[0].messages.length - afterOpening).toBeLessThan(10);
  });
});

describe('the counting', () => {
  test('the last transfer to finish closes the notification', async () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);
    const first = {};
    const second = {};

    progress.begin(first, upload('one.bin'));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.begin(second, upload('two.bin'));
    progress.advance(first, 1);
    await Promise.resolve();
    expect(progress.isShowing).toBe(true);

    progress.end(first);
    expect(progress.isShowing).toBe(true);

    progress.end(second);
    expect(progress.isShowing).toBe(false);
    await Promise.resolve();
    expect(openedProgress[0].finished).toBe(true);
  });

  test('a second operation opens a fresh notification, not a second one alongside', async () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);

    const first = {};
    progress.begin(first, upload('one.bin'));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(first, 1);
    await Promise.resolve();
    progress.end(first);

    // No await here on purpose: the next operation starting in the same tick as
    // the last one ending is exactly the case that used to show nothing.
    const second = {};
    progress.begin(second, upload('two.bin'));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(second, 1);
    await Promise.resolve();

    expect(openedProgress).toHaveLength(2);
    expect(openedProgress[1].finished).toBe(false);
  });

  test('an unknown task is ignored rather than resurrecting the notification', () => {
    const time = clock();
    const progress = new TransferProgress(() => undefined, time.now);

    progress.advance({}, 100);
    progress.end({});

    expect(progress.isShowing).toBe(false);
    expect(openedProgress).toEqual([]);
  });
});

describe('cancelling', () => {
  test('pressing Cancel asks for everything to stop', async () => {
    const cancelAll = vi.fn();
    const time = clock();
    const progress = new TransferProgress(cancelAll, time.now);
    const task = {};

    progress.begin(task, upload('big.zip', 10_000_000));
    time.advance(QUIET_PERIOD_MS + 50);
    progress.advance(task, 1);
    await Promise.resolve();

    openedProgress[0].cancel();

    expect(cancelAll).toHaveBeenCalledOnce();
  });
});

describe('byte sizes', () => {
  test.each([
    [0, '0 B'],
    [999, '999 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [1024 * 1024 * 1024 * 3.5, '3.5 GB'],
    [1024 ** 4 * 2, '2.0 TB'],
  ])('%i renders as %s', (bytes, expected) => {
    expect(humanBytes(bytes)).toBe(expected);
  });
});
