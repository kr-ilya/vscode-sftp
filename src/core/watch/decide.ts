import type { EntryFacts, StateRecord, ContentDigest } from './state';
import { factsMatchRecord } from './state';
import type { WatchPolicy } from './policy';

/**
 * The gate: given everything known about one file-system event, decide what to
 * do about it.
 *
 * The governing rule is that **a file-system event is never sufficient grounds
 * to upload**. It is only a reason to look. Upstream and both forks treat the
 * event itself as the decision -- an event arrives, the file goes to the server
 * -- with no comparison of any kind anywhere on the watcher's path. That is why
 * a project re-uploads itself while no file has changed.
 *
 * Pure by construction: no file system, no clock, no editor. Stat results and
 * content digests are inputs, so every branch below is directly testable.
 */

export type EventKind = 'create' | 'change' | 'delete';

export interface GateInput {
  kind: EventKind;
  /** True when the path matched the configured ignore rules. */
  ignored: boolean;
  facts: EntryFacts;
  /** What we last knew about this path, if anything. */
  prior: StateRecord | undefined;
  /** Whether this event is explained by a write the extension made itself. */
  selfWrite: boolean;
  /** Present only on the second pass, once the caller has hashed the file. */
  content?: ContentDigest;
  policy: WatchPolicy;
}

export type Decision =
  /** Do nothing; `reason` explains which gate stopped it. */
  | { action: 'skip'; reason: SkipReason }
  /** Metadata changed, so the content must be hashed and the gate re-run. */
  | { action: 'hash-required' }
  /** Content is unchanged: refresh the stored metadata, send nothing. */
  | { action: 'record-only' }
  | { action: 'upload' }
  | { action: 'delete-remote' }
  /** A directory appeared; make sure it exists remotely, but do not walk it. */
  | { action: 'ensure-directory' };

export type SkipReason =
  | 'ignored'
  | 'auto-upload-disabled'
  | 'auto-delete-disabled'
  | 'self-write'
  | 'unchanged-metadata'
  | 'directory-change'
  | 'symlink'
  | 'unsupported-entry'
  | 'vanished';

export function decide(input: GateInput): Decision {
  const { kind, ignored, facts, prior, selfWrite, content, policy } = input;

  // Gate 1: ignore rules, applied before anything reads the disk or the network.
  if (ignored) return { action: 'skip', reason: 'ignored' };

  // --- deletions take a different path: there is nothing left to compare ---
  if (kind === 'delete' || facts.type === 'missing') {
    if (!policy.autoDelete) return { action: 'skip', reason: 'auto-delete-disabled' };
    if (kind !== 'delete') return { action: 'skip', reason: 'vanished' };
    return { action: 'delete-remote' };
  }

  if (!policy.autoUpload) return { action: 'skip', reason: 'auto-upload-disabled' };

  // Gate 2: what kind of entry is this?
  //
  // This is the fix for the defect that motivated the rewrite. `isValidFile`
  // checked only that the URI scheme was `file`, so a directory URI reached
  // `upload()`, which lstat'd it, saw a directory, and recursively re-uploaded
  // every descendant with no comparison at all. One event on a directory =
  // the whole subtree re-sent; one event on the workspace root = the whole
  // project. Neither fork guards against this either.
  if (facts.type === 'directory') {
    // A directory's own metadata changes whenever a child is added or removed.
    // That says nothing about whether any child's *content* changed, and the
    // children have their own events.
    if (kind !== 'create') return { action: 'skip', reason: 'directory-change' };
    return { action: 'ensure-directory' };
  }

  if (facts.type === 'symlink' && !policy.followSymlinks) {
    return { action: 'skip', reason: 'symlink' };
  }

  if (facts.type !== 'file' && facts.type !== 'symlink') {
    return { action: 'skip', reason: 'unsupported-entry' };
  }

  // Gate 3: is this our own write coming back at us?
  if (selfWrite) return { action: 'skip', reason: 'self-write' };

  // Nothing known about this path: it is genuinely new, so send it. An empty
  // store does not mean "upload everything" -- it is seeded from disk on first
  // use, so by the time events flow, known files have records.
  if (!prior) {
    return { action: 'upload' };
  }

  // Gate 4: cheap facts, no disk read. This is what absorbs the bulk of the
  // noise -- chmod and utimes (which surface as IN_ATTRIB on Linux and as a
  // LAST_WRITE notification on Windows), repeated events for one save, and
  // whole-tree re-emission after the watcher restarts.
  if (factsMatchRecord(facts, prior)) {
    return { action: 'skip', reason: 'unchanged-metadata' };
  }

  // Gate 5: the content itself. Reached only when metadata moved, so the cost
  // is amortised.
  if (!content) return { action: 'hash-required' };

  // A record written under a different algorithm cannot be compared; treat it
  // as a change rather than guessing.
  if (content.algorithm === prior.algorithm && content.hash === prior.hash) {
    // The bytes are identical: `touch`, a rewrite with the same contents, a
    // `git checkout` that restored what was already there. Refresh the
    // metadata so the cheap gate catches it next time, and send nothing.
    return { action: 'record-only' };
  }

  return { action: 'upload' };
}

/** True for decisions that put bytes on the network. */
export function isTransfer(decision: Decision): boolean {
  return decision.action === 'upload' || decision.action === 'delete-remote';
}
