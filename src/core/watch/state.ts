import type { PathKey } from './pathkey';
import { HASH_ALGORITHM } from './policy';

/**
 * What is remembered about a file between events, and between windows.
 *
 * Without persistence the first window reload would look like "nothing is
 * known about any file", and every subsequent event would have to be treated as
 * a change. The store is what makes the metadata gate meaningful.
 */

/** Everything about an entry that can be compared without reading it. */
export interface CheapFacts {
  size: number;
  mtimeMs: number;
  /**
   * Inode and device, where the platform reports them. They distinguish "the
   * same file, touched" from "a different file, same name and size" -- which is
   * what an editor's atomic save (write temp, rename over the target) produces.
   */
  ino?: number;
  dev?: number;
}

/** Facts obtainable from a single `lstat`, plus the entry's kind. */
export interface EntryFacts extends CheapFacts {
  type: 'file' | 'directory' | 'symlink' | 'other' | 'missing';
}

export interface ContentDigest {
  algorithm: string;
  hash: string;
}

/** What we last knew to be on the server for a given path. */
export interface StateRecord extends CheapFacts {
  algorithm: string;
  hash: string;
  /** When this record was written, epoch milliseconds. */
  at: number;
}

export interface StateStore {
  get(key: PathKey): StateRecord | undefined;
  set(key: PathKey, record: StateRecord): void;
  delete(key: PathKey): void;
  keys(): Iterable<PathKey>;
  readonly size: number;
}

/**
 * Bumped whenever the meaning of a record changes. A mismatch discards the
 * store rather than migrating it: rebuilding is cheap and safe, because an
 * empty store means "seed from disk and upload nothing" rather than "upload
 * everything".
 */
export const STATE_FORMAT_VERSION = 2;

/**
 * One record as it is written to disk.
 *
 * Short names on purpose, and only here: the file holds one of these per file
 * in the workspace and is rewritten whole every time anything changes, so its
 * size is a cost paid over and over rather than once. In memory the fields keep
 * their real names -- the gate reads them on every event, and `r.mtimeMs` says
 * what `r.m` does not.
 *
 * `algorithm` is not in here. It is the same value in every record, so it is
 * written once for the whole file.
 */
interface StoredRecord {
  /** size */
  s: number;
  /** mtimeMs */
  m: number;
  /** ino */
  i?: number;
  /** dev */
  d?: number;
  /** hash */
  h: string;
  /** at */
  t: number;
}

export interface SerializedState {
  version: number;
  /** Which service/profile this state belongs to; see the loader. */
  scope: string;
  /** The digest algorithm every record in this file was written with. */
  algorithm: string;
  entries: Record<string, StoredRecord>;
}

export function createStateStore(initial?: Iterable<[PathKey, StateRecord]>): StateStore {
  const entries = new Map<PathKey, StateRecord>(initial);
  return {
    get: key => entries.get(key),
    set: (key, record) => void entries.set(key, record),
    delete: key => void entries.delete(key),
    keys: () => entries.keys(),
    get size() {
      return entries.size;
    },
  };
}

export function serializeState(scope: string, store: StateStore): SerializedState {
  const entries: Record<string, StoredRecord> = {};
  let algorithm = HASH_ALGORITHM;

  for (const key of store.keys()) {
    const record = store.get(key);
    if (!record) continue;
    // Every record is written by the same code with the same algorithm; the
    // last one seen is the file's.
    algorithm = record.algorithm;
    entries[key] = {
      s: record.size,
      m: record.mtimeMs,
      i: record.ino,
      d: record.dev,
      h: record.hash,
      t: record.at,
    };
  }

  return { version: STATE_FORMAT_VERSION, scope, algorithm, entries };
}

/**
 * Rebuilds a store from serialized form.
 *
 * Returns an empty store for anything unrecognisable -- a different version, a
 * different scope, malformed JSON. Refusing to guess is deliberate: a
 * half-understood state file would produce exactly the silent wrong-way sync
 * this whole mechanism exists to prevent.
 */
export function deserializeState(
  scope: string,
  raw: unknown
): { store: StateStore; accepted: boolean; reason?: string } {
  if (!raw || typeof raw !== 'object') {
    return { store: createStateStore(), accepted: false, reason: 'not an object' };
  }

  const candidate = raw as Partial<SerializedState>;
  if (candidate.version !== STATE_FORMAT_VERSION) {
    return {
      store: createStateStore(),
      accepted: false,
      reason: `format version ${String(candidate.version)} != ${STATE_FORMAT_VERSION}`,
    };
  }
  if (candidate.scope !== scope) {
    return {
      store: createStateStore(),
      accepted: false,
      reason: `scope "${String(candidate.scope)}" != "${scope}"`,
    };
  }
  if (!candidate.entries || typeof candidate.entries !== 'object') {
    return { store: createStateStore(), accepted: false, reason: 'no entries' };
  }

  const algorithm = typeof candidate.algorithm === 'string' ? candidate.algorithm : '';
  if (!algorithm) {
    return { store: createStateStore(), accepted: false, reason: 'no algorithm' };
  }

  const pairs: Array<[PathKey, StateRecord]> = [];
  for (const [key, value] of Object.entries(candidate.entries)) {
    if (isStoredRecord(value)) {
      pairs.push([
        key as PathKey,
        {
          size: value.s,
          mtimeMs: value.m,
          ino: value.i,
          dev: value.d,
          algorithm,
          hash: value.h,
          at: value.t,
        },
      ]);
    }
  }
  return { store: createStateStore(pairs), accepted: true };
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<StoredRecord>;
  return (
    typeof r.s === 'number' &&
    typeof r.m === 'number' &&
    typeof r.h === 'string' &&
    typeof r.t === 'number'
  );
}

/** Whether two sets of cheap facts describe the same state of a file. */
export function factsMatch(a: CheapFacts, b: CheapFacts): boolean {
  if (a.size !== b.size) return false;
  if (a.mtimeMs !== b.mtimeMs) return false;
  // Compare identity only when both sides have it; some file systems and some
  // platforms report zero or omit it entirely.
  if (a.ino !== undefined && b.ino !== undefined && a.ino !== b.ino) return false;
  if (a.dev !== undefined && b.dev !== undefined && a.dev !== b.dev) return false;
  return true;
}

export function recordFrom(facts: EntryFacts, digest: ContentDigest, at: number): StateRecord {
  return {
    size: facts.size,
    mtimeMs: facts.mtimeMs,
    ino: facts.ino,
    dev: facts.dev,
    algorithm: digest.algorithm,
    hash: digest.hash,
    at,
  };
}
