import { decide, type Decision } from './decide';
import type { PendingEvent } from './batch';
import type { PathKey, PathKeyer } from './pathkey';
import type { StateStore, EntryFacts, ContentDigest } from './state';
import { recordFrom } from './state';
import type { ExpectationRegistry } from './expectations';
import type { WatchPolicy } from './policy';
import { countDecision, type TraceEntry, type WatchCounters } from './diagnostics';

/**
 * Runs a batch of events through the gate.
 *
 * This is where the two-pass shape of `decide` is used: the gate is asked once
 * with only the cheap facts, and asked again with a content digest only if it
 * says it needs one. Nothing reads a file that the metadata gate already
 * settled -- which is the whole reason the cheap gate exists.
 *
 * It performs no transfers. It returns what should happen and leaves acting on
 * it to the caller, which is what lets the same code back a dry run.
 */

export interface PipelineDeps {
  store: StateStore;
  expectations: ExpectationRegistry;
  keyer: PathKeyer;
  policy: WatchPolicy;
  isIgnored(path: string): boolean;
  readFacts(path: string): Promise<EntryFacts>;
  readDigest(path: string): Promise<ContentDigest>;
  now(): number;
  onTrace?(entry: TraceEntry): void;
  counters?: WatchCounters;
}

export interface Outcome {
  key: PathKey;
  path: string;
  decision: Decision;
}

/**
 * @param apply when false, the store is left untouched -- used by the dry run,
 * so that asking "what would you upload?" does not change what happens next.
 */
export async function processBatch(
  events: PendingEvent[],
  deps: PipelineDeps,
  apply = true
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];

  for (const event of events) {
    const startedAt = deps.now();
    const facts = await deps.readFacts(event.path);

    const ignored = deps.isIgnored(event.path);
    const prior = deps.store.get(event.key);
    const selfWrite = ignored
      ? false
      : deps.expectations.consume(event.path, facts).matched;

    let hashed = false;
    let decision = decide({
      kind: event.kind,
      ignored,
      facts,
      prior,
      selfWrite,
      policy: deps.policy,
    });

    if (decision.action === 'hash-required') {
      hashed = true;
      let digest: ContentDigest | undefined;
      try {
        digest = await deps.readDigest(event.path);
      } catch {
        // Unreadable at this instant -- being written, or permissions. Send it
        // rather than guess: a spurious upload is recoverable, a silently
        // skipped one leaves the server wrong with no signal.
        digest = undefined;
      }

      decision = digest
        ? decide({
            kind: event.kind,
            ignored,
            facts,
            prior,
            selfWrite,
            content: digest,
            policy: deps.policy,
          })
        : { action: 'upload' };

      // Content matched what we already had: refresh the cheap facts so the
      // next event for this file is settled without reading it again.
      if (apply && decision.action === 'record-only' && digest) {
        deps.store.set(event.key, recordFrom(facts, digest, deps.now()));
      }
    }

    const trace: TraceEntry = {
      path: event.path,
      kind: event.kind,
      decision,
      eventCount: event.count,
      hashed,
      elapsedMs: deps.now() - startedAt,
    };
    deps.onTrace?.(trace);
    if (deps.counters) countDecision(deps.counters, trace);

    if (
      decision.action === 'upload' ||
      decision.action === 'delete-remote' ||
      decision.action === 'ensure-directory'
    ) {
      outcomes.push({ key: event.key, path: event.path, decision });
    }
  }

  return outcomes;
}

/**
 * Records that a path now matches what is on the server.
 *
 * Called after a transfer succeeds, so the next event for the file is settled
 * by the cheap gate. A failed transfer deliberately leaves no record: the file
 * stays "not known to match", and the next event tries again.
 */
export async function recordSynced(
  key: PathKey,
  path: string,
  deps: Pick<PipelineDeps, 'store' | 'readFacts' | 'readDigest' | 'now'>
): Promise<void> {
  const facts = await deps.readFacts(path);
  if (facts.type !== 'file') return;
  try {
    const digest = await deps.readDigest(path);
    deps.store.set(key, recordFrom(facts, digest, deps.now()));
  } catch {
    // Leave it unknown rather than record something unverified.
  }
}

/** Forgets a path, after it has been removed remotely. */
export function forget(key: PathKey, store: StateStore): void {
  store.delete(key);
}
