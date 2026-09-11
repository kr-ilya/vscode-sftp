import * as vscode from 'vscode';
import {
  defaultPort,
  fieldRules,
  type AuthMethod,
  type ConnectionDraft,
} from '../../core/setup/draft';

/**
 * The questions the setup wizard asks.
 *
 * Only the asking lives here; the rules are in src/core/setup/draft.ts and the
 * order of operations -- verify, then store the secret, then write the file --
 * is in ./index.ts. Kept separate so that none of the three is buried in the
 * other two: WireFerry's equivalent is a single 644-line file.
 *
 * Every step can be cancelled, and cancelling anywhere writes nothing.
 */

async function ask(
  prompt: string,
  options: {
    value?: string;
    placeHolder?: string;
    password?: boolean;
    validate?(value: string): string | undefined;
  } = {}
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value: options.value,
    placeHolder: options.placeHolder,
    password: options.password,
    ignoreFocusOut: true,
    validateInput: options.validate,
  });
}

export async function collectDraft(): Promise<ConnectionDraft | undefined> {
  const protocol = await pickProtocol();
  if (!protocol) return undefined;

  const host = await ask('Server hostname or IP address', {
    placeHolder: 'example.com',
    validate: fieldRules.host,
  });
  if (host === undefined) return undefined;

  const portText = await ask('Port', {
    value: String(defaultPort(protocol)),
    validate: fieldRules.port,
  });
  if (portText === undefined) return undefined;

  const username = await ask('Username', { validate: fieldRules.username });
  if (username === undefined) return undefined;

  const authMethod = await pickAuthMethod(protocol);
  if (!authMethod) return undefined;

  let password: string | undefined;
  let privateKeyPath: string | undefined;

  if (authMethod === 'password') {
    password = await ask('Password', { password: true });
    if (password === undefined) return undefined;
  } else if (authMethod === 'privateKey') {
    privateKeyPath = await pickPrivateKey();
    if (!privateKeyPath) return undefined;
  }

  const remotePath = await ask('Remote path to sync with', {
    placeHolder: '/var/www/example.com',
    validate: fieldRules.remotePath,
  });
  if (remotePath === undefined) return undefined;

  const uploadOnSave = await pickUploadOnSave();
  if (uploadOnSave === undefined) return undefined;

  const name = await ask('A name for this connection (optional)', {
    placeHolder: host,
  });
  if (name === undefined) return undefined;

  return {
    name,
    protocol,
    host,
    port: portText.trim() ? Number(portText) : undefined,
    username,
    authMethod,
    password,
    privateKeyPath,
    remotePath,
    uploadOnSave,
  };
}

async function pickProtocol(): Promise<ConnectionDraft['protocol'] | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'SFTP', description: 'over SSH', value: 'sftp' as const },
      { label: 'FTP', description: 'plain or FTPS', value: 'ftp' as const },
    ],
    { placeHolder: 'Protocol', ignoreFocusOut: true }
  );
  return picked?.value;
}

async function pickAuthMethod(
  protocol: ConnectionDraft['protocol']
): Promise<AuthMethod | undefined> {
  if (protocol === 'ftp') return 'password';

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Private key',
        description: 'recommended',
        value: 'privateKey' as const,
      },
      { label: 'Password', value: 'password' as const },
      {
        label: 'SSH agent',
        description: 'uses $SSH_AUTH_SOCK',
        value: 'agent' as const,
      },
    ],
    { placeHolder: 'How to authenticate', ignoreFocusOut: true }
  );
  return picked?.value;
}

async function pickPrivateKey(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Use this key',
    title: 'Select your private key',
  });
  return picked?.[0]?.fsPath;
}

async function pickUploadOnSave(): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'upload explicitly', value: false },
      { label: 'Yes', description: 'upload every time a file is saved', value: true },
    ],
    { placeHolder: 'Upload on save?', ignoreFocusOut: true }
  );
  return picked?.value;
}
