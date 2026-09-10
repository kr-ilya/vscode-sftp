import * as vscode from 'vscode';
import logger from '../../logger';
import { upload, removeRemote, createRemoteFolder } from '../../fileHandlers';
import type { WatcherService, WatcherContext } from '../../core';
import { createPathKeyer, type CaseSensitivity } from '../../core/watch/pathkey';
import { createEventBatcher, type PendingEvent } from '../../core/watch/batch';
import { createExpectationRegistry } from '../../core/watch/expectations';
import { readFacts, readDigest, readFileState } from '../../core/watch/facts';
import { processBatch, recordSynced, forget } from '../../core/watch/pipeline';
import { recordFrom } from '../../core/watch/state';
import { createCounters, formatTrace, type WatchCounters } from '../../core/watch/diagnostics';
import { defaultWatchPolicy } from '../../core/watch/policy';
import { loadPersistentState, type PersistentState } from './stateStore';
import { getWatchOutput } from './output';
import { walkFiles } from './walk';
import { fileDepth } from '../../core/util/paths';

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
  context: WatcherContext
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
  const counters = createCounters();
  const output = getWatchOutput();

  let persistent: PersistentState;
  try {
    persistent = await loadPersistentState(
      storageDir ?? vscode.Uri.file(watcherBase),
      watcherBase,
      context.scope
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

  const expectations = createExpectationRegistry(keyer, Date.now);

  const deps = {
    // Same budget as transfers: an independent limit for examining files is
    // exactly the second multiplying budget this fork set out to avoid.
    concurrency: watcherConcurrency,
    store: persistent.store,
    expectations,
    keyer,
    policy,
    isIgnored: context.isIgnored,
    readFacts,
    readDigest: (p: string) => readDigest(p),
    now: Date.now,
    counters,
    onTrace: (entry: Parameters<typeof formatTrace>[0]) => output.appendLine(formatTrace(entry)),
  };

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
    }
    persistent.markDirty();

    // Order matters in two directions at once, so sort rather than hope:
    // directories shallowest-first (a parent before anything inside it), then
    // uploads, then deletions deepest-first (children before the directory
    // that holds them).
    const rank = { 'ensure-directory': 0, upload: 1, 'delete-remote': 2 } as const;
    const ordered = [...outcomes].sort((a, b) => {
      const byAction =
        rank[a.decision.action as keyof typeof rank] -
        rank[b.decision.action as keyof typeof rank];
      if (byAction !== 0) return byAction;
      return a.decision.action === 'delete-remote'
        ? fileDepth(b.path) - fileDepth(a.path)
        : fileDepth(a.path) - fileDepth(b.path);
    });

    for (const outcome of ordered) {
      const uri = vscode.Uri.file(outcome.path);
      try {
        if (outcome.decision.action === 'delete-remote') {
          await removeRemote(uri);
          forget(outcome.key, persistent.store);
        } else if (outcome.decision.action === 'ensure-directory') {
          // Creates the directory and nothing else. Deliberately not upload(),
          // which walks a directory and re-sends every descendant -- the exact
          // behaviour this rewrite exists to remove. The children have their
          // own events and go through the gate on their own merits.
          try {
            await createRemoteFolder(uri);
          } catch {
            // Already there, which is the normal case.
          }
        } else {
          await upload(uri);
          await recordSynced(outcome.key, outcome.path, deps);
        }
      } catch (error) {
        // Deliberately no state record on failure: the file stays "not known to
        // match", so the next event tries again instead of assuming success.
        logger.error(error, `[watch] ${outcome.decision.action} ${outcome.path}`);
      }
      persistent.markDirty();
    }
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
      batcher.cancel();
      for (const s of subscriptions) s.dispose();
      watcher.dispose();
      void persistent.flush();
      persistent.dispose();
    },
  });

  registerTree(watcherBase, { counters, deps, persistent });
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
}

const handles = new Map<string, TreeHandle>();

function registerTree(base: string, handle: TreeHandle): void {
  handles.set(base, handle);
}

export function getTreeHandles(): ReadonlyMap<string, TreeHandle> {
  return handles;
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
    if (!watcherConfig) return;
    void createTree(watcherBase, watcherConfig, context).catch(error =>
      logger.error(error, `[watch] setting up ${watcherBase}`)
    );
  },
  dispose: disposeTree,
};

export default watcherService;
