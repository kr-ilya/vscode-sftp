import { describe, test, expect } from 'vitest';
import {
  createCounters,
  countDecision,
  formatTrace,
  formatCounters,
  type TraceEntry,
} from '../../../src/core/watch/diagnostics';

function trace(over: Partial<TraceEntry> = {}): TraceEntry {
  return {
    path: '/w/a.txt',
    kind: 'change',
    decision: { action: 'upload' },
    eventCount: 1,
    hashed: false,
    elapsedMs: 3,
    ...over,
  };
}

describe('counters', () => {
  test('tally each terminal action', () => {
    const c = createCounters();
    countDecision(c, trace({ decision: { action: 'upload' } }));
    countDecision(c, trace({ decision: { action: 'delete-remote' } }));
    countDecision(c, trace({ decision: { action: 'ensure-directory' } }));
    countDecision(c, trace({ decision: { action: 'record-only' } }));

    expect(c).toMatchObject({
      decided: 4,
      uploaded: 1,
      deleted: 1,
      directoriesEnsured: 1,
      recordedOnly: 1,
    });
  });

  test('skips are broken down by reason, which is the diagnostic value', () => {
    const c = createCounters();
    countDecision(c, trace({ decision: { action: 'skip', reason: 'unchanged-metadata' } }));
    countDecision(c, trace({ decision: { action: 'skip', reason: 'unchanged-metadata' } }));
    countDecision(c, trace({ decision: { action: 'skip', reason: 'directory-change' } }));

    expect(c.skipped).toEqual({ 'unchanged-metadata': 2, 'directory-change': 1 });
  });

  test('hash-required is not counted as a decision outcome', () => {
    // It is an intermediate answer; the caller hashes and asks again.
    const c = createCounters();
    countDecision(c, trace({ decision: { action: 'hash-required' } }));
    expect(c.uploaded + c.deleted + c.recordedOnly).toBe(0);
    expect(Object.keys(c.skipped)).toHaveLength(0);
  });

  test('counts how often the file had to be read', () => {
    const c = createCounters();
    countDecision(c, trace({ hashed: true }));
    countDecision(c, trace({ hashed: false }));
    expect(c.hashed).toBe(1);
  });
});

describe('formatTrace', () => {
  test('names the path, the gate reached and the outcome', () => {
    expect(formatTrace(trace())).toBe('change /w/a.txt -> metadata -> upload [3ms]');
  });

  test('says when the content had to be read', () => {
    expect(formatTrace(trace({ hashed: true }))).toContain('metadata+content');
  });

  test('reports the skip reason, not just "skip"', () => {
    expect(formatTrace(trace({ decision: { action: 'skip', reason: 'self-write' } }))).toContain(
      'skip (self-write)'
    );
  });

  test('shows how many raw events collapsed into one decision', () => {
    expect(formatTrace(trace({ eventCount: 7 }))).toContain('change x7');
  });

  test('a single event carries no multiplier', () => {
    expect(formatTrace(trace({ eventCount: 1 }))).not.toContain('x1');
  });
});

describe('formatCounters', () => {
  test('renders the totals and the skip breakdown', () => {
    const c = createCounters();
    c.eventsReceived = 12;
    c.batches = 3;
    countDecision(c, trace({ decision: { action: 'upload' } }));
    countDecision(c, trace({ decision: { action: 'skip', reason: 'unchanged-metadata' } }));

    const rendered = formatCounters(c);
    expect(rendered).toContain('events received: 12 in 3 batch(es)');
    expect(rendered).toContain('uploaded:        1');
    expect(rendered).toContain('unchanged-metadata: 1');
  });

  test('reads sensibly with nothing recorded yet', () => {
    expect(formatCounters(createCounters())).toContain('events received: 0');
  });
});
