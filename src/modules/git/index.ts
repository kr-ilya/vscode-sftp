import * as vscode from 'vscode';
import type { GitExtension, API, Change, Repository } from './git';

let git: API;

/**
 * Runtime mirror of the `Status` enum from the built-in `vscode.git`
 * extension's API.
 *
 * `./git.d.ts` declares it as an ambient `const enum`, which has no runtime
 * representation at all: tsc used to inline every `Status.MODIFIED` into its
 * numeric literal at compile time. esbuild compiles each file in isolation and
 * never reads `.d.ts`, so it cannot do that inlining -- it would emit a real
 * property read against an import that does not exist at runtime, and every
 * comparison here would silently be `undefined`.
 *
 * Declaring the values explicitly is what makes this bundler-independent. The
 * ordering below is the declaration order in `git.d.ts` and must stay in sync
 * with it; the numbers are what the git extension actually reports.
 */
export enum Status {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,

  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,

  ADDED_BY_US = 9,
  ADDED_BY_THEM = 10,
  DELETED_BY_US = 11,
  DELETED_BY_THEM = 12,
  BOTH_ADDED = 13,
  BOTH_DELETED = 14,
  BOTH_MODIFIED = 15,
}

export type { API as GitAPI, Repository, Change };

export function getGitService(): API {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports;

  git = gitExtension.getAPI(1);
  return git;
}
