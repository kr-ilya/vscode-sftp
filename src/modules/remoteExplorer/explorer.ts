import * as vscode from 'vscode';
import { registerCommand } from '../../host';
import {
  COMMAND_REMOTEEXPLORER_REFRESH,
  COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE,
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
} from '../../constants';
import UResource from '../../uResource';
import { toRemotePath } from '../../helper';
import { REMOTE_SCHEME } from '../../constants';
import { getFileService } from '../serviceManager';
import RemoteTreeDataProvider, { ExplorerItem } from './treeDataProvider';
import RemoteDecorationProvider from './decorations';
import RemoteContentProvider from './contentProvider';

export default class RemoteExplorer {
  private _explorerView: vscode.TreeView<ExplorerItem>;
  private _treeDataProvider: RemoteTreeDataProvider;
  private _decorations: RemoteDecorationProvider;
  private _content: RemoteContentProvider;

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new RemoteTreeDataProvider();
    this._content = new RemoteContentProvider(uri => this._treeDataProvider.findRoot(uri));
    context.subscriptions.push(
      this._content,
      vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, this._content),
      // The tree knows which files were re-listed; the content provider is what
      // re-reads them for anything previewing one.
      this._treeDataProvider.onDidChangeFile(uri => this._content.changed(uri)),
      // Badges follow the listing, not the request for one: firing them when
      // refresh() returns would re-ask before the new facts had arrived.
      this._treeDataProvider.onDidUpdateEntries(uris => this._decorations.refresh(uris))
    );

    // Decorations read the facts the tree already fetched, rather than listing
    // the directory again for every badge.
    this._decorations = new RemoteDecorationProvider(uri => this._treeDataProvider.findEntry(uri));
    context.subscriptions.push(
      this._decorations,
      vscode.window.registerFileDecorationProvider(this._decorations)
    );

    this._explorerView = vscode.window.createTreeView('syncx.remoteExplorer', {
      showCollapseAll: true,
      treeDataProvider: this._treeDataProvider,
      canSelectMany: true,
    });

    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH, () => this._refreshSelection());
    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH_ACTIVE_FILE, () => this._refreshActiveRemoteFile());
    registerCommand(context, COMMAND_REMOTEEXPLORER_VIEW_CONTENT, (item: ExplorerItem) =>
      this._content.show(item)
    );
  }

  refresh(item?: ExplorerItem): Promise<void> {
    if (item && !UResource.isRemote(item.resource.uri)) {
      const uri = item.resource.uri;
      const fileService = getFileService(uri);
      if (!fileService) {
        throw new Error(`Config Not Found. (${uri.toString(true)})`);
      }
      const config = fileService.getConfig();
      const localPath = item.resource.fsPath;
      const remotePath = toRemotePath(localPath, config.context, config.remotePath);
      item.resource = UResource.makeResource({
        remote: {
          host: config.host,
          port: config.port,
        },
        fsPath: remotePath,
        remoteId: fileService.id,
      });
    }

    return this._treeDataProvider.refresh(item);
  }

  reveal(item: ExplorerItem): Thenable<void> {
    return item ? this._explorerView.reveal(item) : Promise.resolve();
  }

  findRoot(remoteUri: vscode.Uri) {
    return this._treeDataProvider.findRoot(remoteUri);
  }

  private async _refreshSelection(): Promise<void> {
    if (this._explorerView.selection.length) {
      await Promise.all(this._explorerView.selection.map(item => this.refresh(item)));
      return;
    }
    await this.refresh();
  }

  private async _refreshActiveRemoteFile(): Promise<void> {
    const focusedEditor = vscode.window.activeTextEditor;
    if (!focusedEditor) {
      return;
    }

    const remoteFileUri = focusedEditor.document.uri;
    const root = this._treeDataProvider.findRoot(remoteFileUri);
    if (!root) {
      return;
    }

    await this.refresh({
      resource: UResource.updateResource(root.resource, {
        remotePath: UResource.makeResource(remoteFileUri).fsPath,
      }),
      isDirectory: false,
    });
  }
}
