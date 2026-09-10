/**
 * Tunable constants for change detection, in one place.
 *
 * These were chosen by reasoning, not measurement, and are grouped here so that
 * changing one is a single edit rather than a hunt. Each carries why it is what
 * it is.
 */

/**
 * How long to let a burst of file-system events settle before acting.
 *
 * Upstream used 550ms with `leading: true`, which fires immediately on the
 * *first* event of a storm -- exactly when waiting is the whole point. Trailing
 * only. 400ms is below the pause between human edits but long enough to collect
 * the several events one save produces (on Linux a write is visible as repeated
 * IN_MODIFY before the file is even closed).
 */
export const DEDUP_WINDOW_MS = 400;

/**
 * Upper bound on how long a continuous stream of events may defer action, so
 * that trailing-only debouncing cannot postpone an upload indefinitely.
 */
export const DEDUP_MAX_WAIT_MS = 3000;

/**
 * How long an unclaimed expected-write record survives.
 *
 * This is garbage collection, not a decision: an expectation is matched by
 * comparing facts on disk, never by whether a timer has run out. The window can
 * therefore be generous -- it only has to outlast a slow write over a network
 * file system.
 */
export const EXPECTATION_TTL_MS = 30_000;

/**
 * Content hash algorithm.
 *
 * A collision here means an upload silently skipped -- a file diverging from
 * the server with no signal at all. That is not a price worth paying for speed,
 * and the metadata gate means content is hashed rarely enough for the cost not
 * to matter. Non-cryptographic alternatives (xxhash3, blake3) would also mean
 * either a native addon, which breaks the bundling model, or an extra
 * dependency.
 */
export const HASH_ALGORITHM = 'sha256';

/** Behaviour switches, resolved from the user's `watcher` configuration. */
export interface WatchPolicy {
  autoUpload: boolean;
  autoDelete: boolean;
  /**
   * VS Code does not follow symbolic links when watching, and the path it
   * reports is the link, not the target. Uploading through one would send a
   * file that lives outside the synced tree, so the default is to leave them
   * alone.
   */
  followSymlinks: boolean;
}

export const defaultWatchPolicy: WatchPolicy = {
  autoUpload: false,
  autoDelete: false,
  followSymlinks: false,
};
