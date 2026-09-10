import * as path from 'node:path';
import { processBatch } from '../../core/watch/pipeline';
import type { PendingEvent } from '../../core/watch/batch';
import { getTreeHandles } from './watcherService';
import { getWatchOutput } from './output';
import { walkFiles, MAX_WALK_FILES } from './walk';

/**
 * Answers "what would you upload right now?" without uploading anything.
 *
 * Walks the watched tree, runs every file through the same gate the watcher
 * uses, and prints the decisions. `apply: false` keeps the state store
 * untouched, so asking the question does not change the answer to the next one.
 *
 * This exists because the failure this fork was built to fix is invisible from
 * the outside: by the time a user notices the whole project has been re-sent,
 * the evidence is gone. Being able to ask beforehand is the difference between
 * diagnosing it and guessing.
 */

export async function runDryRun(): Promise<void> {
  const output = getWatchOutput();
  output.show();
  output.appendLine('');
  output.appendLine('='.repeat(60));
  output.appendLine('Dry run: what would be uploaded right now. Nothing is sent.');

  const handles = getTreeHandles();
  if (handles.size === 0) {
    output.appendLine('No tree is being watched. Is watcher.autoUpload enabled?');
    output.appendLine('='.repeat(60));
    return;
  }

  for (const [base, handle] of handles) {
    output.appendLine('');
    output.appendLine(base);

    const files = await walkFiles(base, handle.deps.isIgnored);
    if (files.length >= MAX_WALK_FILES) {
      output.appendLine(`  (stopped at ${MAX_WALK_FILES} files)`);
    }

    const events: PendingEvent[] = files.map(file => ({
      key: handle.deps.keyer(file),
      path: file,
      kind: 'change',
      count: 1,
    }));

    // Silence the per-event trace: a dry run prints its own summary, and one
    // line per file across a whole tree would bury it.
    const outcomes = await processBatch(
      events,
      { ...handle.deps, onTrace: undefined, counters: undefined },
      /* apply */ false
    );

    output.appendLine(`  files examined: ${files.length}`);
    output.appendLine(`  would transfer: ${outcomes.length}`);
    for (const outcome of outcomes.slice(0, 200)) {
      output.appendLine(`    ${outcome.decision.action}  ${path.relative(base, outcome.path)}`);
    }
    if (outcomes.length > 200) {
      output.appendLine(`    ... and ${outcomes.length - 200} more`);
    }
    if (outcomes.length === 0) {
      output.appendLine('    (nothing -- local and recorded state agree)');
    }
  }

  output.appendLine('='.repeat(60));
}
