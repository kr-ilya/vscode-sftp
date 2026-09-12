import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

/**
 * Refreshing the tree after an operation must not fail the operation.
 *
 * Every successful save ends with a targeted refresh of the file that was just
 * uploaded. That refresh needs to find the service the file belongs to, and
 * there are two ordinary reasons it cannot: the view has never been opened, so
 * no tree has been built; or the configuration was reloaded, which drops the
 * cached tree and gives every service a new id. Both threw
 * "Can't find config for remote resource ..." -- and since no caller awaits the
 * refresh, it arrived as an unhandled rejection on top of an upload that had
 * worked. Reported from live use: an error after every save.
 */

const services: FakeFileService[] = [];

vi.mock('../../src/modules/serviceManager', () => ({
  getAllFileService: () => services,
}));

import UResource from '../../src/uResource';
import { FileType } from '../../src/core';
import RemoteTreeData, { type ExplorerItem } from '../../src/modules/remoteExplorer/treeDataProvider';

const HOST = 'example.com';
const PORT = 22;
const REMOTE_PATH = '/root/site';
const LOCAL_BASE = path.join('D:', 'work', 'site');

class FakeFileService {
  listed: string[] = [];
  // The service's base directory, which is the workspace folder when the
  // configuration has no explicit `context`.
  readonly baseDir = LOCAL_BASE;
  /** What list() answers with; tests replace it to simulate a changed server. */
  entries: Array<Record<string, unknown>> = [];

  constructor(readonly id: number, readonly name = `service-${id}`) {}

  getConfig() {
    return {
      host: HOST,
      port: PORT,
      remotePath: REMOTE_PATH,
      remoteExplorer: { order: 0, filesExclude: [] },
    };
  }

  async getRemoteFileSystem() {
    return {
      list: async (path: string) => {
        this.listed.push(path);
        return this.entries;
      },
    };
  }
}

/** The item a completed upload hands to the tree, as src/fileHandlers/shared.ts builds it. */
function uploadedFile(remoteId: number, fsPath = `${REMOTE_PATH}/1.txt`): ExplorerItem {
  return {
    resource: UResource.makeResource({
      remote: { host: HOST, port: PORT },
      fsPath,
      remoteId,
    }),
    isDirectory: false,
  };
}

function collectFolderRefreshes(tree: RemoteTreeData): ExplorerItem[] {
  const fired: ExplorerItem[] = [];
  tree.onDidChangeTreeData(item => fired.push(item));
  return fired;
}

beforeEach(() => {
  services.length = 0;
  services.push(new FakeFileService(1));
});

describe('a targeted refresh with no tree to update', () => {
  test('does not throw when the view has never been opened', async () => {
    const tree = new RemoteTreeData();

    await expect(tree.refresh(uploadedFile(1))).resolves.toBeUndefined();
  });

  test('does not ask the server for anything', async () => {
    // There is nothing on screen to redraw, so a round trip would be pure cost.
    const tree = new RemoteTreeData();

    await tree.refresh(uploadedFile(1));

    expect(services[0].listed).toEqual([]);
  });

  test('does not throw after the configuration is reloaded', async () => {
    // Reloading .vscode/sftp.json fires a full refresh, which drops the cached
    // tree. This is the reported sequence: reload, then save.
    const tree = new RemoteTreeData();
    await tree.getChildren();
    await tree.refresh();

    await expect(tree.refresh(uploadedFile(1))).resolves.toBeUndefined();
  });
});

describe('a targeted refresh for a service the tree does not know', () => {
  test('refreshes the whole tree instead of throwing', async () => {
    // A reload gives every service a new id, so a path captured before it still
    // carries the old one. The tree is what is out of date.
    const tree = new RemoteTreeData();
    await tree.getChildren();
    const fired = collectFolderRefreshes(tree);

    await expect(tree.refresh(uploadedFile(99))).resolves.toBeUndefined();

    expect(fired).toEqual([undefined]);
  });
});

describe('a targeted refresh that can be honoured', () => {
  test('still redraws the folder the file is in', async () => {
    const tree = new RemoteTreeData();
    const [root] = await tree.getChildren();
    const fired = collectFolderRefreshes(tree);

    await tree.refresh(uploadedFile(1));

    expect(fired).toEqual([root]);
  });
});

describe('the facts behind the badges', () => {
  const listing = (size: number) => [
    {
      name: '1.txt',
      fspath: `${REMOTE_PATH}/1.txt`,
      type: FileType.File,
      size,
      mtime: 1_700_000_000_000,
      atime: 1_700_000_000_000,
      mode: 0o644,
    },
  ];

  test('listing a directory announces the entries it produced', async () => {
    // Badges are asked for when this fires, not when a refresh is requested:
    // a refresh only tells the view to re-fetch, and the answer arrives later.
    services[0].entries = listing(10);
    const tree = new RemoteTreeData();
    const announced: string[][] = [];
    tree.onDidUpdateEntries(uris => announced.push(uris.map(uri => uri.query)));

    const [root] = await tree.getChildren();
    await tree.getChildren(root);

    expect(announced).toHaveLength(1);
    expect(announced[0]).toHaveLength(1);
  });

  test('a second listing replaces the facts rather than keeping the first ones', async () => {
    // The item is reused so the view keeps its identity, which is why the facts
    // have to be overwritten explicitly -- otherwise a file that changed on the
    // server keeps the size it had when the folder was first opened.
    services[0].entries = listing(10);
    const tree = new RemoteTreeData();
    const [root] = await tree.getChildren();
    const [file] = await tree.getChildren(root);

    services[0].entries = listing(99);
    await tree.getChildren(root);

    expect(tree.findEntry(file.resource.uri)?.entry.size).toBe(99);
  });

  test('an entry the tree has never listed has no facts', async () => {
    const tree = new RemoteTreeData();
    await tree.getChildren();

    expect(tree.findEntry(uploadedFile(1).resource.uri)).toBeUndefined();
  });
});

describe('where the local counterpart is', () => {
  test('it is derived from the service base, not from the optional context', async () => {
    // `context` is optional in .vscode/sftp.json, and when it is absent the
    // base is the workspace folder. Reading it from the config handed
    // `undefined` to path.join for every ordinary configuration -- which is to
    // say, for most of them.
    services[0].entries = [
      {
        name: '1.txt',
        fspath: `${REMOTE_PATH}/1.txt`,
        type: FileType.File,
        size: 10,
        mtime: 0,
        atime: 0,
        mode: 0o644,
      },
    ];
    const tree = new RemoteTreeData();
    const [root] = await tree.getChildren();
    const [file] = await tree.getChildren(root);

    expect(tree.findEntry(file.resource.uri)?.localPath).toBe(path.join(LOCAL_BASE, '1.txt'));
  });
});
