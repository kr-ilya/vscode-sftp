import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Lists regular files under a root, honouring the same ignore rules and the
 * same symlink policy as the watcher.
 *
 * Shared by the dry run and by cold-start seeding so the two cannot disagree
 * about which files are in scope.
 */

/** Bounded so neither caller can hang the window on a pathological tree. */
export const MAX_WALK_FILES = 50_000;

export async function walkFiles(
  root: string,
  isIgnored: (fsPath: string) => boolean,
  out: string[] = []
): Promise<string[]> {
  if (out.length >= MAX_WALK_FILES) return out;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (out.length >= MAX_WALK_FILES) return out;
    const full = path.join(root, entry.name);
    if (isIgnored(full)) continue;
    // Not followed, matching the watcher: VS Code does not follow symlinks
    // either, and reports the link rather than its target.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkFiles(full, isIgnored, out);
    else if (entry.isFile()) out.push(full);
  }

  return out;
}
