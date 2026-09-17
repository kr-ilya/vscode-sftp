import type { Outcome } from './pipeline';
import { fileDepth } from '../util/paths';
import { inParallel } from '../util/parallel';

/**
 * Carries out the decisions a batch produced.
 *
 * This used to be a `for` loop awaiting one path at a time, which made the
 * ordering obvious and the throughput equal to one file at a time: a `git pull`
 * touching two hundred files sent them one after another, and `concurrency`
 * bought nothing at all on the path where it would help most.
 *
 * Only two of the three actions actually constrain the order:
 *
 *   - **Directories** are created with a plain `mkdir`, not a recursive one, so
 *     a parent has to exist before its children. Grouped by depth, shallowest
 *     group first.
 *   - **Deletions** must reach a child before the directory holding it, so the
 *     groups run deepest first. Running a parent and its child at once is a
 *     race: the child disappears with the parent, and its own removal then
 *     fails.
 *   - **Uploads** constrain nothing. Each one creates its own chain of
 *     directories before writing, so no upload waits on another -- not even on
 *     one higher up the tree. They need no grouping at all.
 *
 * Everything that may overlap is bounded by `concurrency`, the same budget the
 * examination phase uses. A second, independent limit multiplying with the
 * first is the mistake this project already made once: the transfers are capped
 * by the service's scheduler, but the work each upload does *before* queueing a
 * task -- a stat locally, an `ensureDir` on the server -- is not, and firing two
 * hundred of those at a connection at once is how a polite setting becomes an
 * impolite one.
 *
 * A failure never stops the rest. One unreadable file aborting the remainder of
 * a batch is how a pull leaves a server half updated.
 */

export interface ExecuteDeps {
  /** How many items of one group may be in flight. */
  concurrency: number;
  ensureDirectory(path: string): Promise<void>;
  upload(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** After one succeeded: record it, or forget it. */
  onApplied(outcome: Outcome): Promise<void> | void;
  onFailed(error: unknown, outcome: Outcome): void;
  /** After each one, whatever happened. */
  onSettled?(outcome: Outcome): void;
}

/** Outcomes of one action, in groups that must not overlap each other. */
function byDepth(outcomes: Outcome[], deepestFirst: boolean): Outcome[][] {
  const groups = new Map<number, Outcome[]>();
  for (const outcome of outcomes) {
    const depth = fileDepth(outcome.path);
    const group = groups.get(depth);
    if (group) group.push(outcome);
    else groups.set(depth, [outcome]);
  }

  return [...groups.keys()]
    .sort((a, b) => (deepestFirst ? b - a : a - b))
    .map(depth => groups.get(depth)!);
}

export async function executeOutcomes(outcomes: Outcome[], deps: ExecuteDeps): Promise<void> {
  const directories = outcomes.filter(o => o.decision.action === 'ensure-directory');
  const uploads = outcomes.filter(o => o.decision.action === 'upload');
  const deletions = outcomes.filter(o => o.decision.action === 'delete-remote');

  const apply = async (outcome: Outcome): Promise<void> => {
    try {
      if (outcome.decision.action === 'ensure-directory') {
        try {
          await deps.ensureDirectory(outcome.path);
        } catch {
          // Already there, which is the normal case.
        }
      } else if (outcome.decision.action === 'upload') {
        await deps.upload(outcome.path);
      } else {
        await deps.remove(outcome.path);
      }
      await deps.onApplied(outcome);
    } catch (error) {
      deps.onFailed(error, outcome);
    } finally {
      deps.onSettled?.(outcome);
    }
  };

  for (const group of byDepth(directories, false)) {
    await inParallel(group, deps.concurrency, apply);
  }

  await inParallel(uploads, deps.concurrency, apply);

  for (const group of byDepth(deletions, true)) {
    await inParallel(group, deps.concurrency, apply);
  }
}
