import * as vscode from 'vscode';
import logger from '../../logger';
import { upload, removeRemote, createRemoteFolder } from '../../fileHandlers';
import type { WatcherService, WatcherContext } from '../../core';
import { createPathKeyer, type CaseSensitivity } from '../../core/watch/pathkey';
import { createEventBatcher, type PendingEvent } from '../../core/watch/batch';
import { createExpectationRegistry } from '../../core/watch/expectations';
import { createUploadClaims } from '../../core/watch/uploadClaims';
import { readFacts, readDigest, readFileState } from '../../core/watch/facts';
import { processBatch, recordSynced, forget } from '../../core/watch/pipeline';
import { executeOutcomes } from '../../core/watch/execute';
import { recordFrom, type StateRecord } from '../../core/watch/state';
import { createCounters, formatTrace, type WatchCounters } from '../../core/watch/diagnostics';
import { defaultWatchPolicy } from '../../core/watch/policy';
import { loadPersistentState, type PersistentState } from './stateStore';
import { getWatchOutput } from './output';
import { walkFiles } from './walk';
import { isSubpathOf } from '../../core/util/paths';
import { DestinationDeclinedError } from '../../helper';

/**
 * The editor-facing half of change detection.
 *
 * All it does is turn VS Code events into the core's vocabulary, supply the
 * disk and the clock, and act on the decisions that come back. Every judgement
 * -- what counts as a change, what is our own write, what gets skipped -- is
 * made by src/core/watch, which has none of this file's dependencies.
 */

interface WatchedTree {
  watcher: vscode.FileSystemWatcher;
  dispose(): void;
}

const trees = new Map<string, WatchedTree>();
let storageDir: vscode.Uri | null = null;

/**
 * Which attempt to build a tree for a base is the current one.
 *
 * Building one is asynchronous -- the stored state is read from disk first --
 * while asking for one is not. Two requests in quick succession, which a
 * profile switch and a save of `sftp.json` both produce, therefore overlapped:
 * the second found nothing to dispose because the first had not registered
 * itself yet, and when both finished the second overwrote the first in the
 * table. The first tree's watcher, its subscriptions, its batcher and its state
 * store then stayed alive for the rest of the session, handling every event a
 * second time with a store of its own.
 *
 * A build checks, after each point where it gave up control, that it is still
 * the attempt that was asked for.
 */
const generations = new Map<string, number>();

function startAttempt(watcherBase: string): number {
  const attempt = (generations.get(watcherBase) ?? 0) + 1;
  generations.set(watcherBase, attempt);
  return attempt;
}

function isCurrent(watcherBase: string, attempt: number): boolean {
  return generations.get(watcherBase) === attempt;
}

export function initializeWatching(context: vscode.ExtensionContext): void {
  storageDir = context.globalStorageUri;
}

/**
 * Whether paths on this platform should be compared case-insensitively.
 *
 * A guess based on the platform, not the volume -- a case-sensitive volume on
 * macOS exists, as does a case-insensitive share on Linux. Folding on Windows
 * and macOS is the safe direction: treating two spellings as one file at worst
 * merges records for files that cannot both exist there anyway, whereas not
 * folding would let one file occupy several records and defeat the gate.
 */
function platformCaseSensitivity(): CaseSensitivity {
  return process.platform === 'linux' ? 'sensitive' : 'insensitive';
}

