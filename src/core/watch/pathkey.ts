/**
 * Turns a file-system path into a stable key.
 *
 * Two properties matter, and both come from things VS Code documents about its
 * watcher:
 *
 *  - The same file can be reported under different spellings. On Windows and
 *    macOS the casing of a reported path may differ from the casing on disk,
 *    because a workspace folder can be opened with any casing and the watcher
 *    preserves what it was given. Keying on the raw string therefore lets one
 *    file occupy several entries -- which is how upstream's `Set<vscode.Uri>`
 *    managed to deduplicate nothing at all.
 *  - Separators are mixed. A path can arrive with either slash on Windows.
 *
 * Case sensitivity is injected rather than read from `process.platform`. That
 * is not ceremony: it is the only way to test the case-insensitive behaviour on
 * a case-sensitive machine and vice versa, and the real answer depends on the
 * file system rather than the operating system anyway -- a case-sensitive
 * volume on macOS, or a case-insensitive share mounted on Linux.
 */

export type CaseSensitivity = 'sensitive' | 'insensitive';

export type PathKey = string & { readonly __brand: 'PathKey' };

export interface PathKeyer {
  /** The stable key for a path. */
  (path: string): PathKey;
}

/** Normalises separators and removes `.` segments and empty ones. */
function normalizeSeparators(input: string): string {
  const unified = input.replace(/\\/g, '/');

  // A leading `//` is meaningful on Windows (UNC) and must survive.
  const isUnc = unified.startsWith('//');
  const hadLeadingSlash = unified.startsWith('/');

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Only pop a segment that can actually be popped; a leading `..` in a
      // relative path has to stay.
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
        continue;
      }
      segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  const body = segments.join('/');
  if (isUnc) return `//${body}`;
  if (hadLeadingSlash) return `/${body}`;
  return body;
}

export function createPathKeyer(caseSensitivity: CaseSensitivity): PathKeyer {
  const fold = caseSensitivity === 'insensitive';
  return (path: string): PathKey => {
    const normalized = normalizeSeparators(path);
    return (fold ? normalized.toLowerCase() : normalized) as PathKey;
  };
}

/**
 * Whether `path` is at or below `root`, comparing by key.
 *
 * Boundary-safe: `/src/app` does not contain `/src/app-legacy`, which a plain
 * `startsWith` would get wrong.
 */
export function isAtOrUnder(keyer: PathKeyer, root: string, path: string): boolean {
  const rootKey = keyer(root);
  const pathKey = keyer(path);
  if (pathKey === rootKey) return true;
  return pathKey.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`);
}
