import type { PathKey, PathKeyer } from './pathkey';
import { EXPECTATION_TTL_MS } from './policy';

/**
 * Paths the extension has just renamed away on the server.
 *
 * A rename in the editor reaches the watcher as two ordinary events: a delete
 * of the old path and a create of the new one. Acted on literally, and with
 * `autoDelete` on, the delete undoes the rename -- the file was moved on the
 * server a moment ago, and now the old name is removed, taking the content with
 * it. The create is merely wasteful: the same bytes sent again under the new
 * name.
 *
 * So a rename says so here first. The delete for a path renamed away is
 * dropped, and the record for it is carried over to the new path, which leaves
 * the create looking like what it is -- a file already on the server.
 *
 * Matched by path rather than by facts, unlike the expectation registry: there
 * is nothing left on disk at the old path to compare. That makes the time limit
 * load-bearing rather than mere housekeeping, so it is kept short and stated.
 */

export interface RenameRegistry {
  /** Says that `path` has been renamed away, on the server as well. */
  renamedAway(path: string): void;
  /** Whether a deletion of `path` is explained by a rename we performed. */
  consume(path: string, now: number): boolean;
  sweep(now: number): number;
  readonly size: number;
}

export function createRenameRegistry(
  keyer: PathKeyer,
  ttlMs: number = EXPECTATION_TTL_MS
): RenameRegistry {
  const entries = new Map<PathKey, number>();

  function sweep(now: number): number {
    let removed = 0;
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    renamedAway(path: string) {
      entries.set(keyer(path), Date.now() + ttlMs);
    },

    consume(path: string, now: number) {
      sweep(now);
      const key = keyer(path);
      // A directory renamed away takes its children with it, and VS Code
      // reports the removal of a folder as one event on the folder -- but a
      // file inside one can still arrive on its own.
      for (const candidate of entries.keys()) {
        if (key === candidate || key.startsWith(`${candidate}/`)) {
          // Consumed on first use: unlike a write, a rename produces exactly
          // one deletion, and holding the entry longer would swallow a real
          // deletion of a path that has since come back.
          entries.delete(candidate);
          return true;
        }
      }
      return false;
    },

    sweep,

    get size() {
      return entries.size;
    },
  };
}
