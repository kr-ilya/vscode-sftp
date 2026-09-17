import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import logger from '../logger';
import app from '../app';
import { fileContentCache } from '../core/fileContentCache';
import StatusBarItem from '../ui/statusBarItem';
import {
  onDidOpenTextDocument,
  onDidRenameFiles,
  onDidSaveTextDocument,
  showConfirmMessage,
} from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import {
  reportError,
  isValidFile,
  isConfigFile,
  isInWorkspace,
  DestinationDeclinedError,
} from '../helper';
import { downloadFile, renameRemote, uploadFile } from '../fileHandlers';
import { claimUpload, recordRename, type UploadOutcome } from './watch/watcherService';

/**
 * Reacts to documents being saved and opened.
 *
 * Both subscriptions are returned as one disposable rather than kept in module
 * state: the open-document listener used to be registered and never released,
 * so it outlived deactivation and a second activation added another.
 */

async function handleConfigSave(uri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;

  try {
    // Inside the try: disposing resolves each configuration, and a
    // configuration being edited is routinely unresolvable. Thrown from out
    // here it left the workspace with some services removed and none rebuilt.
    findAllFileService(service => service.workspace === workspacePath).forEach(disposeFileService);
    const configs = await readConfigsFromFile(uri.fsPath);
    configs.forEach(config => createFileService(config, workspacePath));
  } catch (error) {
    reportError(error);
  } finally {
    await app.remoteExplorer.refresh();
  }
}

async function handleFileSave(uri: vscode.Uri): Promise<void> {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  if (!fileService.getConfig().uploadOnSave) {
    return;
  }

  // Through any symbolic links, so the path matches the one the watcher and
  // the change tracker know the file by.
  let resolved = uri;
  try {
    resolved = vscode.Uri.file(realpathSync.native(uri.fsPath));
  } catch (error) {
    // The file can be gone again by the time this runs; the upload below will
    // report that properly. Upstream called this outside any try and awaited a
    // synchronous function, so the rejection had nowhere to go.
    logger.debug(`[file-save] could not resolve ${uri.fsPath}`, error);
  }

  logger.info(`[file-save] ${resolved.fsPath}`);

  // The same save also reaches the watcher as a file-system event. Claiming the
  // upload lets its gate recognise these bytes as already on their way; without
  // it the file goes twice whenever the transfer outlasts the batching window.
  const claim = await claimUpload(resolved.fsPath);
  let outcome: UploadOutcome = 'failed';
  try {
    await uploadFile(resolved);
    outcome = 'uploaded';
  } catch (error) {
    if (error instanceof DestinationDeclinedError) {
      // The user was asked where this was going and said no. Nothing failed,
      // so the status bar is left alone and the guard's own log line stands.
      outcome = 'declined';
    } else {
      logger.error(error, `upload ${resolved.fsPath}`);
      app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    }
  } finally {
    claim.release(outcome);
  }
}

async function downloadOnOpen(uri: vscode.Uri): Promise<void> {
  const fileService = getFileService(uri);
  if (!fileService) {
    return;
  }

  const { downloadOnOpen: mode } = fileService.getConfig();
  if (!mode) {
    return;
  }

  if (mode === 'confirm' && !(await showConfirmMessage('Do you want SyncX to download this file?'))) {
    return;
  }

  logger.info(`[file-open] ${uri.fsPath}`);
  try {
    await downloadFile(uri);
  } catch (error) {
    logger.error(error, `download ${uri.fsPath}`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
  }
}

/**
 * Mirrors a rename onto the server, instead of sending the file again.
 *
 * Renaming in the editor reaches the watcher as a deletion and a creation. Left
 * to those, the file is uploaded a second time under its new name -- and, where
 * `autoDelete` is on, the deletion of the old name arrives afterwards and can
 * undo the move entirely. One `rename` on the server does the whole thing, and
 * costs one round trip rather than the size of the file.
 *
 * Only where the extension is already mirroring changes by itself. With neither
 * `uploadOnSave` nor a watcher, nothing else here touches the server without
 * being asked, and a rename should not be the exception.
 */
async function handleRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const fileService = getFileService(oldUri);
  if (!fileService) {
    return;
  }

  const config = fileService.getConfig();
  const mirrors = Boolean(config.uploadOnSave || config.watcher?.autoUpload);
  if (!mirrors) {
    return;
  }

  logger.info(`[rename] ${oldUri.fsPath} -> ${newUri.fsPath}`);
  try {
    await renameRemote(oldUri, { newLocalPath: newUri.fsPath });
  } catch (error) {
    // Deliberately nothing is recorded: the old path is still on the server,
    // and the deletion the watcher is about to report means what it says.
    logger.error(error, `rename ${oldUri.fsPath}`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
    return;
  }

  recordRename(oldUri.fsPath, newUri.fsPath);
}

function onRename(event: vscode.FileRenameEvent): void {
  for (const { oldUri, newUri } of event.files) {
    if (!isValidFile(oldUri) || !isInWorkspace(oldUri.fsPath)) continue;
    void handleRename(oldUri, newUri).catch(error => reportError(error, 'on rename'));
  }
}

/** A document the extension has anything to say about. */
function isWatchedDocument(document: vscode.TextDocument): boolean {
  return isValidFile(document.uri) && isInWorkspace(document.uri.fsPath);
}

function onSave(document: vscode.TextDocument): void {
  if (!isWatchedDocument(document)) {
    return;
  }

  // The config file and the ssh config are read through this cache.
  fileContentCache.delete(document.uri.fsPath);

  const handled = isConfigFile(document.uri)
    ? handleConfigSave(document.uri)
    : handleFileSave(document.uri);

  // Deliberately not awaited -- the editor does not wait for us -- but a
  // rejection has to reach the log rather than the host's unhandled handler.
  void handled.catch(error => reportError(error, 'on save'));
}

function onOpen(document: vscode.TextDocument): void {
  if (!isWatchedDocument(document)) {
    return;
  }

  void downloadOnOpen(document.uri).catch(error => reportError(error, 'on open'));
}

/** Subscribes to the editor. Dispose to unsubscribe. */
export function monitorFileActivity(): vscode.Disposable {
  const subscriptions = [
    onDidOpenTextDocument(onOpen),
    onDidSaveTextDocument(onSave),
    onDidRenameFiles(onRename),
  ];
  return vscode.Disposable.from(...subscriptions);
}
