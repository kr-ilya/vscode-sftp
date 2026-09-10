import type { PathKey, PathKeyer } from './pathkey';
import type { EntryFacts, ContentDigest } from './state';
import { EXPECTATION_TTL_MS } from './policy';

/**
 * Registry of writes the extension is about to make itself.
 *
 * The extension writes into the tree it is watching -- downloads, and the
 * `utimes` call that aligns a downloaded file's timestamp. Every one of those
 * produces a watcher event indistinguishable from a user's edit, and acting on
 * it means uploading back what was just downloaded.
 *
 * Both existing forks solve this with a timeout: suppress events for this path
 * for the next 2 (or 10) seconds. That is unreliable in both directions -- a
 * slow disk lets the event through after the window closes, and a genuine edit
 * made inside the window is silently thrown away.
 *
 * Here an expectation records the facts the write is *expected* to produce. An
 * event is suppressed only when what is on disk matches those facts. If a user
 * saved over our download, the facts differ and the event proceeds. The TTL
 * exists solely to stop the registry growing when an expected event never
 * arrives; its expiry is never itself a reason to suppress or not suppress.
 */

export interface Expectation {
  size: number;
  mtimeMs: number;
  digest?: ContentDigest;
  /** Epoch milliseconds after which this entry may be swept. */
  expiresAt: number;
  /** Distinguishes successive writes to the same path. */
  generation: number;
}

export interface ExpectationMatch {
  matched: boolean;
  reason: 'no-expectation' | 'facts-match' | 'facts-differ';
}

export interface ExpectationRegistry {
  /**
   * Declares an imminent write. Returns a handle whose `settle` records the
   * facts actually produced, and whose `abandon` withdraws the claim if the
   * write did not happen.
   */
  expect(path: string, expected: { size: number; mtimeMs: number; digest?: ContentDigest }): ExpectationHandle;
  /** Whether an event for this path is explained by one of our own writes. */
  consume(path: string, facts: EntryFacts): ExpectationMatch;
  sweep(now: number): number;
  readonly size: number;
}

export interface ExpectationHandle {
  settle(actual: { size: number; mtimeMs: number; digest?: ContentDigest }): void;
  abandon(): void;
}

export function createExpectationRegistry(
  keyer: PathKeyer,
  now: () => number,
  ttlMs: number = EXPECTATION_TTL_MS
): ExpectationRegistry {
  const entries = new Map<PathKey, Expectation>();
  let generation = 0;

  function sweep(at: number): number {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) {
        entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    expect(path, expected) {
      const key = keyer(path);
      const mine = ++generation;
      entries.set(key, { ...expected, expiresAt: now() + ttlMs, generation: mine });

      return {
        settle(actual) {
          const current = entries.get(key);
          // A later write to the same path supersedes this one; do not clobber
          // its expectation with ours.
          if (!current || current.generation !== mine) return;
          entries.set(key, { ...actual, expiresAt: now() + ttlMs, generation: mine });
        },
        abandon() {
          const current = entries.get(key);
          if (current && current.generation === mine) entries.delete(key);
        },
      };
    },

    consume(path, facts) {
      sweep(now());
      const key = keyer(path);
      const entry = entries.get(key);
      if (!entry) return { matched: false, reason: 'no-expectation' };

      // Full millisecond precision on purpose. Comparing at whole seconds, as
      // one fork does, makes a real edit within the same second look like our
      // own write.
      const matches = facts.size === entry.size && facts.mtimeMs === entry.mtimeMs;
      if (!matches) {
        // Something else wrote over our write. Drop the claim so the next event
        // for this path is judged on its own merits.
        entries.delete(key);
        return { matched: false, reason: 'facts-differ' };
      }

      // Not consumed on first use: one write can produce several events (on
      // Linux a write is visible before the file is closed), and all of them
      // describe the same state. The TTL sweeps it.
      return { matched: true, reason: 'facts-match' };
    },

    sweep,

    get size() {
      return entries.size;
    },
  };
}
