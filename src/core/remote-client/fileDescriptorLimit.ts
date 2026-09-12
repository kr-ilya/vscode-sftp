/**
 * Keeps the number of file descriptors open on an SFTP server below a limit.
 *
 * sshd counts open handles per session and refuses further opens once the
 * server's own limit is reached, with an error that reads like a broken
 * connection. `limitOpenFilesOnRemote` exists to stay underneath it, and works
 * by wrapping the three calls on ssh2's SFTP stream that acquire and release a
 * handle: `open`, `opendir`, and `close`.
 *
 * Extracted from SSHClient because it was untestable there -- it patched
 * methods on a live ssh2 object -- and the accounting turned out to be wrong in
 * ways nothing would have noticed. What it does now:
 *
 *   - A descriptor is reserved when the call goes out, not when the reply comes
 *     back. Counting on the reply meant a burst of concurrent opens all passed
 *     the check while the count was still zero, which is exactly the case the
 *     limit exists for.
 *
 *   - A failed open gives its reservation back. It used to take one and keep it
 *     forever: enough failures -- opening a path that is not there is an
 *     ordinary event -- and the count would sit at the limit with every
 *     subsequent request queued behind a descriptor that was never open. That
 *     is a client that stops transferring and never recovers.
 *
 *   - Waiting calls go out in the order they arrived. They were released newest
 *     first, so under sustained pressure the oldest one need never run at all.
 */

/**
 * These wrap methods on ssh2's SFTP stream, which is untyped, and they have to
 * pass any signature through unchanged -- `open(path, flags, attrs, cb)`,
 * `opendir(path, cb)`, `close(handle, cb)`. That is what the loose parameter
 * type is for; nothing here reads an argument other than the last.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCall = (...args: any[]) => unknown;
type Callback = (...args: any[]) => unknown;

/** Upstream's numbers, kept: a default well under a stock sshd, and a floor. */
export const DEFAULT_OPEN_FD_LIMIT = 222;
export const MIN_OPEN_FD_LIMIT = 127;

export interface FileDescriptorLimit {
  /** Wraps a call that acquires a descriptor (`open`, `opendir`). */
  guardAcquire<T extends AnyCall>(fn: T): T;
  /** Wraps a call that releases one (`close`). */
  guardRelease<T extends AnyCall>(fn: T): T;
  /** Descriptors currently reserved. */
  readonly reserved: number;
  /** Calls waiting for one to come free. */
  readonly waiting: number;
}

/**
 * @param max how many descriptors may be reserved at once.
 * @param defer runs a callback after the current one has returned. Injected so
 * the ordering can be driven by a test instead of by the microtask queue.
 */
export function createFileDescriptorLimit(
  max: number = DEFAULT_OPEN_FD_LIMIT,
  defer: (run: () => void) => void = run => void Promise.resolve().then(run)
): FileDescriptorLimit {
  let reserved = 0;
  const waiting: Array<() => void> = [];

  function admitNext(): void {
    const next = waiting.shift();
    if (!next) return;
    reserved += 1;
    next();
  }

  function giveBack(): void {
    reserved -= 1;
    // After the caller's own callback has run: releasing inside it would let
    // the next request start before the one that freed the descriptor had
    // finished reporting.
    defer(admitNext);
  }

  return {
    guardAcquire<T extends AnyCall>(fn: T): T {
      return function guardedAcquire(this: unknown, ...args: unknown[]) {
        const callback = args.pop() as Callback;
        // Arrow functions, so `this` stays the object the method was called on
        // without a local alias for it.
        const guarded = (...reply: unknown[]) => {
          // First argument is the error, by Node convention and by ssh2's.
          if (reply[0]) giveBack();
          return callback.apply(this, reply);
        };
        const call = () => (fn as unknown as Callback).apply(this, [...args, guarded]);

        if (reserved >= max) {
          // Returns nothing, where the underlying call returns whether the
          // packet was written. ssh2's callers do not read it.
          waiting.push(call);
          return undefined;
        }

        reserved += 1;
        return call();
      } as unknown as T;
    },

    guardRelease<T extends AnyCall>(fn: T): T {
      return function guardedRelease(this: unknown, ...args: unknown[]) {
        const callback = args.pop() as Callback;
        const guarded = (...reply: unknown[]) => {
          giveBack();
          return callback.apply(this, reply);
        };
        return (fn as unknown as Callback).apply(this, [...args, guarded]);
      } as unknown as T;
    },

    get reserved() {
      return reserved;
    },

    get waiting() {
      return waiting.length;
    },
  };
}
