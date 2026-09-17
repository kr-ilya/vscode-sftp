/**
 * Doing several things at once, but not everything at once.
 *
 * `concurrency` is a budget for the server. Everything that talks to it has to
 * draw on the same one, or the setting means nothing: the transfers were
 * already capped, while the walk that finds what to transfer -- a `mkdir` here,
 * a directory listing there -- was not, and fired as wide as the tree was.
 */

/** Runs `work` over `items`, at most `limit` at a time, in no particular order. */
export async function inParallel<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await work(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)
  );
}

export interface Limit {
  /** Waits for a slot, runs `work`, and gives the slot back. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** How many are running right now; for tests and diagnostics. */
  readonly active: number;
}

/**
 * A budget that a recursive walk can share.
 *
 * Deliberately wraps single operations rather than whole subtrees. Holding a
 * slot while awaiting the work *below* a directory would deadlock as soon as
 * every slot was held by something waiting for children that cannot start --
 * so what is bounded here is the calls that reach the server, which is what the
 * budget is about, and the recursion itself stays free to run ahead.
 */
export function createLimit(max: number): Limit {
  const ceiling = Math.max(1, Math.floor(max) || 1);
  const waiting: Array<() => void> = [];
  let active = 0;

  function release(): void {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    get active() {
      return active;
    },

    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active >= ceiling) {
        await new Promise<void>(resolve => waiting.push(resolve));
      }
      active += 1;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
