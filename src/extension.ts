'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import app from './app';
import initCommands from './initCommands';
import { installLogSink, disposeOutput } from './ui/output';
import { installCoreHost } from './modules/coreHost';
import { initializeWatching } from './modules/watch/watcherService';
import { disposeWatchOutput } from './modules/watch/output';
import { initializeHostKeys } from './modules/ssh/hostKeys';
import { initializeCredentials } from './modules/credentials';
import { initializeRemotePathApproval } from './modules/remotePathApproval';
import { reportError } from './helper';
import { monitorFileActivity } from './modules/fileActivityMonitor';
import { tryLoadConfigs } from './modules/config';
import { getAllFileService, createFileService, disposeFileService } from './modules/serviceManager';
import { getWorkspaceFolders, setContextValue } from './host';
import RemoteExplorer from './modules/remoteExplorer';

async function setupWorkspaceFolder(dir) {
  const configs = await tryLoadConfigs(dir);
  configs.forEach(config => {
    createFileService(config, dir);
  });
}

function setup(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
  return Promise.all(workspaceFolders.map(folder => setupWorkspaceFolder(folder.uri.fsPath)));
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  // First thing: point the core logger at the output channel and flush whatever
  // it buffered while modules were initialising.
  installLogSink();
  installCoreHost();
  // Change-detection state is persisted under the extension's storage, so the
  // watcher needs the context before any service is created.
  initializeWatching(context);
  initializeHostKeys(context);
  initializeCredentials(context);
  initializeRemotePathApproval(context);

  try {
    initCommands(context);
  } catch (error) {
    reportError(error, 'initCommands');
  }

  const workspaceFolders = getWorkspaceFolders();
  if (!workspaceFolders) {
    return;
  }

  setContextValue('enabled', true);
  app.sftpBarItem.show();
  // Everything with a lifetime goes on the subscription list, so the host
  // releases it on deactivation and a second activation starts clean.
  context.subscriptions.push(
    monitorFileActivity(),
    app.sftpBarItem,
    app.transferProgress,
    { dispose: disposeOutput },
    { dispose: disposeWatchOutput }
  );
  app.state.subscribe(_ => {
    const currentText = app.sftpBarItem.getText();
    // current is showing profile
    if (currentText.startsWith('SyncX')) {
      app.sftpBarItem.reset();
    }
    if (app.remoteExplorer) {
      app.remoteExplorer.refresh();
    }
    // A profile can override `watcher` and `ignore`, and change-detection state
    // is kept per profile -- one file legitimately has different state for
    // different servers. Upstream froze the watcher config in the constructor,
    // so switching profiles left the previous profile's watcher running.
    for (const service of getAllFileService()) {
      try {
        service.reloadWatcher();
      } catch (error) {
        reportError(error, 'reloadWatcher');
      }
    }
  });
  try {
    await setup(workspaceFolders);
    app.remoteExplorer = new RemoteExplorer(context);
  } catch (error) {
    reportError(error);
  }
}

export function deactivate() {
  // Everything registered on context.subscriptions is disposed by the host;
  // the services are ours to close.
  getAllFileService().forEach(disposeFileService);
}
