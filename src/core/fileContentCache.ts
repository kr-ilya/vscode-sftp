import { LRUCache } from 'lru-cache';

/**
 * Cache of small auxiliary files read while resolving a configuration --
 * ssh_config and the ignore file.
 *
 * This used to hang off the application singleton as `app.fsCache`, which meant
 * src/core reached into a module that builds status bar items. It is a file
 * cache, not application state; it belongs next to the code that fills it.
 *
 * Invalidated by the save handler, so editing ~/.ssh/config takes effect
 * without a reload.
 *
 * `generation` counts changes to the contents. Anything derived from a cached
 * file can record the generation it was built at and rebuild when it moves;
 * eviction does not count, because an evicted entry is re-read to the same
 * bytes. The save handler asks to drop every saved path, so a delete that finds
 * nothing must not count either -- otherwise ordinary editing would invalidate
 * derived work that does not depend on the file at all.
 */
const entries = new LRUCache<string, string>({ max: 6 });
let generation = 0;

export const fileContentCache = {
  has(key: string): boolean {
    return entries.has(key);
  },

  get(key: string): string | undefined {
    return entries.get(key);
  },

  set(key: string, value: string): void {
    if (entries.get(key) === value) return;
    entries.set(key, value);
    generation += 1;
  },

  delete(key: string): void {
    if (!entries.has(key)) return;
    entries.delete(key);
    generation += 1;
  },

  /** Bumped whenever a cached file's contents change. */
  get generation(): number {
    return generation;
  },
};
