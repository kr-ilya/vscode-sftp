import * as vscode from 'vscode';
import { formatCounters } from '../../core/watch/diagnostics';
import { getTreeHandles } from './watcherService';

/**
 * A dedicated output channel for change-detection decisions.
 *
 * Separate from the main log on purpose: this is a per-event trace, and mixing
 * it into the general output would drown everything else. None of the three
 * repositories has anything comparable, which is why "the project re-uploads
 * itself and nothing changed" was not diagnosable from the extension at all --
 * every finding in this fork came from reading source instead.
 */

let channel: vscode.OutputChannel | null = null;

export function getWatchOutput(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('SyncX: change detection');
  }
  return channel;
}

export function showWatchDiagnostics(): void {
  const output = getWatchOutput();
  output.appendLine('');
  output.appendLine('='.repeat(60));
  for (const [base, handle] of getTreeHandles()) {
    output.appendLine(base);
    output.appendLine(formatCounters(handle.counters));
    output.appendLine(`  state records:   ${handle.deps.store.size}`);
    output.appendLine('');
  }
  if (getTreeHandles().size === 0) {
    output.appendLine('No tree is being watched. Is watcher.autoUpload enabled?');
  }
  output.appendLine('='.repeat(60));
  output.show();
}

export function disposeWatchOutput(): void {
  channel?.dispose();
  channel = null;
}
