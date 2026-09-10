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
 */
export const fileContentCache = new LRUCache<string, string>({ max: 6 });
