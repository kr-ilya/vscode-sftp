import * as vscode from 'vscode';

/**
 * One progress notification for everything currently transferring.
 *
 * Until now a transfer showed a spinner in the status bar and nothing else: a
 * five-hundred megabyte upload and a stalled one looked exactly alike, and
 * there was no way to stop either. The extension has had a "cancel all
 * transfers" command all along, but nothing that put it in front of the person
 * watching the spinner.
 *
 * Ref-counted rather than per operation: transfers from several commands can
 * overlap, and three notifications stacked up would say less than one. The
 * first transfer opens it and the last one closes it.
 *
 * It deliberately does NOT appear at once. `uploadOnSave` means a transfer on
 * every keystroke-to-save, and a notification popping up each time would be
 * worse than the silence it replaces -- so it waits until the work has been
 * going long enough to be worth interrupting for. Cancellation is only offered
 * on notifications, which is why this is not the quieter window-level
 * progress.
 */

/** No total is reported for a bar, because we do not know one. See `render`. */
type Report = vscode.Progress<{ message?: string }>;

export interface TransferDescription {
  /** What to call the file on screen. */
  name: string;
  /** "Uploading" / "Downloading". */
  verb: string;
  /** Source size, when the caller knows it. */
  total?: number;
}

interface Active extends TransferDescription {
  transferred: number;
}

/** How long work must last before it is worth a notification. */
const QUIET_PERIOD_MS = 750;

/** How often the message may be rewritten while bytes stream in. */
const RENDER_INTERVAL_MS = 100;

export default class TransferProgress {
  private readonly _active = new Map<object, Active>();
  private _report: Report | null = null;
  private _closeNotification: (() => void) | null = null;
  private _opening = false;
  private _activeSince = 0;
  private _renderedAt = 0;

  /**
   * @param cancelAll invoked when the user presses Cancel.
   * @param now injected so the quiet period can be tested without waiting.
   */
  constructor(
    private readonly _cancelAll: () => void,
    private readonly _now: () => number = Date.now
  ) {}

  begin(key: object, description: TransferDescription): void {
    if (this._active.size === 0) this._activeSince = this._now();
    this._active.set(key, { ...description, transferred: 0 });
    this._update(true);
  }

  advance(key: object, transferred: number): void {
    const active = this._active.get(key);
    if (!active) return;
    active.transferred = transferred;
    this._update(false);
  }

  end(key: object): void {
    if (!this._active.delete(key)) return;
    this._update(true);
  }

  /** Whether a notification is currently on screen. For tests and diagnostics. */
  get isShowing(): boolean {
    return this._report !== null;
  }

  private _update(immediate: boolean): void {
    if (this._active.size === 0) {
      this._closeNotification?.();
      this._closeNotification = null;
      this._report = null;
      return;
    }

    if (!this._report && !this._opening) {
      if (this._now() - this._activeSince < QUIET_PERIOD_MS) return;
      this._open();
      return;
    }

    if (!this._report) return;

    const now = this._now();
    if (!immediate && now - this._renderedAt < RENDER_INTERVAL_MS) return;
    this._renderedAt = now;
    this._report.report({ message: this._message() });
  }

  private _open(): void {
    this._opening = true;
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SyncX',
        cancellable: true,
      },
      (report, token) =>
        new Promise<void>(resolve => {
          // Cleared here rather than when the notification closes: otherwise a
          // second operation starting in the same tick as the first one ends
          // finds the flag still set and shows nothing at all.
          this._opening = false;
          token.onCancellationRequested(() => this._cancelAll());

          // The work can be over before the notification opens -- a small file
          // finishes in less time than this round trip to the window takes.
          if (this._active.size === 0) {
            resolve();
            return;
          }

          this._report = report;
          this._closeNotification = resolve;
          this._renderedAt = this._now();
          report.report({ message: this._message() });
        })
    );
  }

  private _message(): string {
    const active = [...this._active.values()];

    if (active.length === 1) {
      const [only] = active;
      const size = only.total
        ? `${humanBytes(only.transferred)} of ${humanBytes(only.total)}`
        : humanBytes(only.transferred);
      return `${only.verb} ${only.name} — ${size}`;
    }

    // A running total is the honest number for several files: the whole size is
    // not known until the walk that produces the transfers has finished, and a
    // bar that jumps backwards as more work is discovered is worse than none.
    const transferred = active.reduce((sum, one) => sum + one.transferred, 0);
    const verb = active.every(one => one.verb === active[0].verb) ? active[0].verb : 'Transferring';
    return `${verb} ${active.length} files — ${humanBytes(transferred)}`;
  }
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
