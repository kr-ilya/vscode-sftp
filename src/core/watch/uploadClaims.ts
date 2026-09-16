import type { PathKey, PathKeyer } from './pathkey';
import { factsMatch, type CheapFacts } from './state';

/**
 * Uploads the extension has started and not yet finished.
 *
 * `uploadOnSave` and the watcher both react to the same save, by two
 * independent routes: the editor's save event, and the file-system event that
 * follows it. The watcher's gate would settle the second one by itself -- the
 * facts on disk match what the tracker recorded -- but only once the upload has
 * finished and written that record. Until then the tracker still holds the
 * previous content, so a batch examined before the upload returns sends the
 * same bytes a second time. Whether that happens comes down to whether the
 * transfer beats the batching window, which makes it a property of the
 * network's latency rather than of the configuration: none on a fast link,
 * every save on a slow one.
 *
 * A claim records the facts of the file whose bytes are already on their way.
 * An event is suppressed only when what is on disk still matches those facts
 * exactly -- the same rule as `expectations`, and for the same reason: a
 * timeout would either let the duplicate through on a slow link or discard a
 * genuine edit made while the upload was running. If the user saved again
 * during the upload, the facts differ and the event proceeds, which is correct:
 * those bytes have not been sent.
 *
 * There is no expiry. A claim is released by the upload settling, in a
 * `finally`, so the only way one could outlive its upload is a transfer promise
 * that never settles at all -- by which point that file is not being uploaded
 * by any route.
 */

export interface UploadClaim {
  /**
   * Whether an event was actually held back on the strength of this claim.
   *
   * A claim is made for every save, but only files the watcher covers produce
   * an event at all -- so this is what separates "we suppressed something" from
   * "there was nothing to suppress", and it is the only case where a failed
   * upload has anything to undo.
   */
  readonly suppressed: boolean;
  /** Withdraws the claim, whether the upload succeeded or failed. */
  release(): void;
}

export interface UploadClaims {
  /** Declares that the bytes currently at `path` are being sent. */
  claim(path: string, facts: CheapFacts): UploadClaim;
  /** Whether what is on disk at `path` right now is already on its way. */
  isInFlight(path: string, facts: CheapFacts): boolean;
  readonly size: number;
}

interface ClaimEntry extends CheapFacts {
  /** Distinguishes successive uploads of the same path. */
  generation: number;
  suppressed: boolean;
}

export function createUploadClaims(keyer: PathKeyer): UploadClaims {
  const entries = new Map<PathKey, ClaimEntry>();
  let generation = 0;

  return {
    claim(path, facts) {
      const key = keyer(path);
      const mine = ++generation;
      const entry: ClaimEntry = {
        size: facts.size,
        mtimeMs: facts.mtimeMs,
        ino: facts.ino,
        dev: facts.dev,
        generation: mine,
        suppressed: false,
      };
      entries.set(key, entry);

      return {
        get suppressed() {
          return entry.suppressed;
        },
        release() {
          const current = entries.get(key);
          // A second save for the same path supersedes this claim. Releasing
          // the upload it overtook must not withdraw the newer one, or the
          // event describing those newer bytes would be judged against nothing.
          if (current && current.generation === mine) entries.delete(key);
        },
      };
    },

    isInFlight(path, facts) {
      const entry = entries.get(keyer(path));
      if (entry === undefined || !factsMatch(facts, entry)) return false;

      entry.suppressed = true;
      return true;
    },

    get size() {
      return entries.size;
    },
  };
}
