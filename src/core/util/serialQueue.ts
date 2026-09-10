/**
 * Runs asynchronous tasks strictly one at a time, in the order submitted.
 *
 * FTP needs this structurally, not as a tuning choice: a client has one control
 * connection, and a second command issued while the first is in flight
 * corrupts the exchange. `basic-ftp` enforces it by throwing; the older `ftp`
 * package did not, which is why upstream wrapped every call in a `p-queue` with
 * `concurrency: 1`.
 *
 * That is the whole of what p-queue was used for here, so this replaces it --
 * a pinned 2018 dependency for a promise chain.
 */

export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks submitted but not yet started. */
  readonly waiting: number;
  readonly busy: boolean;
}

export function createSerialQueue(): SerialQueue {
  // The chain is what serialises: each task waits on the previous one settling.
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let busy = false;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      waiting += 1;

      const result = tail.then(
        () => {
          waiting -= 1;
          busy = true;
          return task();
        },
        () => {
          // A previous task failing must not stop the queue -- its rejection
          // belongs to its own caller, not to everything queued behind it.
          waiting -= 1;
          busy = true;
          return task();
        }
      );

      // The chain advances on settle either way, so one failure does not wedge
      // the queue. `result` keeps its rejection for the caller.
      tail = result.then(
        () => {
          busy = false;
        },
        () => {
          busy = false;
        }
      );

      return result;
    },

    get waiting() {
      return waiting;
    },

    get busy() {
      return busy;
    },
  };
}
