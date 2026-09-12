import * as vscode from 'vscode';
import { showTextDocument } from '../../host';
import { upath } from '../../core';
import UResource from '../../uResource';
import type { ExplorerItem, ExplorerRoot } from './treeDataProvider';

/**
 * Serves the contents of a remote file to the editor, for previewing one
 * without downloading it.
 *
 * This was the tree data provider's second job: it implemented
 * `TreeDataProvider` and `TextDocumentContentProvider` at once, so drawing the
 * tree and fetching file contents shared a file and an event emitter, and its
 * `onDidChange` -- which reads as "the tree changed" -- was in fact the signal
 * that a previewed document had to be re-read.
 */

const PREVIEW_PATH_PREFIX = '/~ ';

/**
 * Rewrites the path so the editor tab shows the file name.
 *
 * There is no API for setting a tab title, and the extension reads the real
 * path out of the query, so the path is free to carry the label instead.
 */
export function previewUrl(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: PREVIEW_PATH_PREFIX + upath.basename(uri.path) });
}

export default class RemoteContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this._changed.event;

  constructor(private readonly _findRoot: (uri: vscode.Uri) => ExplorerRoot | null | undefined) {}

  /** The file behind a preview has changed on the server; re-read it. */
  changed(uri: vscode.Uri): void {
    this._changed.fire(previewUrl(uri));
  }

  dispose(): void {
    this._changed.dispose();
  }

  /** Opens a preview of a listed file. Directories have nothing to show. */
  show(item: ExplorerItem): void {
    if (item.isDirectory) return;
    showTextDocument(previewUrl(item.resource.uri));
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const root = this._findRoot(uri);
    if (!root) {
      throw new Error(`Can't find remote for resource ${uri}.`);
    }

    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const buffer = await remotefs.readFile(UResource.makeResource(uri).fsPath);
    return buffer.toString();
  }
}
