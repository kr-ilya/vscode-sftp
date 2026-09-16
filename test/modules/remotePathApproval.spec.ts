import { describe, test, expect, beforeEach } from 'vitest';
import { warningAnswers, shownWarnings } from '../fakes/vscode';
import {
  initializeRemotePathApproval,
  ensureRemotePathApproved,
  resetApprovals,
} from '../../src/modules/remotePathApproval';
import { DestinationDeclinedError } from '../../src/helper';
import type { FileSystem } from '../../src/core';
import type { RemoteDestination } from '../../src/core/remotePathGuard';

/**
 * The question asked once before the first write to a destination.
 *
 * What matters beyond the prompt itself is what *declining* means. It used to
 * mean "return quietly", which the caller could not tell apart from a finished
 * transfer -- so the watcher recorded the file as being on the server and then
 * skipped every later event for it. Saying no now throws, and nothing
 * downstream can mistake it for success.
 */

const destination: RemoteDestination = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/srv/www/site',
};

/** Just enough of a file system for the prompt to describe the target. */
function remoteFsWith(entries: string[]): FileSystem {
  return {
    list: async () => entries.map(name => ({ name })),
  } as unknown as FileSystem;
}

/** A stand-in for `context.globalState`. */
function memento() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
    keys: () => [...values.keys()],
    size: () => values.size,
  };
}

let state: ReturnType<typeof memento>;

beforeEach(() => {
  warningAnswers.length = 0;
  shownWarnings.length = 0;
  state = memento();
  initializeRemotePathApproval({ globalState: state } as never);
});

describe('being asked', () => {
  test('the prompt names the destination and what is already in it', async () => {
    // A listing beginning "bin, boot, dev, etc" explains the situation better
    // than any warning could, and does so for a path that looks unremarkable.
    warningAnswers.push('Upload here');
    await ensureRemotePathApproved(destination, remoteFsWith(['bin', 'boot', 'dev', 'etc']));

    expect(shownWarnings[0].message).toContain('example.com');
    expect(shownWarnings[0].options.detail).toContain('bin, boot, dev, etc');
  });

  test('a directory that is not there yet is not a refusal', async () => {
    // Normal for a first deployment.
    warningAnswers.push('Upload here');
    const failing = { list: async () => Promise.reject(new Error('no such file')) };

    await expect(
      ensureRemotePathApproved(destination, failing as unknown as FileSystem)
    ).resolves.toBeUndefined();
  });

  test('agreeing is remembered, so the next write does not ask again', async () => {
    warningAnswers.push('Upload here');
    await ensureRemotePathApproved(destination, remoteFsWith([]));

    await ensureRemotePathApproved(destination, remoteFsWith([]));

    expect(shownWarnings).toHaveLength(1);
  });

  test('a different destination is a different question', async () => {
    warningAnswers.push('Upload here', 'Upload here');
    await ensureRemotePathApproved(destination, remoteFsWith([]));
    await ensureRemotePathApproved(
      { ...destination, remotePath: '/srv/www/other' },
      remoteFsWith([])
    );

    expect(shownWarnings).toHaveLength(2);
  });
});

describe('several writes starting at once', () => {
  // A batch is carried out several files at a time, and each one checks the
  // destination before writing. One question, not one per file in flight.
  test('are one question, and all of them get its answer', async () => {
    warningAnswers.push('Upload here');

    await Promise.all(
      Array.from({ length: 5 }, () => ensureRemotePathApproved(destination, remoteFsWith([])))
    );

    expect(shownWarnings).toHaveLength(1);
  });

  test('and when it is declined, every one of them is declined', async () => {
    warningAnswers.push('Cancel');

    const answers = await Promise.allSettled(
      Array.from({ length: 5 }, () => ensureRemotePathApproved(destination, remoteFsWith([])))
    );

    expect(shownWarnings).toHaveLength(1);
    expect(answers.every(a => a.status === 'rejected')).toBe(true);
  });

  test('a later write asks again, rather than reusing a refusal', async () => {
    warningAnswers.push('Cancel', 'Upload here');
    await expect(ensureRemotePathApproved(destination, remoteFsWith([]))).rejects.toBeTruthy();

    await expect(
      ensureRemotePathApproved(destination, remoteFsWith([]))
    ).resolves.toBeUndefined();
    expect(shownWarnings).toHaveLength(2);
  });
});

describe('declining', () => {
  test('throws rather than returning, so no caller can read it as success', async () => {
    warningAnswers.push('Cancel');

    await expect(ensureRemotePathApproved(destination, remoteFsWith([]))).rejects.toBeInstanceOf(
      DestinationDeclinedError
    );
  });

  test('dismissing the prompt counts as declining', async () => {
    // Closing a modal answers `undefined`, which is not consent.
    warningAnswers.push(undefined);

    await expect(ensureRemotePathApproved(destination, remoteFsWith([]))).rejects.toBeInstanceOf(
      DestinationDeclinedError
    );
  });

  test('nothing is remembered, so the next write asks again', async () => {
    warningAnswers.push('Cancel', 'Cancel');
    await expect(ensureRemotePathApproved(destination, remoteFsWith([]))).rejects.toBeTruthy();
    await expect(ensureRemotePathApproved(destination, remoteFsWith([]))).rejects.toBeTruthy();

    expect(shownWarnings).toHaveLength(2);
    expect(state.size()).toBe(0);
  });
});

describe('resetting', () => {
  test('forgets what was agreed, so every destination asks once more', async () => {
    warningAnswers.push('Upload here');
    await ensureRemotePathApproved(destination, remoteFsWith([]));

    expect(await resetApprovals()).toBe(1);

    warningAnswers.push('Upload here');
    await ensureRemotePathApproved(destination, remoteFsWith([]));
    expect(shownWarnings).toHaveLength(2);
  });
});
