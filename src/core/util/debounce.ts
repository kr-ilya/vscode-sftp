/**
 * Debounce with an injectable clock.
 *
 * Replaces `lodash.debounce` (last release 2016-08-13) for two reasons, only
 * one of which is its age: the file watcher's timing is the thing this fork
 * exists to fix, and timing that depends on a real clock cannot be tested
 * without sleeping. Passing the clock in makes every debounce test exact and
 * instant -- no `sleep`, no flakiness, no wall-clock tolerance windows.
 *
 * The semantics deliberately match lodash's `leading`/`trailing`/`maxWait` so
 * that swapping it in changes no behaviour. Note in particular that `maxWait`
 * is measured from the last actual *invocation*, not from the start of the
 * burst -- the two differ once a trailing call fires mid-burst, and getting
 * that wrong shifts invocations by hundreds of milliseconds.
 *
 * Equivalence was established by replaying randomised call sequences against
 * both implementations under one fake clock; see
 * test/core/util/debounce.spec.ts, which keeps the cases that differential run
 * covered.
 */

/** The parts of the platform clock this module needs. */
export interface Clock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const systemClock: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface DebounceOptions {
  /** Invoke on the leading edge of the wait window. Default false. */
  leading?: boolean;
  /** Invoke on the trailing edge of the wait window. Default true. */
  trailing?: boolean;
  /** Upper bound on how long continuous calls may defer an invocation. */
  maxWait?: number;
  /** Defaults to the real clock; tests pass a controllable one. */
  clock?: Clock;
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending invocation. */
  cancel(): void;
  /** Invoke immediately if one is pending, then reset. */
  flush(): void;
  /** Whether an invocation is currently scheduled. */
  pending(): boolean;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
  options: DebounceOptions = {}
): Debounced<A> {
  const { leading = false, trailing = true, maxWait, clock = systemClock } = options;
  const maxing = maxWait !== undefined;

  if (!leading && !trailing) {
    throw new Error('debounce: at least one of leading or trailing must be enabled');
  }
  if (maxing && (maxWait as number) < wait) {
    throw new Error('debounce: maxWait must be greater than or equal to wait');
  }

  let handle: unknown = null;
  let lastArgs: A | null = null;
  let lastCallTime: number | null = null;
  let lastInvokeTime = 0;

  function invoke(time: number) {
    const args = lastArgs;
    lastArgs = null;
    lastInvokeTime = time;
    // Args are always set before this is reached; the cast records that.
    fn(...(args as A));
  }

  /** True when the wait window has elapsed, or maxWait has been reached. */
  function shouldInvoke(time: number): boolean {
    if (lastCallTime === null) return true;
    const sinceCall = time - lastCallTime;
    const sinceInvoke = time - lastInvokeTime;
    // A backwards clock jump counts as "long enough ago" rather than wedging.
    if (sinceCall >= wait || sinceCall < 0) return true;
    return maxing && sinceInvoke >= (maxWait as number);
  }

  /** How long until the earliest of the wait window and the maxWait bound. */
  function remainingWait(time: number): number {
    const sinceCall = time - (lastCallTime as number);
    const sinceInvoke = time - lastInvokeTime;
    const untilWaitEnds = wait - sinceCall;
    return maxing
      ? Math.min(untilWaitEnds, (maxWait as number) - sinceInvoke)
      : untilWaitEnds;
  }

  function onTimeout() {
    const time = clock.now();
    if (shouldInvoke(time)) {
      handle = null;
      // Only fire a trailing edge if calls arrived that the leading edge did
      // not already serve; `lastArgs` is cleared by every invocation.
      if (trailing && lastArgs !== null) {
        invoke(time);
      }
      lastArgs = null;
      return;
    }
    // Woken early (a call reset the window): re-arm for what is left.
    handle = clock.setTimeout(onTimeout, remainingWait(time));
  }

  const debounced = ((...args: A) => {
    const time = clock.now();
    const isInvoking = shouldInvoke(time);

    lastArgs = args;
    lastCallTime = time;

    if (isInvoking) {
      if (handle === null) {
        lastInvokeTime = time;
        if (leading) {
          invoke(time);
        }
        handle = clock.setTimeout(onTimeout, wait);
        return;
      }
      if (maxing) {
        // Continuous calls have hit the maxWait bound: fire now and restart.
        handle = clock.setTimeout(onTimeout, wait);
        invoke(time);
        return;
      }
    }

    if (handle === null) {
      handle = clock.setTimeout(onTimeout, wait);
    }
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (handle !== null) {
      clock.clearTimeout(handle);
      handle = null;
    }
    lastArgs = null;
    lastCallTime = null;
    lastInvokeTime = 0;
  };

  debounced.flush = () => {
    if (handle === null) return;
    const time = clock.now();
    clock.clearTimeout(handle);
    handle = null;
    if (trailing && lastArgs !== null) {
      invoke(time);
    }
    lastArgs = null;
  };

  debounced.pending = () => handle !== null;

  return debounced;
}
