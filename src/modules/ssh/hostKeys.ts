import * as os from 'node:os';
import * as path from 'node:path';
import * as fse from 'fs-extra';
import * as vscode from 'vscode';
import logger from '../../logger';
import {
  parseKnownHosts,
  formatKnownHostLine,
  readKeyType,
  type KnownHostEntry,
} from '../../core/ssh/knownHosts';
import { decideHostKey } from '../../core/ssh/hostKeyDecision';

/**
 * Host key verification, wired to the user's real OpenSSH configuration.
 *
 * Upstream passes ssh2 neither `hostVerifier` nor `hostHash`, so every key is
 * accepted silently and the SSH handshake is open to a machine-in-the-middle.
 * WireFerry is the same. This closes that.
 *
 * The user's own `~/.ssh/known_hosts` is the source of truth. A host they have
 * already accepted in a terminal is not asked about again, and a key they have
 * removed is not quietly re-accepted here. Keys accepted through this extension
 * go to a separate file, in the same format, because writing into somebody's
 * ~/.ssh from an editor extension is not ours to do.
 */

let storageDir: vscode.Uri | null = null;

export function initializeHostKeys(context: vscode.ExtensionContext): void {
  storageDir = context.globalStorageUri;
}

function ourStorePath(): string {
  const base = storageDir?.fsPath ?? path.join(os.homedir(), '.syncx');
  return path.join(base, 'known_hosts');
}

function systemStorePaths(): string[] {
  const sshDir = path.join(os.homedir(), '.ssh');
  return [
    path.join(sshDir, 'known_hosts'),
    path.join(sshDir, 'known_hosts2'),
    // The system-wide file, where an administrator pins hosts for everyone.
    process.platform === 'win32'
      ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'ssh_known_hosts')
      : '/etc/ssh/ssh_known_hosts',
  ];
}

async function readEntries(file: string): Promise<KnownHostEntry[]> {
  try {
    const content = await fse.readFile(file, 'utf8');
    return parseKnownHosts(content, file);
  } catch {
    // Absent or unreadable is normal; most machines have only one of these.
    return [];
  }
}

async function loadAllEntries(): Promise<KnownHostEntry[]> {
  const files = [...systemStorePaths(), ourStorePath()];
  const groups = await Promise.all(files.map(readEntries));
  return groups.flat();
}

async function remember(host: string, port: number, keyType: string, key: Buffer): Promise<void> {
  const file = ourStorePath();
  const line = formatKnownHostLine(host, port, keyType, key);
  try {
    await fse.ensureFile(file);
    await fse.appendFile(file, `${line}\n`);
    logger.info(`[hostkey] recorded ${keyType} key for ${host}:${port} in ${file}`);
  } catch (error) {
    // Failing to record is not a reason to fail the connection the user just
    // approved; they will simply be asked again next time.
    logger.warn(`[hostkey] could not record the key in ${file}`, error);
  }
}

/**
 * Builds the `hostVerifier` ssh2 expects.
 *
 * ssh2 hands the raw key blob when `hostHash` is unset, which is what we want:
 * the fingerprint is computed here, in OpenSSH's own format, so the user can
 * compare it against `ssh-keygen -lf`.
 */
export function createHostVerifier(
  host: string,
  port: number
): (key: Buffer, callback: (accepted: boolean) => void) => void {
  return (key, callback) => {
    void (async () => {
      try {
        // The key blob starts with a length-prefixed algorithm name; that name
        // is what known_hosts records.
        const keyType = readKeyType(key);
        if (!keyType) {
          logger.error('[hostkey] the server sent a key blob we cannot parse; refusing');
          callback(false);
          return;
        }
        const entries = await loadAllEntries();
        const outcome = decideHostKey({ host, port, keyType, key, entries });

        if (outcome.action === 'accept') {
          logger.info(`[hostkey] ${host}:${port} accepted: ${outcome.reason}`);
          callback(true);
          return;
        }

        if (outcome.action === 'refuse') {
          // Deliberately not downgraded to a notification. sftp-neo throws here
          // and then catches its own error into showWarningMessage, so a
          // changed host key -- the one signal that matters -- arrives as a
          // dismissible toast. Refusing is the whole point.
          logger.error(`[hostkey] ${outcome.title}\n${outcome.detail}`);
          void vscode.window.showErrorMessage(outcome.title, { modal: true, detail: outcome.detail });
          callback(false);
          return;
        }

        const choice = await vscode.window.showWarningMessage(
          outcome.title,
          { modal: true, detail: outcome.detail },
          'Connect and remember',
          'Connect once'
        );

        if (choice === 'Connect and remember') {
          await remember(host, port, keyType, key);
          callback(true);
        } else if (choice === 'Connect once') {
          callback(true);
        } else {
          logger.info(`[hostkey] ${host}:${port} rejected by the user`);
          callback(false);
        }
      } catch (error) {
        // An error deciding must fail closed. Accepting an unverified key
        // because our own code broke would defeat the feature entirely.
        logger.error(error, '[hostkey] verification failed');
        callback(false);
      }
    })();
  };
}
