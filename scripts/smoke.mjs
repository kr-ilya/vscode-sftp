/**
 * Load-time smoke test for the packaged bundle.
 *
 * The failure this exists to catch: `webpack.externals` / `esbuild --external`
 * and `.vscodeignore` are two halves of one decision. If a module is marked
 * external but not shipped, the build still succeeds, the tests still pass, and
 * the extension dies with "Cannot find module 'ssh2'" at the user's first
 * connect. Nothing but actually loading the shipped artifact finds that.
 *
 * So: stub `vscode` (the one module that legitimately comes from the host),
 * require dist/extension.js, and assert it exposes an activate(). Any other
 * unresolved require throws here instead of in front of a user.
 *
 * Usage: node scripts/smoke.mjs [path/to/extension.js]
 */

import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const bundlePath = path.resolve(process.argv[2] ?? 'dist/extension.js');

if (!existsSync(bundlePath)) {
  console.error(`smoke: bundle not found at ${bundlePath}`);
  process.exit(1);
}

// Minimal stand-in for the extension host API. Only what runs at load time.
const vscodeStub = {
  Uri: { file: p => ({ scheme: 'file', fsPath: p, toString: () => `file://${p}` }) },
  Disposable: class {
    dispose() {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    createTreeView: () => ({ dispose() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    textDocuments: [],
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  extensions: { getExtension: () => undefined },
  languages: { registerDocumentLinkProvider: () => ({ dispose() {} }) },
  env: { openExternal: async () => true },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

let extension;
try {
  extension = require(bundlePath);
} catch (error) {
  console.error('smoke: FAILED to load the bundle');
  console.error(error);
  process.exit(1);
}

if (typeof extension.activate !== 'function') {
  console.error('smoke: bundle loaded but does not export activate()');
  console.error('exports:', Object.keys(extension));
  process.exit(1);
}

console.log(`smoke: OK -- ${path.basename(bundlePath)} loads and exports activate()`);
