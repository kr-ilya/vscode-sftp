import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as querystring from 'node:querystring';

vi.mock('../../src/modules/serviceManager', () => ({
  getAllFileService: () => [],
}));

import { Uri, inputBoxAnswers } from '../fakes/vscode';
import { promptForNewEntryUri } from '../../src/commands/shared';
import UResource from '../../src/uResource';

/**
 * Where "New File" and "New Folder" put the name the user typed.
 *
 * Both commands appended it to `parent.toString()`. A remote URI keeps its path
 * in the query string, so the name landed *after* the query: the entry was
 * created at the folder's own path, the typed name was lost entirely, and
 * `remoteId` came back with a `/name` suffix stuck to it.
 */

const remoteFolder = () =>
  UResource.makeResource({
    remote: { host: 'example.com', port: 22 },
    fsPath: '/root/site',
    remoteId: 7,
  }).uri;

const queryOf = (uri: { query: string }) => querystring.parse(uri.query);

beforeEach(() => {
  inputBoxAnswers.length = 0;
});

describe('a remote folder', () => {
  test('the new entry is inside it, under the name that was typed', async () => {
    inputBoxAnswers.push('notes.txt');

    const created = await promptForNewEntryUri(remoteFolder() as never, 'name');

    expect(queryOf(created!).fsPath).toBe('/root/site/notes.txt');
  });

  test('it still belongs to the same service', async () => {
    // remoteId used to come back as "7/notes.txt", which parseInt then truncated
    // back to 7 by luck rather than by design.
    inputBoxAnswers.push('notes.txt');

    const created = await promptForNewEntryUri(remoteFolder() as never, 'name');

    expect(queryOf(created!).remoteId).toBe('7');
  });
});

describe('a local folder', () => {
  test('the name is joined onto the path', async () => {
    inputBoxAnswers.push('notes.txt');

    const created = await promptForNewEntryUri(Uri.file('/work/site') as never, 'name');

    expect(created!.path).toBe('/work/site/notes.txt');
  });
});

describe('when there is nothing to create', () => {
  test('a cancelled prompt creates nothing', async () => {
    expect(await promptForNewEntryUri(remoteFolder() as never, 'name')).toBeUndefined();
  });

  test('a blank name creates nothing', async () => {
    // "" passed the old `!== undefined` check and produced a path ending in a
    // separator.
    inputBoxAnswers.push('   ');

    expect(await promptForNewEntryUri(remoteFolder() as never, 'name')).toBeUndefined();
  });

  test('no target creates nothing', async () => {
    expect(await promptForNewEntryUri([] as never, 'name')).toBeUndefined();
  });
});

describe('a multi-selection', () => {
  test('creates one entry, in the first folder', async () => {
    // The old code stringified the whole array into one URI.
    inputBoxAnswers.push('notes.txt');
    const first = remoteFolder();

    const created = await promptForNewEntryUri([first, remoteFolder()] as never, 'name');

    expect(queryOf(created!).fsPath).toBe('/root/site/notes.txt');
  });
});
