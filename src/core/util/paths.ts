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

export function isSubpathOf(possibleParentPath: string, pathname: string): boolean {
  return path.normalize(pathname).indexOf(path.normalize(possibleParentPath)) === 0;
}

/** How deep a path is, used to order transfers parents-last. */
export function fileDepth(file: string): number {
  return upath.normalize(file).split('/').length;
}
