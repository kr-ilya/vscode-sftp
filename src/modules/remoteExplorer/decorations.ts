import * as vscode from 'vscode';
import { FileType, type FileEntry } from '../../core';
import { readFacts } from '../../core/watch/facts';
import { compareEntry, type StatusVerdict } from '../../core/explorer/entryStatus';
import { findSyncedRecord } from '../watch/watcherService';
import { REMOTE_SCHEME } from '../../constants';

/**
 * Badges on the remote explorer saying how each file stands against the local
 * tree.
 *
 * The judgement is not made here: `core/explorer/entryStatus` makes it, with
 * the watcher's own order of questions, and this only fetches what that needs
 * and turns the answer into something the explorer can draw.
 *
 * Only differences get a badge. A file we cannot compare gets none -- the
 * explanation goes in the tooltip instead of on the screen, because the case
 * exists in bulk (an FTP server without MFMT preserves no modification times at
 * all) and a tree of question marks says nothing anybody can act on.
 */

/** Where the facts for a listed remote file come from. */
export interface EntrySource {
  (uri: vscode.Uri): { entry: FileEntry; localPath: string } | undefined;
}

export default class RemoteDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._changed.event;

  constructor(private readonly _source: EntrySource) {}

  /**
   * The facts behind these badges have moved; omit the argument for all of them.
   */
  refresh(uris?: vscode.Uri | vscode.Uri[]): void {
    this._changed.fire(uris);
  }

  dispose(): void {
    this._changed.dispose();
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== REMOTE_SCHEME) return undefined;

    const found = this._source(uri);
    if (!found) return undefined;

    const { entry, localPath } = found;
    if (entry.type !== FileType.File) return undefined;

    const verdict = compareEntry({
      remote: { type: 'file', size: entry.size, mtime: entry.mtime },
      local: await readFacts(localPath),
      record: findSyncedRecord(localPath),
    });

    return decorationFor(verdict);
  }
}

// Colours are built here rather than held in module constants: a constant runs
// at import time, and loading the bundle must not depend on the editor API
// being there -- which is exactly what the packaged smoke test checks.
function decorationFor(verdict: StatusVerdict): vscode.FileDecoration | undefined {
  switch (verdict.status) {
    case 'different':
      return {
        badge: 'M',
        color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
        tooltip: `Differs from the local file — ${verdict.reason}`,
      };
    case 'remote-only':
      return {
        badge: '↓',
        color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
        tooltip: 'On the server only — there is no local copy',
      };
    case 'unverified':
      // No badge: this is "nobody checked", not "something is wrong", and on a
      // server that does not preserve modification times it would be every file.
      return { tooltip: `Not compared — ${verdict.reason}` };
    case 'same':
      return { tooltip: `Matches the local file — ${verdict.reason}` };
    default:
      return undefined;
  }
}
