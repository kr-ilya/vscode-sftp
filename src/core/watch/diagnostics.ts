import type { Decision, EventKind } from './decide';

/**
 * A record of why each event was or was not acted on, and running totals.
 *
 * None of the three repositories has anything like this. That is not a
 * cosmetic gap: the reported symptom -- "the project re-uploads itself and no
 * file has changed" -- is unfalsifiable without it. There is no way to tell
 * whether an event arrived, what the file looked like when it did, or which
 * stage let it through. Every diagnosis in this fork so far came from reading
 * source rather than from the extension being able to say what it did.
 *
 * Pure: the sink is injected, so this can be asserted on in tests.
 */

export interface TraceEntry {
  path: string;
  kind: EventKind;
  decision: Decision;
  /** How many raw events collapsed into this one. */
  eventCount: number;
  /** Whether the file's content had to be read. */
  hashed: boolean;
  /** Milliseconds spent deciding, including any hashing. */
  elapsedMs: number;
}

export interface WatchCounters {
  eventsReceived: number;
  batches: number;
  decided: number;
  hashed: number;
  uploaded: number;
  deleted: number;
  directoriesEnsured: number;
  recordedOnly: number;
  skipped: Record<string, number>;
}

export function createCounters(): WatchCounters {
  return {
    eventsReceived: 0,
    batches: 0,
    decided: 0,
    hashed: 0,
    uploaded: 0,
    deleted: 0,
    directoriesEnsured: 0,
    recordedOnly: 0,
    skipped: {},
  };
}

export function countDecision(counters: WatchCounters, entry: TraceEntry): void {
  counters.decided += 1;
  if (entry.hashed) counters.hashed += 1;

  switch (entry.decision.action) {
    case 'upload':
      counters.uploaded += 1;
      break;
    case 'delete-remote':
      counters.deleted += 1;
      break;
    case 'ensure-directory':
      counters.directoriesEnsured += 1;
      break;
    case 'record-only':
      counters.recordedOnly += 1;
      break;
    case 'skip': {
      const reason = entry.decision.reason;
      counters.skipped[reason] = (counters.skipped[reason] ?? 0) + 1;
      break;
    }
    case 'hash-required':
      // Not a terminal decision; the caller hashes and decides again.
      break;
  }
}

/** One line per decision, in the form the output channel shows. */
export function formatTrace(entry: TraceEntry): string {
  const { decision } = entry;
  const outcome =
    decision.action === 'skip' ? `skip (${decision.reason})` : decision.action;
  const collapsed = entry.eventCount > 1 ? ` x${entry.eventCount}` : '';
  const gate = entry.hashed ? 'metadata+content' : 'metadata';
  return `${entry.kind}${collapsed} ${entry.path} -> ${gate} -> ${outcome} [${entry.elapsedMs}ms]`;
}

export function formatCounters(counters: WatchCounters): string {
  const skipped = Object.entries(counters.skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `    ${reason}: ${n}`)
    .join('\n');

  return [
    'Change detection, this session:',
    `  events received: ${counters.eventsReceived} in ${counters.batches} batch(es)`,
    `  decisions:       ${counters.decided}`,
    `  files hashed:    ${counters.hashed}`,
    `  uploaded:        ${counters.uploaded}`,
    `  deleted:         ${counters.deleted}`,
    `  dirs ensured:    ${counters.directoriesEnsured}`,
    `  recorded only:   ${counters.recordedOnly}  (content unchanged, nothing sent)`,
    `  skipped:         ${Object.values(counters.skipped).reduce((a, b) => a + b, 0)}`,
    skipped,
  ]
    .filter(Boolean)
    .join('\n');
}