async function createTree(
  watcherBase: string,
  watcherConfig: { files?: string | false | null; autoUpload?: boolean; autoDelete?: boolean },
  context: WatcherContext,
  attempt: number
): Promise<void> {
  const watcherConcurrency = context.concurrency ?? 1;
  const policy = {
    ...defaultWatchPolicy,
    autoUpload: watcherConfig.autoUpload ?? false,
    autoDelete: watcherConfig.autoDelete ?? false,
  };

  const pattern = watcherConfig.files;
  if (!pattern || (!policy.autoUpload && !policy.autoDelete)) return;

  const keyer = createPathKeyer(platformCaseSensitivity());
  const claims = createUploadClaims(keyer);
  // A tree outlives its disposal by as long as the longest transfer it started:
  // a failed upload asks for its file to be examined again, and by then the
  // config may have been reloaded and this tree replaced.
  let disposed = false;
  const counters = createCounters();
  const output = getWatchOutput();

  let persistent: PersistentState;
  try {
    persistent = await loadPersistentState(
      storageDir ?? vscode.Uri.file(watcherBase),
      watcherBase,
      context.scope,
      keyer(watcherBase)
    );
  } catch (error) {
    logger.warn('[watch] state unavailable; running without persistence', error);
    persistent = {
      store: (await import('../../core/watch/state')).createStateStore(),
      markDirty: () => undefined,
      flush: async () => undefined,
      dispose: () => undefined,
    };
  }

  // Reading the state gave up control, and in that time this attempt may have
  // been replaced. Nothing observable has been created yet, so there is nothing
  // to unwind but the state itself.
  if (!isCurrent(watcherBase, attempt)) {
    persistent.dispose();
    return;
  }

  const expectations = createExpectationRegistry(keyer, Date.now);

  const deps = {
    // Same budget as transfers: an independent limit for examining files is
    // exactly the second multiplying budget this fork set out to avoid.
    concurrency: watcherConcurrency,
    store: persistent.store,
    expectations,
    claims,
    keyer,
    policy,
    isIgnored: context.isIgnored,
    readFacts,
    readDigest: (p: string) => readDigest(p),
    now: Date.now,
    counters,
    onTrace: (entry: Parameters<typeof formatTrace>[0]) => pendingTrace.push(formatTrace(entry)),
  };

  /**
   * Trace lines are written once per batch rather than once per event.
   *
   * A checkout between distant branches produces thousands of events, and every
   * `appendLine` is a call across to the window. The channel ends up with the
   * same lines in the same order; they simply arrive together.
   */
  const pendingTrace: string[] = [];
  function flushTrace(): void {
    if (pendingTrace.length === 0) return;
    pendingTrace.push('');
    output.append(pendingTrace.join('\n'));
    pendingTrace.length = 0;
  }

  const batcher = createEventBatcher({
    keyer,
    onBatch: events => {
      counters.batches += 1;
      void runBatch(events);
    },
  });

  async function runBatch(events: PendingEvent[]): Promise<void> {
    let outcomes;
    try {
      outcomes = await processBatch(events, deps);
    } catch (error) {
      logger.error(error, '[watch] deciding on a batch');
      return;
    } finally {
      flushTrace();
    }
    persistent.markDirty();

    await executeOutcomes(outcomes, {
      concurrency: watcherConcurrency,
      ensureDirectory: path => createRemoteFolder(vscode.Uri.file(path)),
      upload: path => upload(vscode.Uri.file(path)),
      remove: path => removeRemote(vscode.Uri.file(path)),
      async onApplied(outcome) {
        if (outcome.decision.action === 'delete-remote') {
          forget(outcome.key, persistent.store);
        } else if (outcome.decision.action === 'upload') {
          await recordSynced(outcome.key, outcome.path, deps);
        }
      },
      onFailed(error, outcome) {
        // Deliberately no state record on failure: the file stays "not known to
        // match", so the next event tries again instead of assuming success.
        if (error instanceof DestinationDeclinedError) {
          // Not a failure: the user was asked and said no, and the guard has
          // already logged it. What matters is that nothing is recorded.
          return;
        }
        logger.error(error as Error, `[watch] ${outcome.decision.action} ${outcome.path}`);
      },
      onSettled: () => persistent.markDirty(),
    });
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(watcherBase, pattern),
    false,
    false,
    false
  );

  const subscriptions = [
    watcher.onDidCreate(uri => {
      counters.eventsReceived += 1;
      batcher.add(uri.fsPath, 'create');
    }),
    watcher.onDidChange(uri => {
      counters.eventsReceived += 1;
      batcher.add(uri.fsPath, 'change');
    }),
    watcher.onDidDelete(uri => {
      counters.eventsReceived += 1;
      batcher.add(uri.fsPath, 'delete');
    }),
  ];

  trees.set(watcherBase, {
    watcher,
    dispose() {
      disposed = true;
      batcher.cancel();
      for (const s of subscriptions) s.dispose();
      watcher.dispose();
      void persistent.flush();
      persistent.dispose();
    },
  });

  registerTree(watcherBase, {
    counters,
    deps,
    persistent,
    reexamine: path => {
      if (!disposed) batcher.add(path, 'change');
    },
  });
  logger.info(`[watch] watching ${watcherBase} (${pattern})`);

  // Cold start: an empty store must not mean "upload everything". Seeding
  // records what is on disk as the assumed server state, so the first window
  // after installing -- or after the state format changes -- is quiet. A real
  // divergence then waits for an explicit Sync, which is the safe direction:
  // doing nothing is recoverable, mass-uploading over a live server is not.
  if (persistent.store.size === 0) {
    void (async () => {
      try {
        const files = await walkFiles(watcherBase, context.isIgnored);
        const seeded = await seedFromDisk(watcherBase, files);
        logger.info(`[watch] seeded ${seeded} file(s) from disk; nothing was transferred`);
      } catch (error) {
        logger.warn('[watch] could not seed state from disk', error);
      }
    })();
  }
}

/** Live state per tree, for the diagnostics and dry-run commands. */
export interface TreeHandle {
  counters: WatchCounters;
  deps: Parameters<typeof processBatch>[1];
  persistent: PersistentState;
  /** Puts a path back through the gate, as if the file system had reported it. */
  reexamine(path: string): void;
}

const handles = new Map<string, TreeHandle>();

function registerTree(base: string, handle: TreeHandle): void {
  handles.set(base, handle);
}

export function getTreeHandles(): ReadonlyMap<string, TreeHandle> {
  return handles;
}

