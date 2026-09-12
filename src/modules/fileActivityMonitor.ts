import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import logger from '../logger';
import app from '../app';
import { fileContentCache } from '../core/fileContentCache';
import StatusBarItem from '../ui/statusBarItem';
import { onDidOpenTextDocument, onDidSaveTextDocument, showConfirmMessage } from '../host';
import { readConfigsFromFile } from './config';
import {
  createFileService,
  getFileService,
  findAllFileService,
  disposeFileService,
} from './serviceManager';
import { reportError, isValidFile, isConfigFile, isInWorkspace } from '../helper';
import { downloadFile, uploadFile } from '../fileHandlers';

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

  findAllFileService(service => service.workspace === workspacePath).forEach(disposeFileService);

  try {
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
  try {
    await uploadFile(resolved);
  } catch (error) {
    logger.error(error, `upload ${resolved.fsPath}`);
    app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
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
  const subscriptions = [onDidOpenTextDocument(onOpen), onDidSaveTextDocument(onSave)];
  return vscode.Disposable.from(...subscriptions);
}
