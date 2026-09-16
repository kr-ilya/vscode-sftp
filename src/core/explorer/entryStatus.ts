import type { EntryFacts, StateRecord } from '../watch/state';
import { factsMatch } from '../watch/state';

/**
 * How a file on the server stands against the copy on disk.
 *
 * The remote explorer has never said anything about this: it listed names, and
 * whether any of them differed from the local tree was for the user to guess.
 *
 * The order of questions is the watcher's gate, for the same reason -- cheap
 * facts first, content only when the cheap ones are inconclusive and the answer
 * is already at hand. What is deliberately absent is a way to settle content by
 * reading the server: hashing a remote file means either downloading it or
 * running a command on it, per file, for a badge. So when the facts cannot
 * settle it, this says so rather than guessing, and `unverified` is a real
 * answer rather than a euphemism for "same".
 */

export type EntryStatus =
  /** No local counterpart: on the server only. */
  | 'remote-only'
  /** Known to differ -- the sizes disagree, or the local file has since changed. */
  | 'different'
  /** Facts agree and nothing contradicts them. */
  | 'same'
  /** Sizes agree, times do not, and nothing available can settle the content. */
  | 'unverified'
  /** Not a comparable pair -- a directory, a symlink, a socket. */
  | 'not-applicable';

export interface RemoteEntryFacts {
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  /** Epoch milliseconds, as the transports report it. */
  mtime: number;
}

export interface StatusInput {
  remote: RemoteEntryFacts;
  /** `missing` when there is no local counterpart. */
  local: EntryFacts;
  /**
   * What was last recorded as synced for the local path, when the change
   * tracker has it. Present only where a watcher is configured, so it refines
   * the answer and is never required for one.
   */
  record?: StateRecord;
}

export interface StatusVerdict {
  status: EntryStatus;
  /** Why, in the words the tooltip uses. */
  reason: string;
}

/**
 * Modification times are compared in whole seconds.
 *
 * FTP reports minutes or seconds depending on the listing format, SFTP reports
 * seconds, and local file systems report milliseconds. Comparing at the
 * coarsest common granularity is what the existing sync code does, and
 * comparing any finer would mark every file different.
 */
function sameSecond(a: number, b: number): boolean {
  return Math.floor(a / 1000) === Math.floor(b / 1000);
}

export function compareEntry({ remote, local, record }: StatusInput): StatusVerdict {
  if (remote.type !== 'file') {
    return { status: 'not-applicable', reason: `${remote.type}, not a file` };
  }

  if (local.type === 'missing') {
    return { status: 'remote-only', reason: 'no local copy' };
  }

  if (local.type !== 'file') {
    return { status: 'not-applicable', reason: `local entry is a ${local.type}` };
  }

  if (local.size !== remote.size) {
    return {
      status: 'different',
      reason: `sizes differ: ${local.size} locally, ${remote.size} on the server`,
    };
  }

  // Same size and the same second: nothing left that could disagree without
  // one of the two having been edited to exactly the same length within the
  // same second, which the record below would still catch.
  if (sameSecond(local.mtimeMs, remote.mtime)) {
    return { status: 'same', reason: 'size and modification time match' };
  }

  if (record) {
    // The record says what was last put on the server. If the local file still
    // matches it, the local side has not moved -- so the newer timestamp is the
    // server's, and the content is still ours.
    if (factsMatch(local, record)) {
      return { status: 'same', reason: 'unchanged since the last transfer' };
    }
    return { status: 'different', reason: 'the local file has changed since the last transfer' };
  }

  return {
    status: 'unverified',
    reason: 'sizes match but modification times do not, and the content was not compared',
  };
}
