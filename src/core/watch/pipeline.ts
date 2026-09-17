import { decide, type Decision } from './decide';
import type { PendingEvent } from './batch';
import type { PathKey, PathKeyer } from './pathkey';
import type { StateStore, EntryFacts, ContentDigest } from './state';
import { recordFrom, factsMatch } from './state';
import type { ExpectationRegistry } from './expectations';
import type { UploadClaims } from './uploadClaims';
import type { RenameRegistry } from './renames';
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
  /**
   * How many files to examine at once.
   *
   * Deliberately the service's own `concurrency` rather than a separate knob:
   * an independent limit is exactly what left WireFerry with two multiplying
   * budgets and a server refusing connections. Defaults to 1 -- sequential --
   * so a caller that does not pass it cannot accidentally get more parallelism
   * than it asked for.
   */
  concurrency?: number;
  store: StateStore;
  expectations: ExpectationRegistry;
  /** Uploads already under way, so the same bytes are not sent twice. */
  claims: UploadClaims;
  /** Paths renamed away, whose deletion the rename has already carried out. */
  renames: RenameRegistry;
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

  // Hashing is I/O bound, so a large batch -- a checkout touching hundreds of
  // files -- is worth overlapping. The results are collected per event and
  // ordered afterwards, so parallelism does not make the outcome depend on
  // timing.
  const limit = Math.max(1, deps.concurrency ?? 1);
  const indexed = new Array<Outcome | null>(events.length).fill(null);
  let cursor = 0;

  async function examine(event: PendingEvent, slot: number): Promise<void> {
    const startedAt = deps.now();
    const facts = await deps.readFacts(event.path);

    const ignored = deps.isIgnored(event.path);
    const prior = deps.store.get(event.key);
    const selfWrite = ignored
      ? false
      : deps.expectations.consume(event.path, facts).matched;
    const uploadInFlight = ignored ? false : deps.claims.isInFlight(event.path, facts);
    const renamedAway =
      !ignored && event.kind === 'delete' && deps.renames.consume(event.path, deps.now());

    let hashed = false;
    let decision = decide({
      kind: event.kind,
      ignored,
      facts,
      prior,
      selfWrite,
      uploadInFlight,
      renamedAway,
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
            uploadInFlight,
            renamedAway,
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
      indexed[slot] = { key: event.key, path: event.path, decision };
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const slot = cursor++;
      if (slot >= events.length) return;
      await examine(events[slot], slot);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, events.length) }, worker));

  for (const outcome of indexed) {
    if (outcome) outcomes.push(outcome);
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

  // Already recorded, with the facts still matching: there is nothing to learn
  // by reading the file again. This is the same assumption the metadata gate
  // rests on everywhere else, and it matters because two callers now record the
  // same transfer -- the transfer itself, and this pipeline after the upload it
  // asked for returns.
  const existing = deps.store.get(key);
  if (existing && factsMatch(facts, existing)) return;

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
