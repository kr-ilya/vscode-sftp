import * as path from 'path';
import { Uri, window } from 'vscode';
import { FileType, upath } from '../core';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerItem } from '../modules/remoteExplorer';
import UResource from '../uResource';
import { getActiveTextEditor } from '../host';
import { listFiles, toLocalPath, simplifyPath } from '../helper';

function configIngoreFilterCreator(config) {
  if (!config || !config.ignore) {
    return;
  }

  return file => !config.ignore(file.fsPath);
}

function createFileSelector(filterCreator?) {
  return async (): Promise<Uri | undefined> => {
    const remoteItems = getAllFileService().map((fileService, index) => {
      const config = fileService.getConfig();
      return {
        name: config.name || config.remotePath,
        description: config.host,
        fsPath: config.remotePath,
        type: FileType.Directory,
        filter: filterCreator ? filterCreator(config) : undefined,
        getFs: () => fileService.getRemoteFileSystem(config),
        index,
        remoteBaseDir: config.remotePath,
        baseDir: fileService.baseDir,
      };
    });

    const selected = await listFiles(remoteItems);

    if (!selected) {
      return;
    }

    const rootItem = remoteItems[selected.index];
    const localTarget = toLocalPath(selected.fsPath, rootItem.remoteBaseDir, rootItem.baseDir);

    return Uri.file(localTarget);
  };
}

export function selectContext(): Promise<Uri | undefined> {
  return new Promise<Uri | undefined>((resolve, reject) => {
    const sercives = getAllFileService();
    const projectsList = sercives
      .map(service => ({
        value: service.baseDir,
        label: service.name || simplifyPath(service.baseDir),
        description: '',
        detail: service.baseDir,
      }))
      .sort((l, r) => l.label.localeCompare(r.label));

    window
      .showQuickPick(projectsList, {
        placeHolder: 'Select a folder...',
      })
      .then(selection => {
        if (selection) {
          return resolve(Uri.file(selection.value));
        }

        // cancel selection
        resolve(undefined);
      }, reject);
  });
}

export function applySelector<T>(...selectors: ((...args: any[]) => T | Promise<T>)[]) {
  return function combinedSelector(this: any, ...args: any[]): T | Promise<T> {
    let result;
    for (const selector of selectors) {
      result = selector.apply(this, args);
      if (result) {
        break;
      }
    }

    return result;
  };
}

export function uriFromfspath(fileList: string[]): Uri[] | undefined {
  if (!Array.isArray(fileList) || typeof fileList[0] !== 'string') {
    return;
  }

  return fileList.map(file => Uri.file(file));
}

export function getActiveDocumentUri() {
  const active = getActiveTextEditor();
  if (!active || !active.document) {
    return;
  }

  return active.document.uri;
}

export function getActiveFolder() {
  const uri = getActiveDocumentUri();
  if (!uri) {
    return;
  }

  return Uri.file(path.dirname(uri.fsPath));
}

// selected file or activeTarget or configContext
export function uriFromExplorerContextOrEditorContext(item, items): undefined | Uri | Uri[] {
  // from explorer or editor context
  if (item instanceof Uri) {
    if (Array.isArray(items) && items[0] instanceof Uri) {
      // multi-select in explorer
      return items;
    } else {
      return item;
    }
  } else if ((item as ExplorerItem).resource) {
    // from remote explorer
    if (Array.isArray(items) && (items[0] as ExplorerItem).resource) {
      // multi-select in remote explorer
      return items.map(_ => _.resource.uri);
    } else {
      return item.resource.uri;
    }
  }

  return;
}

// selected folder or configContext
export function selectFolderFallbackToConfigContext(item, items): Promise<undefined | Uri | Uri[]> {
  // from explorer or editor context
  if (item) {
    if (item instanceof Uri) {
      if (Array.isArray(items) && items[0] instanceof Uri) {
        // multi-select in explorer
        return Promise.resolve(items);
      } else {
        return Promise.resolve(item);
      }
    } else if ((item as ExplorerItem).resource) {
      // from remote explorer
      return Promise.resolve(item.resource.uri);
    }
  }

  return selectContext();
}

// selected file from all remote files
export const selectFileFromAll = createFileSelector();

// selected file from remote files expect ignored
export const selectFile = createFileSelector(configIngoreFilterCreator);

/**
 * Asks for a name and returns the URI of an entry with that name inside
 * `parent`.
 *
 * The name cannot simply be appended to `parent.toString()`. A remote URI keeps
 * its path in the query string, so appending landed the name *after* the query
 * -- the created entry got the folder's own path and the typed name was lost,
 * while `remoteId` picked up a `/name` suffix. Each scheme has to be extended
 * where it actually keeps its path.
 */
export async function promptForNewEntryUri(
  parent: Uri | Uri[],
  prompt: string
): Promise<Uri | undefined> {
  // Creating one entry inside several folders at once has no meaning; the
  // clicked item comes first.
  const target = Array.isArray(parent) ? parent[0] : parent;
  if (!target) {
    return undefined;
  }

  const name = (await window.showInputBox({ prompt }))?.trim();
  if (!name) {
    return undefined;
  }

  if (UResource.isRemote(target)) {
    const resource = UResource.makeResource(target);
    return UResource.updateResource(resource, {
      remotePath: upath.join(resource.fsPath, name),
    }).uri;
  }

  return Uri.joinPath(target, name);
}
