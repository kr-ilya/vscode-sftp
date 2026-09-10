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

export class Uri {
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
    return match ? new Uri(match[1], match[2]) : new Uri('file', value);
  }

  constructor(readonly scheme: string, readonly fsPath: string) {}

  get path(): string {
    return this.fsPath.split('\\').join('/');
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
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

export const window = strict('window', {
  createStatusBarItem: () => new FakeStatusBarItem(),
  createOutputChannel: (name: string) => new FakeOutputChannel(name),
});

export const workspace = strict('workspace', {
  workspaceFolders: undefined as unknown,
  getConfiguration: () => ({ get: () => undefined }),
});

export const commands = strict('commands', {
  registerCommand: () => new Disposable(),
  executeCommand: async () => undefined,
});
