import { describe, test, expect, beforeEach, vi } from 'vitest';

/**
 * Creating an entry on the server is a write, and asks like one.
 *
 * It did not. The guard was wired into the two transfer handlers only, while
 * the watcher creates directories *before* it uploads anything -- so with a
 * mistyped `remotePath` the first thing to reach the server was a `mkdir` that
 * nobody had approved, and the prompt came afterwards.
 */

vi.mock('../../src/modules/serviceManager', () => ({
  getFileService: () => undefined,
}));

import { warningAnswers, shownWarnings } from '../fakes/vscode';
import { initializeRemotePathApproval } from '../../src/modules/remotePathApproval';
import { DestinationDeclinedError } from '../../src/helper';
import { createRemoteFile, createRemoteFolder } from '../../src/fileHandlers/create';

/** Records what was asked of the server, so "nothing happened" is checkable. */
function remoteFs() {
  const created: string[] = [];
  return {
    created,
    fs: {
      mkdir: async (path: string) => void created.push(`dir ${path}`),
      open: async (path: string) => {
        created.push(`file ${path}`);
        return 1;
      },
      close: async () => undefined,
      lstat: async () => {
        throw new Error('ENOENT');
      },
      list: async () => [],
    },
  };
}

function context(fs: unknown) {
  return {
    fileService: { getRemoteFileSystem: async () => fs },
    config: {
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/srv/www/site',
    },
    target: { localFsPath: 'D:\\work\\site\\new', remoteFsPath: '/srv/www/site/new' },
  } as never;
}

beforeEach(() => {
  warningAnswers.length = 0;
  shownWarnings.length = 0;
  const values = new Map<string, unknown>();
  initializeRemotePathApproval({
    globalState: {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => void values.set(key, value),
      keys: () => [...values.keys()],
    },
  } as never);
});

describe('createRemoteFolder', () => {
  test('asks before the first one at a destination', async () => {
    warningAnswers.push('Upload here');
    const remote = remoteFs();

    await createRemoteFolder(context(remote.fs));

    expect(shownWarnings).toHaveLength(1);
    expect(remote.created).toEqual(['dir /srv/www/site/new']);
  });

  test('creates nothing when the destination is declined', async () => {
    warningAnswers.push('Cancel');
    const remote = remoteFs();

    await expect(createRemoteFolder(context(remote.fs))).rejects.toBeInstanceOf(
      DestinationDeclinedError
    );
    expect(remote.created).toEqual([]);
  });
});

describe('createRemoteFile', () => {
  test('creates nothing when the destination is declined', async () => {
    warningAnswers.push('Cancel');
    const remote = remoteFs();

    await expect(createRemoteFile(context(remote.fs))).rejects.toBeInstanceOf(
      DestinationDeclinedError
    );
    expect(remote.created).toEqual([]);
  });
});
