import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { EntryFacts, ContentDigest } from './state';
import { HASH_ALGORITHM } from './policy';

/**
 * Reads the two things the gate needs about a file: its cheap facts, and -- only
 * when those have moved -- its content digest.
 *
 * This touches the file system, which is precisely why it is a separate module
 * from `decide`: the gate stays a pure function over facts supplied to it, and
 * the expensive part lives here where it can be skipped.
 *
 * It does not import `vscode`, so it stays in core and can be exercised against
 * an in-memory file system.
 */

/** A single lstat, mapped to the shape the gate compares. */
export async function readFacts(path: string): Promise<EntryFacts> {
  let stats: fs.Stats;
  try {
    // lstat, not stat: a symlink must be seen as a symlink rather than silently
    // resolved to whatever it points at, possibly outside the synced tree.
    stats = await fs.promises.lstat(path);
  } catch {
    return { type: 'missing', size: 0, mtimeMs: 0 };
  }

  return {
    type: entryType(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    // Zero is what platforms without a meaningful value report; treating it as
    // absent avoids comparing two zeros and calling that a match.
    ino: stats.ino || undefined,
    dev: stats.dev || undefined,
  };
}

function entryType(stats: fs.Stats): EntryFacts['type'] {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/**
 * Streams the file through the hash.
 *
 * Streamed rather than read whole, and with no size threshold. "Files above N
 * bytes are uploaded without checking" would hand the original defect straight
 * back for exactly the files where re-uploading costs most.
 */
export function readDigest(
  path: string,
  algorithm: string = HASH_ALGORITHM
): Promise<ContentDigest> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = fs.createReadStream(path);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ algorithm, hash: hash.digest('hex') }));
  });
}

/**
 * Facts and digest together, for seeding the store from disk.
 *
 * Returns null for anything that is not a regular file, so callers do not have
 * to repeat that check.
 */
export async function readFileState(
  path: string,
  algorithm: string = HASH_ALGORITHM
): Promise<{ facts: EntryFacts; digest: ContentDigest } | null> {
  const facts = await readFacts(path);
  if (facts.type !== 'file') return null;
  try {
    return { facts, digest: await readDigest(path, algorithm) };
  } catch {
    // Unreadable right now -- being written, or permissions. Leaving it unknown
    // is correct: the next event will be judged on its own.
    return null;
  }
}
