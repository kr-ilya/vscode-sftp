import type { PathKey } from './pathkey';

/**
 * What is remembered about a file between events, and between windows.
 *
 * Without persistence the first window reload would look like "nothing is
 * known about any file", and every subsequent event would have to be treated as
 * a change. The store is what makes the metadata gate meaningful.
 */

/** Facts obtainable from a single `lstat`, plus the entry's kind. */
export interface EntryFacts {
  type: 'file' | 'directory' | 'symlink' | 'other' | 'missing';
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

export interface ContentDigest {
  algorithm: string;
  hash: string;
}

/** What we last knew to be on the server for a given path. */
export interface StateRecord {
  size: number;
  mtimeMs: number;
  ino?: number;
  dev?: number;
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
export const STATE_FORMAT_VERSION = 1;

export interface SerializedState {
  version: number;
  /** Which service/profile this state belongs to; see the loader. */
  scope: string;
  entries: Record<string, StateRecord>;
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
  const entries: Record<string, StateRecord> = {};
  for (const key of store.keys()) {
    const record = store.get(key);
    if (record) entries[key] = record;
  }
  return { version: STATE_FORMAT_VERSION, scope, entries };
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

  const pairs: Array<[PathKey, StateRecord]> = [];
  for (const [key, value] of Object.entries(candidate.entries)) {
    if (isStateRecord(value)) pairs.push([key as PathKey, value]);
  }
  return { store: createStateStore(pairs), accepted: true };
}

function isStateRecord(value: unknown): value is StateRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<StateRecord>;
  return (
    typeof r.size === 'number' &&
    typeof r.mtimeMs === 'number' &&
    typeof r.algorithm === 'string' &&
    typeof r.hash === 'string' &&
    typeof r.at === 'number'
  );
}

/** Whether the cheap facts match what was recorded, with no disk read. */
export function factsMatchRecord(facts: EntryFacts, record: StateRecord): boolean {
  if (facts.size !== record.size) return false;
  if (facts.mtimeMs !== record.mtimeMs) return false;
  // Compare identity only when both sides have it; some file systems and some
  // platforms report zero or omit it entirely.
  if (facts.ino !== undefined && record.ino !== undefined && facts.ino !== record.ino) {
    return false;
  }
  if (facts.dev !== undefined && record.dev !== undefined && facts.dev !== record.dev) {
    return false;
  }
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
