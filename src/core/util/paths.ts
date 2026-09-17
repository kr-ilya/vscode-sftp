import * as os from 'node:os';
import * as path from 'node:path';
import upath from '../upath';

/**
 * Path helpers with no editor or file-system dependency.
 *
 * These lived in src/helper, whose barrel also re-exports modules that show
 * dialogs and write to the output channel. Importing one pure function from
 * that barrel dragged the whole editor API into src/core -- which is why they
 * are here rather than there.
 */

/** Expands a leading `~/` against the current user's home directory. */
export function replaceHomePath(pathname: string): string {
  return pathname.substr(0, 2) === '~/' ? path.join(os.homedir(), pathname.slice(2)) : pathname;
}

export function resolvePath(from: string, to: string): string {
  return path.resolve(from, replaceHomePath(to));
}

/**
 * Whether `pathname` lies inside `possibleParentPath`.
 *
 * Compared segment by segment rather than by string prefix, which answered yes
 * for `/work/proj` and `/work/proj-backup`: the second workspace's files were
 * then attributed to the first one's watcher, and its ignore rules were applied
 * relative to the wrong root.
 *
 * A path is not inside itself -- callers that accept the root itself test for
 * equality separately, and say so where they do.
 */
export function isSubpathOf(possibleParentPath: string, pathname: string): boolean {
  const relative = path.relative(possibleParentPath, pathname);
  if (relative === '') return false;
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** How deep a path is, used to order transfers parents-last. */
export function fileDepth(file: string): number {
  return upath.normalize(file).split('/').length;
}
