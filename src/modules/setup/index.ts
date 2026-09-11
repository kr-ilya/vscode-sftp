import * as vscode from 'vscode';
import * as path from 'path';
import * as fse from 'fs-extra';
import logger from '../../logger';
import { CONFIG_PATH } from '../../constants';
import { showTextDocument } from '../../host';
import { draftToConfig, draftToConnectOption, validateDraft } from '../../core/setup/draft';
import type { ConnectionDraft } from '../../core/setup/draft';
import { credentialStore } from '../credentials';
import { collectDraft } from './prompt';
import { verifyConnection } from './verify';

/**
 * Creating a configuration, in the order that cannot leave a mess.
 *
 *   collect -> verify the connection -> store the secret -> write the file
 *
 * Upstream writes a placeholder config immediately and leaves the user to find
 * out whether any of it works by trying to upload something. Verifying first
 * means a config file only ever exists once its contents are known to connect,
 * and a password is only kept once it is known to be the right one.
 *
 * Nothing is written if any step is cancelled.
 */
export async function runSetup(workspaceFolder: string): Promise<void> {
  const configPath = path.join(workspaceFolder, CONFIG_PATH);

  if (await fse.pathExists(configPath)) {
    const choice = await vscode.window.showWarningMessage(
      'This folder already has a SyncX configuration.',
      { modal: true, detail: configPath },
      'Open it',
      'Replace it'
    );
    if (choice === 'Open it') {
      await showTextDocument(vscode.Uri.file(configPath));
      return;
    }
    if (choice !== 'Replace it') return;
  }

  const draft = await collectDraft();
  if (!draft) return;

  const invalid = validateDraft(draft);
  if (invalid) {
    // The wizard must not be able to produce a file the extension then refuses
    // to load.
    await vscode.window.showErrorMessage(`SyncX: ${invalid.message}`);
    return;
  }

  if (!(await confirmConnection(draft))) return;

  await persistSecret(draft);
  await writeConfig(configPath, draft);
  await showTextDocument(vscode.Uri.file(configPath));
}

/** Tries the connection, and lets the user save anyway if it fails. */
async function confirmConnection(draft: ConnectionDraft): Promise<boolean> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${draft.host}...` },
    () => verifyConnection(draft.protocol, draftToConnectOption(draft))
  );

  if (result.ok) return true;

  // Offered rather than enforced: a server that is temporarily down should not
  // stop someone writing a configuration they know is right.
  const choice = await vscode.window.showWarningMessage(
    `Could not connect to ${draft.host}.`,
    { modal: true, detail: result.message },
    'Save anyway',
    'Go back'
  );
  return choice === 'Save anyway';
}

/**
 * Puts the password in secret storage rather than in the config file.
 *
 * Reached only after the connection succeeded, so what is stored is known to
 * work.
 */
async function persistSecret(draft: ConnectionDraft): Promise<void> {
  if (draft.authMethod !== 'password' || !draft.password) return;

  await credentialStore.store(
    {
      protocol: draft.protocol,
      host: draft.host.trim(),
      port: draft.port ?? (draft.protocol === 'ftp' ? 21 : 22),
      username: draft.username.trim(),
    },
    'password',
    draft.password
  );
}

async function writeConfig(configPath: string, draft: ConnectionDraft): Promise<void> {
  const config = draftToConfig(draft);
  await fse.outputJson(configPath, config, { spaces: 2 });
  logger.info(`[setup] wrote ${configPath}`);
}
