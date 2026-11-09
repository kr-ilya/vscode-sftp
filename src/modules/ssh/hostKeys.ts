import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fse from 'fs-extra';
import * as vscode from 'vscode';
import logger from '../../logger';
import {
  parseKnownHosts,
  formatKnownHostLine,
  hostPattern,
  readKeyType,
  type KnownHostEntry,
} from '../../core/ssh/knownHosts';
import {
  decideHostKey,
  type HostKeyOutcome,
  type HostKeyRequest,
} from '../../core/ssh/hostKeyDecision';
import { createSerialQueue } from '../../core/util/serialQueue';

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
const storeWrites = createSerialQueue();
const REMOVE_KEY = 'Remove old key from SyncX';

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

async function loadEntries(files: string[]): Promise<KnownHostEntry[]> {
  const groups = await Promise.all(files.map(readEntries));
  return groups.flat();
}

type HostKey = Omit<HostKeyRequest, 'entries'>;

async function remember(file: string, { host, port, keyType, key }: HostKey): Promise<void> {
  const line = formatKnownHostLine(host, port, keyType, key);
  try {
    await storeWrites.run(async () => {
      await fse.ensureFile(file);
      const content = await fse.readFile(file, 'utf8');
      const separator = content && !content.endsWith('\n') ? '\n' : '';
      await fse.appendFile(file, `${separator}${line}\n`);
    });
    logger.info(`[hostkey] recorded ${keyType} key for ${host}:${port} in ${file}`);
  } catch (error) {
    // Failing to record is not a reason to fail the connection the user just
    // approved; they will simply be asked again next time.
    logger.warn(`[hostkey] could not record the key in ${file}`, error);
  }
}

function canRemove(file: string, expected: readonly KnownHostEntry[]): boolean {
  // A line with aliases or patterns can also pin keys for other hosts.
  return expected.every(entry =>
    entry.source === file &&
    (entry.hashed || (entry.patterns.length === 1 && !/[!*?]/.test(entry.patterns[0])))
  );
}

function forget(file: string, request: HostKey, expected: readonly KnownHostEntry[]): Promise<boolean> {
  return storeWrites.run(async () => {
    const content = await fse.readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const entries = [...await loadEntries(systemStorePaths()), ...parseKnownHosts(content, file)];
    const current = decideHostKey({ ...request, entries });
    if (current.action !== 'refuse' || !current.expected || !canRemove(file, current.expected)) {
      return false;
    }

    // Recompute the line numbers and require the same old keys the user saw.
    // A different key may have been recorded while the dialog was open.
    const lines = content.split(/(?<=\n)/);
    if (current.expected.some(entry =>
      lines[entry.line - 1].trimStart().startsWith('@') ||
      !expected.some(previous => previous.key.equals(entry.key))
    )) {
      return false;
    }
    const removed = new Set(current.expected.map(entry => entry.line));
    const updated = lines.filter((_, index) => !removed.has(index + 1)).join('');

    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(updated, 'utf8');
      } finally {
        await handle.close();
      }
      // Another window or a manual edit can change the file outside our queue.
      if (await fse.readFile(file, 'utf8') !== content) return false;
      await fse.rename(temporary, file);
      return true;
    } finally {
      await fse.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') logger.warn(`[hostkey] could not remove ${temporary}`, error);
      });
    }
  });
}

async function showRefusal(
  file: string,
  request: HostKey,
  outcome: Extract<HostKeyOutcome, { action: 'refuse' }>
): Promise<void> {
  const { title, expected } = outcome;
  let detail = outcome.detail;
  const removable = expected && canRemove(file, expected);
  if (removable) {
    detail += '\n\nIf you know the change is legitimate, remove the old key from SyncX. ' +
      'Then connect again and verify the new fingerprint before accepting it.';
  } else if (expected) {
    const target = hostPattern(request.host, request.port);
    detail += `\n\nIf you know the change is legitimate, update the conflicting entries for ${target} ` +
      'in the files shown above, then connect again and verify the new fingerprint.';
  }
  logger.error(`[hostkey] ${title}\n${detail}`);
  const actions = removable ? [REMOVE_KEY] : [];
  const choice = await vscode.window.showErrorMessage(title, { modal: true, detail }, ...actions);
  if (choice !== REMOVE_KEY || !removable) return;

  let removed: boolean;
  try {
    removed = await forget(file, request, expected);
  } catch (error) {
    logger.error(`[hostkey] could not update ${file}`, error);
    await vscode.window.showErrorMessage(`SyncX could not remove the old host key from ${file}.`);
    return;
  }
  if (removed) {
    logger.info(`[hostkey] removed old key for ${request.host}:${request.port} from ${file}`);
  }
  await vscode.window.showInformationMessage(removed
    ? 'SyncX removed the old host key. Connect again and verify the new fingerprint.'
    : 'SyncX could not safely remove the old host key. Check the recorded entries and connect again.'
  );
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
        const file = ourStorePath();
        const request = { host, port, keyType, key };
        const entries = await loadEntries([...systemStorePaths(), file]);
        const outcome = decideHostKey({ ...request, entries });

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
          void showRefusal(file, request, outcome).catch(error => {
            logger.error('[hostkey] could not show the host key refusal', error);
          });
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
          await remember(file, request);
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