/**
 * Records a file as synced after a transfer that did not come from the watcher.
 *
 * Until now only the watcher's own uploads updated the tracker, so a file sent
 * by a command or from the tree left it holding what was true before -- which
 * made the next event for that file re-upload something the server already had,
 * and made the explorer show it as differing from a copy it exactly matched.
 *
 * Costs nothing where no watcher is configured: there is no tracker to update.
 */
export async function recordTransferred(localPath: string): Promise<void> {
  const handle = findHandle(localPath);
  if (!handle) return;

  await recordSynced(handle.deps.keyer(localPath), localPath, handle.deps);
  handle.persistent.markDirty();
}

/** The watched tree a local path belongs to, if any. */
function findHandle(localPath: string): TreeHandle | undefined {
  for (const [base, handle] of handles) {
    if (localPath === base || isSubpathOf(base, localPath)) return handle;
  }
  return undefined;
}

/** How an upload ended, as far as the claim on it is concerned. */
export type UploadOutcome = 'uploaded' | 'failed' | 'declined';

/** A claim on an upload that is about to start. */
export interface UploadInProgress {
  /**
   * Withdraws the claim once the upload has settled.
   *
   * A *failed* upload puts its file back through the gate, and only if an event
   * for it was actually held back: that event was suppressed on the strength of
   * a transfer that then did not happen, and nothing else would try again until
   * the file changes. Where nothing was suppressed -- a file the watcher's
   * `files` pattern does not cover -- there is nothing to undo, and inventing a
   * retry would upload something the watcher was never watching.
   *
   * A *declined* upload is not retried at all. The user was asked and said no;
   * putting the file back would ask again about the same save.
   */
  release(outcome: UploadOutcome): void;
}

const notClaimed: UploadInProgress = { release: () => undefined };

/**
 * Declares an upload that is about to start, so the watcher does not send the
 * same bytes a second time.
 *
 * Needed only where the extension uploads in response to something the watcher
 * also sees -- which today means `uploadOnSave`, whose save reaches us twice:
 * once as the editor's event and once as the file system's. Commands need
 * nothing: uploading changes no local file, so no event follows.
 */
export async function claimUpload(localPath: string): Promise<UploadInProgress> {
  // No watcher over this file means nothing to suppress, and no reason to stat.
  const handle = findHandle(localPath);
  if (!handle) return notClaimed;

  const facts = await readFacts(localPath);
  if (facts.type !== 'file') return notClaimed;

  const claim = handle.deps.claims.claim(localPath, facts);
  return {
    release(outcome) {
      const heldBack = claim.suppressed;
      claim.release();
      if (outcome === 'failed' && heldBack) handle.reexamine(localPath);
    },
  };
}

/**
 * What was last recorded as synced for a local path, if anything.
 *
 * The record is the only thing in the extension that knows a file's *content*
 * was on the server, rather than that its size and timestamp looked right. It
 * exists only where a watcher is configured, so callers have to work without it
 * -- see core/explorer/entryStatus, which refines its answer when it is there
 * and declines to guess when it is not.
 */
export function findSyncedRecord(localPath: string): StateRecord | undefined {
  const handle = findHandle(localPath);
  return handle?.deps.store.get(handle.deps.keyer(localPath));
}

/**
 * Fills the store from the local tree without transferring anything.
 *
 * An empty store must not mean "upload everything". Seeding says "assume what
 * is on disk is what is on the server", so the first window after installing --
 * or after the state format changes -- is quiet. A genuine divergence stays
 * until an explicit Sync, which is the safe direction to be wrong in: doing
 * nothing is recoverable, mass-uploading over a live server is not.
 */
export async function seedFromDisk(base: string, files: string[]): Promise<number> {
  const handle = handles.get(base);
  if (!handle) return 0;

  let seeded = 0;
  for (const file of files) {
    const key = handle.deps.keyer(file);
    if (handle.deps.store.get(key)) continue;
    const state = await readFileState(file);
    if (!state) continue;
    handle.deps.store.set(key, recordFrom(state.facts, state.digest, Date.now()));
    seeded += 1;
  }
  if (seeded) handle.persistent.markDirty();
  return seeded;
}

function disposeTree(watcherBase: string): void {
  // Also stands down a build that has not finished: it would otherwise register
  // itself after this call and outlive the thing that asked for it.
  startAttempt(watcherBase);

  const tree = trees.get(watcherBase);
  if (!tree) return;
  tree.dispose();
  // Upstream disposed the watcher but left it in the table on two of the three
  // exit paths, so getWatcher() could hand back a disposed one.
  trees.delete(watcherBase);
  handles.delete(watcherBase);
}

const watcherService: WatcherService = {
  create(watcherBase, watcherConfig, context) {
    disposeTree(watcherBase);
    const attempt = startAttempt(watcherBase);
    if (!watcherConfig) return;
    void createTree(watcherBase, watcherConfig, context, attempt).catch(error =>
      logger.error(error, `[watch] setting up ${watcherBase}`)
    );
  },
  dispose: disposeTree,
};

export default watcherService;
