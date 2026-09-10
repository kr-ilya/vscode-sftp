import type { PathKey, PathKeyer } from './pathkey';
import type { EventKind } from './decide';
import { debounce, type Clock } from '../util/debounce';
import { DEDUP_WINDOW_MS, DEDUP_MAX_WAIT_MS } from './policy';

/**
 * Collects file-system events into batches, one entry per path.
 *
 * Upstream used `new Set<vscode.Uri>()`. A `Set` compares objects by identity
 * and VS Code hands out a fresh `Uri` for every event, so the set deduplicated
 * nothing: a file that produced five events was uploaded five times, in
 * parallel, to the same remote path. Keying by normalised path is what makes
 * "collect a burst, then act once" actually true.
 */

export interface PendingEvent {
  key: PathKey;
  /** The path as reported, for the file system to act on. */
  path: string;
  kind: EventKind;
  /** How many raw events collapsed into this entry. */
  count: number;
}

export interface EventBatcher {
  add(path: string, kind: EventKind): void;
  /** Emits whatever is pending right now and clears it. */
  flush(): void;
  cancel(): void;
  readonly pendingCount: number;
}

export interface BatcherOptions {
  keyer: PathKeyer;
  onBatch: (events: PendingEvent[]) => void;
  clock?: Clock;
  windowMs?: number;
  maxWaitMs?: number;
}

export function createEventBatcher(options: BatcherOptions): EventBatcher {
  const {
    keyer,
    onBatch,
    clock,
    windowMs = DEDUP_WINDOW_MS,
    maxWaitMs = DEDUP_MAX_WAIT_MS,
  } = options;

  const pending = new Map<PathKey, PendingEvent>();

  function emit() {
    if (pending.size === 0) return;
    const events = [...pending.values()];
    pending.clear();
    onBatch(events);
  }

  const scheduled = debounce(emit, windowMs, {
    // Trailing only. A leading edge fires on the first event of a storm, which
    // is the one moment when waiting is the entire point.
    leading: false,
    trailing: true,
    maxWait: maxWaitMs,
    clock,
  });

  return {
    add(path, kind) {
      const key = keyer(path);
      const existing = pending.get(key);
      if (existing) {
        // Later events win on kind, because the last one describes the file's
        // current state -- except that a delete following a create within one
        // window means the file is gone, and a create following a delete means
        // it is back. Taking the latest kind gets both right.
        existing.kind = kind;
        existing.count += 1;
        existing.path = path;
      } else {
        pending.set(key, { key, path, kind, count: 1 });
      }
      scheduled();
    },

    flush() {
      scheduled.cancel();
      emit();
    },

    cancel() {
      scheduled.cancel();
      pending.clear();
    },

    get pendingCount() {
      return pending.size;
    },
  };
}
