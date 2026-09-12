/**
 * Stand-in for the `vscode` module under the unit test runner (wired up via the
 * `resolve.alias` in vitest.config.mts).
 *
 * This deliberately replaces the upstream `__mocks__/vscode.js`, which was a
 * self-returning Proxy: every property access returned another callable Proxy,
 * so any code touching the editor API silently "worked" and no assertion about
 * it could ever fail.
 *
 * Here the top level is a short, auditable list of named exports (it has to be
 * static -- `import * as vscode` reads a module namespace, which cannot be a
 * Proxy), while each namespace object below is strict: reaching for a member we
 * have not modelled throws instead of yielding `undefined`. So the failure mode
 * is "add it to this file on purpose", not "the test quietly passed".
 */

/** Wraps a namespace object so unmodelled members throw rather than no-op. */
function strict<T extends object>(namespace: string, members: T): T {
  return new Proxy(members, {
    get(target, prop: string | symbol) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      // Module-interop probes; answering with a throw breaks the loader.
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') {
        return undefined;
      }
      throw new Error(
        `[test] vscode.${namespace}.${prop} is not modelled by test/fakes/vscode.ts. ` +
          `Add it there rather than letting the test tolerate a silent no-op.`
      );
    },
  }) as T;
}

/**
 * A URI with the parts the extension actually reads.
 *
 * The query matters: remote resources carry their path and the id of the
 * service they belong to there, and the tree keys its item map on it. A Uri
 * that dropped the query -- as the first version of this fake did -- would make
 * every one of those look identical.
 */
export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  private readonly _fsPath?: string;

  private constructor(parts: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
    fsPath?: string;
  }) {
    this.scheme = parts.scheme;
    this.authority = parts.authority ?? '';
    this.path = parts.path ?? '';
    this.query = parts.query ?? '';
    this.fragment = parts.fragment ?? '';
    this._fsPath = parts.fsPath;
  }

  static file(fsPath: string): Uri {
    return new Uri({ scheme: 'file', path: fsPath.split('\\').join('/'), fsPath });
  }

  /** Extends a URI's *path* component, as the real one does. */
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const path = [base.path.replace(/\/+$/, ''), ...segments].join('/');
    return base.with({ path });
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
      value
    );
    if (!match) return Uri.file(value);

    // VS Code decodes percent-encoding when it parses, which is what lets
    // `querystring.parse(uri.query)` see the real values.
    return new Uri({
      scheme: match[1],
      authority: decode(match[2]),
      path: decode(match[3]),
      query: decode(match[4]),
      fragment: decode(match[5]),
    });
  }

  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri({
      scheme: change.scheme ?? this.scheme,
      authority: change.authority ?? this.authority,
      path: change.path ?? this.path,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment,
      fsPath: change.path === undefined ? this._fsPath : undefined,
    });
  }

  get fsPath(): string {
    return this._fsPath ?? this.path;
  }

  /** Part of the real Uri; VS Code serializes URIs when it hands them across. */
  toJSON(): unknown {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }

  toString(): string {
    const query = this.query ? `?${this.query}` : '';
    const fragment = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
  }
}

function decode(part: string | undefined): string {
  if (!part) return '';
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export class Disposable {
  constructor(private readonly _dispose: () => void = () => undefined) {}
  dispose(): void {
    this._dispose();
  }
}

export class EventEmitter<T> {
  private _listeners: Array<(e: T) => unknown> = [];

  event = (listener: (e: T) => unknown): Disposable => {
    this._listeners.push(listener);
    return new Disposable(() => {
      this._listeners = this._listeners.filter(l => l !== listener);
    });
  };

  fire(data: T): void {
    for (const listener of [...this._listeners]) listener(data);
  }

  dispose(): void {
    this._listeners = [];
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;

/*
 * The surfaces below are reached at *module load* time by the code under test.
 * That a transfer test needs a status bar at all is a symptom, not a
 * requirement: src/app.ts constructs UI singletons on import, so importing any
 * file handler drags them in. Roadmap iteration 5 breaks that chain; until
 * then these no-ops keep the import graph loadable.
 */

class FakeStatusBarItem {
  text = '';
  command: unknown = undefined;
  tooltip: unknown = undefined;
  show(): void {}
  hide(): void {}
  dispose(): void {}
}

class FakeOutputChannel {
  constructor(readonly name: string) {}
  append(): void {}
  appendLine(): void {}
  replace(): void {}
  clear(): void {}
  show(): void {}
  hide(): void {}
  dispose(): void {}
}

/** Identifies a colour from the active theme; compared by id in tests. */
export class ThemeColor {
  constructor(readonly id: string) {}
}

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

/**
 * A progress notification opened through `window.withProgress`.
 *
 * Recorded rather than discarded so a test can read what the user would see and
 * press the Cancel button the real one offers.
 */
export class FakeProgress {
  readonly messages: string[] = [];
  finished = false;
  private readonly _onCancel: Array<() => void> = [];

  constructor(readonly options: { title?: string; location?: number; cancellable?: boolean }) {}

  report(value: { message?: string }): void {
    if (value.message !== undefined) this.messages.push(value.message);
  }

  get lastMessage(): string | undefined {
    return this.messages[this.messages.length - 1];
  }

  /** Presses the notification's Cancel button. */
  cancel(): void {
    for (const listener of [...this._onCancel]) listener();
  }

  get token(): FakeCancellationToken {
    return {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this._onCancel.push(listener);
        return new Disposable(() => undefined);
      },
    };
  }
}

export interface FakeCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

/** Every progress notification opened so far. Tests clear it themselves. */
export const openedProgress: FakeProgress[] = [];

/**
 * Answers `window.showInputBox` will give, oldest first. A test pushes what the
 * user would type; an exhausted queue means the prompt was cancelled.
 */
export const inputBoxAnswers: Array<string | undefined> = [];

export const window = strict('window', {
  createStatusBarItem: () => new FakeStatusBarItem(),
  showInputBox: async () => inputBoxAnswers.shift(),
  createOutputChannel: (name: string) => new FakeOutputChannel(name),
  registerFileDecorationProvider: () => new Disposable(),
  async withProgress<R>(
    options: { title?: string; location?: number; cancellable?: boolean },
    task: (progress: FakeProgress, token: FakeCancellationToken) => Thenable<R>
  ): Promise<R> {
    const progress = new FakeProgress(options);
    openedProgress.push(progress);
    const result = await task(progress, progress.token);
    progress.finished = true;
    return result;
  },
});

export const workspace = strict('workspace', {
  workspaceFolders: undefined as unknown,
  getConfiguration: () => ({ get: () => undefined }),
});

export const commands = strict('commands', {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
});
