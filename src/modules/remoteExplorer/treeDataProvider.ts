import * as vscode from 'vscode';
import {
  upath,
  FileService,
  FileType,
  FileEntry,
  Ignore,
  ServiceConfig,
} from '../../core';
import UResource, { Resource } from '../../uResource';
import {
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
  COMMAND_REMOTEEXPLORER_EDITINLOCAL,
} from '../../constants';
import { toLocalPath } from '../../helper';
import { getAllFileService } from '../serviceManager';
import { getExtensionSetting } from '../ext';

type Id = number;

const DEFAULT_FILES_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store'];

interface ExplorerChild {
  resource: Resource;
  isDirectory: boolean;
  /**
   * The listing entry this item came from, kept so decorations can judge the
   * file without listing the directory a second time. Absent on roots, which
   * come from the configuration rather than from a listing.
   */
  entry?: FileEntry;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    fileService: FileService;
    config: ServiceConfig;
    id: Id;
  };
}

export type ExplorerItem = ExplorerRoot | ExplorerChild;

function dirFirstSort(fileA: ExplorerItem, fileB: ExplorerItem) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resource.fsPath.localeCompare(fileB.resource.fsPath);
  }

  return fileA.isDirectory ? -1 : 1;
}

export default class RemoteTreeData implements vscode.TreeDataProvider<ExplorerItem> {
  private _roots: ExplorerRoot[] | null = null;
  private _rootsMap: Map<Id, ExplorerRoot> | null = null;
  private _map = new Map<vscode.Uri['query'], ExplorerItem>();

  private _onDidChangeFolder: vscode.EventEmitter<ExplorerItem> = new vscode.EventEmitter<
    ExplorerItem
  >();
  private _onDidChangeFile: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData: vscode.Event<ExplorerItem> = this._onDidChangeFolder.event;
  /**
   * A listed file's contents may have changed, so anything previewing it has to
   * re-read. Answered by RemoteContentProvider, which is what actually fetches
   * the bytes.
   */
  readonly onDidChangeFile: vscode.Event<vscode.Uri> = this._onDidChangeFile.event;
  private _onDidUpdateEntries: vscode.EventEmitter<vscode.Uri[]> = new vscode.EventEmitter<
    vscode.Uri[]
  >();
  /**
   * A directory has been listed and the facts held for its entries replaced.
   *
   * This, rather than the refresh that asked for the listing, is when anything
   * judging those files has to look again: a refresh only tells the view to
   * re-fetch, and the answer arrives later.
   */
  readonly onDidUpdateEntries: vscode.Event<vscode.Uri[]> = this._onDidUpdateEntries.event;

