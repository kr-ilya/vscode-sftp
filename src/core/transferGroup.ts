import Scheduler, { Task } from './scheduler';

/**
 * A task that can be stood down before it starts.
 *
 * The shared scheduler has no notion of ownership and no way to withdraw one
 * task from its queue, so a batch stops its work by cancelling it: a cancelled
 * task is still dequeued, and does nothing when it is.
 */
export interface CancellableTask extends Task {
  cancel?(): void;
}

/**
 * One transfer scheduler per service, shared by every operation on it.
 *
 * Upstream built a fresh `Scheduler` for each operation, each with its own
 * `concurrency` budget. So `concurrency: 4` did not mean four transfers at once
 * -- it meant four *per operation*, and three overlapping uploads meant twelve.
 * That is how a setting meant to be polite to a server becomes the thing that
 * trips its `MaxSessions` limit, and the failure looks like a flaky network
 * rather than a configuration that was never being honoured.
 *
 * A batch still observes only its own tasks: it resolves when the work *it*
 * queued has finished, and cancelling it cancels nothing else. The shared part
 * is the budget, not the bookkeeping.
 */

export interface TransferBatch {
  /** Tasks queued by this batch that have not finished yet. */
  readonly size: number;
  add(task: CancellableTask): void;
  /** Resolves once every task this batch queued has settled. */
  run(): Promise<void>;
  /** Drops this batch's queued tasks. Tasks already running are unaffected. */
  stop(): void;
  /**
   * The first failure among this batch's tasks, if any.
   *
   * Exposed because some callers must not report success after a partial one --
   * a failed transfer that looks like a completed one is how a deploy silently
   * ships the wrong thing.
   */
  readonly error?: Error;
}

export interface TransferGroup {
  openBatch(): TransferBatch;
  setConcurrency(concurrency: number): void;
  /** Cancels every batch. */
  stopAll(): void;
  readonly pending: number;
}

export function createTransferGroup(options: {
  concurrency: number;
  onTaskStart?(task: Task): void;
  onTaskDone?(error: Error | null, task: Task): void;
}): TransferGroup {
  const scheduler = new Scheduler({ concurrency: options.concurrency, autoStart: true });
  const batches = new Set<InternalBatch>();

  interface InternalBatch extends TransferBatch {
    owns(task: Task): boolean;
    settle(error: Error | null, task: Task): void;
    drop(): void;
  }

  scheduler.onTaskStart(task => options.onTaskStart?.(task));
  scheduler.onTaskDone((error, task) => {
    options.onTaskDone?.(error, task);
    for (const batch of batches) {
      if (batch.owns(task)) {
        batch.settle(error, task);
        break;
      }
    }
  });

  function openBatch(): TransferBatch {
    const outstanding = new Set<CancellableTask>();
    const queued = new Set<CancellableTask>();
    let stopped = false;
    let firstError: Error | undefined;
    let waiters: Array<() => void> = [];

    const batch: InternalBatch = {
      get size() {
        return outstanding.size;
      },

      get error() {
        return firstError;
      },

      add(task: CancellableTask) {
        if (stopped) return;
        outstanding.add(task);
        queued.add(task);
        scheduler.add(task);
      },

      run() {
        if (outstanding.size === 0) {
          batch.drop();
          return Promise.resolve();
        }
        return new Promise<void>(resolve => {
          waiters.push(resolve);
        });
      },

      stop() {
        stopped = true;
        // Cancel rather than dequeue: the scheduler cannot withdraw a single
        // task, but a cancelled one does nothing when its turn comes. Tasks
        // belonging to other batches are untouched.
        for (const task of queued) {
          (task as CancellableTask).cancel?.();
        }
      },

      owns(task: Task) {
        return outstanding.has(task);
      },

      settle(error: Error | null, task: Task) {
        if (error && !firstError) firstError = error;
        outstanding.delete(task);
        queued.delete(task);
        if (outstanding.size === 0) batch.drop();
      },

      drop() {
        batches.delete(batch);
        const pending = waiters;
        waiters = [];
        for (const resolve of pending) resolve();
      },
    };

    batches.add(batch);
    return batch;
  }

  return {
    openBatch,
    setConcurrency(concurrency: number) {
      scheduler.setConcurrency(concurrency);
    },
    stopAll() {
      for (const batch of [...batches]) batch.stop();
      scheduler.empty();
    },
    get pending() {
      return scheduler.size;
    },
  };
}
