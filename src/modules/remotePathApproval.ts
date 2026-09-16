import * as vscode from 'vscode';
import logger from '../logger';
import {
  assessRemotePath,
  describeDestination,
  destinationKey,
  type RemoteDestination,
} from '../core/remotePathGuard';
import type { FileSystem } from '../core';
import { DestinationDeclinedError } from '../helper';

/**
 * Asks once, before the first write to a destination.
 *
 * The prompt shows what is actually at the target path. A list beginning `bin,
 * boot, dev, etc` tells the user they are about to write into the server root
 * far more plainly than any warning could, and does so even when the path looks
 * unremarkable -- which is the case a heuristic cannot catch.
 *
 * Declining throws. It used to answer `false` and let the caller return
 * quietly, which the watcher could not tell apart from a finished upload: it
 * recorded the file as being on the server, and then skipped every later event
 * for it at the metadata gate.
 */

const APPROVAL_PREFIX = 'syncx.remotePathApproved:';

let memento: vscode.Memento | null = null;

export function initializeRemotePathApproval(context: vscode.ExtensionContext): void {
  // Global rather than workspace state: the question is whether this config
  // points where it was meant to, which is the same answer from every window.
  memento = context.globalState;
}

/** How many entries to name in the prompt before summarising the rest. */
const SAMPLE_SIZE = 8;

/**
 * Questions already on screen, so one destination is asked about once.
 *
 * A batch is carried out several files at a time, and every one of them checks
 * the destination before writing. Without this the first batch into a new
 * destination would stack up one prompt per file in flight -- all of them the
 * same question.
 */
const asking = new Map<string, Promise<void>>();

export function ensureRemotePathApproved(
  destination: RemoteDestination,
  remoteFs: FileSystem
): Promise<void> {
  if (!memento) return Promise.resolve();

  const key = APPROVAL_PREFIX + destinationKey(destination);
  if (memento.get<boolean>(key)) return Promise.resolve();

  const open = asking.get(key);
  if (open) return open;

  const question = ask(destination, remoteFs, key, memento).finally(() => asking.delete(key));
  asking.set(key, question);
  return question;
}

async function ask(
  destination: RemoteDestination,
  remoteFs: FileSystem,
  key: string,
  store: vscode.Memento
): Promise<void> {
  const assessment = assessRemotePath(destination.remotePath);
  const contents = await describeContents(destination.remotePath, remoteFs);

  const detail = [
    assessment.reason,
    contents,
    'This is asked once per destination.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const choice = await vscode.window.showWarningMessage(
    `Upload to ${describeDestination(destination)}?`,
    // A system path gets a modal: it is the case where continuing by reflex
    // does real damage.
    { modal: assessment.risk === 'system', detail },
    'Upload here',
    'Cancel'
  );

  if (choice !== 'Upload here') {
    logger.info(`[guard] upload to ${describeDestination(destination)} declined`);
    throw new DestinationDeclinedError(describeDestination(destination));
  }

  await store.update(key, true);
}

/** Reads the destination so the user can recognise it, or say it is empty. */
async function describeContents(remotePath: string, remoteFs: FileSystem): Promise<string> {
  try {
    const entries = await remoteFs.list(remotePath);
    if (entries.length === 0) {
      return 'The directory is empty.';
    }

    const names = entries.map(entry => entry.name).sort();
    const shown = names.slice(0, SAMPLE_SIZE).join(', ');
    const rest = names.length > SAMPLE_SIZE ? `, and ${names.length - SAMPLE_SIZE} more` : '';
    return `It currently contains ${names.length} entries: ${shown}${rest}`;
  } catch {
    // Not being able to look is not a reason to refuse -- the directory may
    // simply not exist yet, which is normal for a first deployment.
    return 'The directory does not exist yet, or could not be listed.';
  }
}

/** Forgets every approval, so the next upload asks again. */
export async function resetApprovals(): Promise<number> {
  if (!memento) return 0;

  const keys = memento.keys().filter(key => key.startsWith(APPROVAL_PREFIX));
  for (const key of keys) {
    await memento.update(key, undefined);
  }
  return keys.length;
}