  async refresh(item?: ExplorerItem): Promise<any> {
    // refresh root
    if (!item) {
      // clear cache
      this._roots = null;
      this._rootsMap = null;

      this._onDidChangeFolder.fire(undefined as any);
      return;
    }

    // A targeted refresh needs the item's root, and there are two ordinary
    // reasons for it to be missing. Neither is a failure of the operation that
    // asked for the refresh, yet both used to reach the user as
    // "Can't find config for remote resource ..." after every successful save.
    if (!this._rootsMap) {
      // Nothing has been built yet: either the view has never been opened, or
      // the configuration was reloaded and dropped the cached tree. It will be
      // rebuilt from the current configuration when the view next asks.
      return;
    }

    if (!this.findRoot(item.resource.uri)) {
      // The resource names a service the tree does not know. Reloading the
      // configuration gives every service a new id, so a path captured before
      // the reload still carries the old one. The tree is what is out of date,
      // so refresh all of it rather than reporting an error.
      return this.refresh();
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);

      // refresh top level files as well
      const children = await this.getChildren(item);
      children
        .filter(i => !i.isDirectory)
        .forEach(i => this._onDidChangeFile.fire(i.resource.uri));
    } else {
      const parent = await this.getParent(item);
      if (parent) {
        this._onDidChangeFolder.fire(parent);
      }
      this._onDidChangeFile.fire(item.resource.uri);
    }
  }

  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    const isRoot = (item as ExplorerRoot).explorerContext !== undefined;
    let customLabel;
    if (isRoot) {
      customLabel = (item as ExplorerRoot).explorerContext.fileService.name;
    }
    if (!customLabel) {
      customLabel = upath.basename(item.resource.fsPath);
    }
    return {
      label: customLabel,
      resourceUri: item.resource.uri,
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: isRoot ? 'root' : item.isDirectory ? 'folder' : 'file',
      command: item.isDirectory
        ? undefined
        : {
            command: getExtensionSetting().downloadWhenOpenInRemoteExplorer
              ? COMMAND_REMOTEEXPLORER_EDITINLOCAL
              : COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
            arguments: [item],
            title: 'View Remote Resource',
          },
    };
  }

  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      return this._getRoots();
    }

    const root = this.findRoot(item.resource.uri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resource.uri}.`);
    }
    const config = root.explorerContext.config;
    const remotefs = await root.explorerContext.fileService.getRemoteFileSystem(config);
    const fileEntries = await remotefs.list(item.resource.fsPath);

    const filesExcludeList: string[] =
      config.remoteExplorer && config.remoteExplorer.filesExclude
        ? config.remoteExplorer.filesExclude.concat(DEFAULT_FILES_EXCLUDE)
        : DEFAULT_FILES_EXCLUDE;

    const ignore = new Ignore(filesExcludeList);
    function filterFile(file: FileEntry) {
      const relativePath = upath.relative(config.remotePath, file.fspath);
      return !ignore.ignores(relativePath);
    }

    const children = fileEntries
      .filter(filterFile)
      .map(file => {
        const isDirectory = file.type === FileType.Directory;
        const newResource = UResource.updateResource(item.resource, {
          remotePath: file.fspath,
        });
        const mapItem = this._map.get(newResource.uri.query);
        if (mapItem) {
          // The listing is fresh and the facts are not part of the item's
          // identity, so take the new ones rather than keeping whatever was
          // true the last time this folder was opened.
          mapItem.entry = file;
          return mapItem;
        }

        const newItem: ExplorerChild = { resource: newResource, isDirectory, entry: file };
        this._map.set(newItem.resource.uri.query, newItem);
        return newItem;
      })
      .sort(dirFirstSort);

    this._onDidUpdateEntries.fire(children.map(child => child.resource.uri));
    return children;
  }

  async getParent(item: ExplorerChild): Promise<ExplorerItem> {
    const resourceUri = item.resource.uri;
    const root = this.findRoot(resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${resourceUri}.`);
    }

    if (item.resource.fsPath === root.resource.fsPath) {
      return root;
    }

    const fspath = upath.dirname(item.resource.fsPath);
    const newResource = UResource.updateResource(item.resource, {
      remotePath: fspath,
    });
    const mapItem = this._map.get(newResource.uri.query);
    if (mapItem) {
      return mapItem;
    } else {
      const newMapItem = {
        resource: newResource,
        isDirectory: true,
      };
      this._map.set(newResource.uri.query, newMapItem);
      await this.getChildren(newMapItem);
      return newMapItem;
    }
  }

  /**
   * What is known about a listed file, and where its local counterpart would
   * be. Supplied to the decoration provider, which has only a URI to go on.
   */
  findEntry(uri: vscode.Uri): { entry: FileEntry; localPath: string } | undefined {
    const item = this._map.get(uri.query);
    const root = this.findRoot(uri);
    if (!item || !item.entry || !root) return undefined;

    // The service's own base directory, not `config.context`: context is
    // optional in the configuration file, and when it is absent the base is the
    // workspace folder. Reading it from the config would hand `undefined` to
    // path.join for every ordinary configuration.
    const { config, fileService } = root.explorerContext;
    return {
      entry: item.entry,
      localPath: toLocalPath(item.resource.fsPath, config.remotePath, fileService.baseDir),
    };
  }

  findRoot(uri: vscode.Uri): ExplorerRoot | null | undefined {
    if (!this._rootsMap) {
      return null;
    }

    // A local URI carries no service id, so there is no root to find -- which
    // is a legitimate answer rather than a lookup with `undefined` as the key.
    const rootId = UResource.makeResource(uri).remoteId;
    return rootId === undefined ? undefined : this._rootsMap.get(rootId);
  }

  private _getRoots(): ExplorerRoot[] {
    if (this._roots) {
      return this._roots;
    }

    this._roots = [];
    this._rootsMap = new Map();
    this._map = new Map();
    getAllFileService().forEach(fileService => {
      const config = fileService.getConfig();
      const id = fileService.id;
      const item = {
        resource: UResource.makeResource({
          remote: {
            host: config.host,
            port: config.port,
          },
          fsPath: config.remotePath,
          remoteId: id,
        }),
        isDirectory: true,
        explorerContext: {
          fileService,
          config,
          id,
        },
      };
      this._roots!.push(item);
      this._rootsMap!.set(id, item);
      this._map.set(item.resource.uri.query, item);
    });
    this._roots.sort((a,b) => a.explorerContext.config.remoteExplorer.order - b.explorerContext.config.remoteExplorer.order || a.explorerContext.fileService.name.localeCompare(b.explorerContext.fileService.name));
    return this._roots;
  }
}
