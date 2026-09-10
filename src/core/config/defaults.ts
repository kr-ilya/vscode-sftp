import type { Config } from './schema';

/**
 * Values applied to a configuration before it is validated or used.
 *
 * Note the semantics: these are merged shallowly, so a key present in the
 * user's config replaces the default outright rather than extending it. That
 * matters most for `ignore`.
 */
export const defaultConfig = {
  remotePath: './',
  uploadOnSave: false,
  /**
   * Stage uploads through a temporary file and move them into place.
   *
   * On by default now. Writing straight to the target truncates it the instant
   * the transfer starts, so a dropped connection leaves a shortened file on the
   * server -- the previous version is gone and the new one never arrived. That
   * is the worst failure mode a sync tool has, and it was the default.
   *
   * The cost is a second file in the directory for the duration of the transfer
   * and one rename. Where the directory does not permit creating one, the
   * transfer falls back to writing directly and says so.
   */
  useTempFile: true,
  openSsh: false,
  downloadOnOpen: false,

  /**
   * Upstream defaulted this to `[]`, which meant that out of the box the
   * watcher uploaded `.git/index`, `.git/HEAD` and `.git/refs/**` to the server
   * on every git operation, and `.vscode/sftp.json` -- the file holding the
   * credentials -- on every edit.
   *
   * The value below is not new: it is exactly what upstream's own JSON schema
   * has always documented as the default. It simply never reached the runtime,
   * because the schema and the defaults were separate declarations. Now there
   * is one.
   *
   * Deliberately not included: `node_modules`, `dist`, `build`. Ignoring those
   * by default would silently break the very common case of deploying a built
   * artifact, and a sync tool that quietly omits files is worse than one that
   * uploads too many.
   */
  ignore: ['.vscode', '.git', '.DS_Store'],

  concurrency: 4,
  protocol: 'sftp',
  connectTimeout: 10 * 1000,
  interactiveAuth: false,
  secure: false,
  remoteTimeOffsetInHours: 0,
  remoteExplorer: {
    order: 0,
  },
} satisfies Partial<Config>;

/** Shallow-merge, matching the behaviour the extension has always had. */
export function mergeDefaults<T extends object>(config: T): T & typeof defaultConfig {
  return { ...defaultConfig, ...config };
}
