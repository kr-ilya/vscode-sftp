import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reading and matching OpenSSH `known_hosts` files.
 *
 * Upstream performs no host key verification at all: ssh2 is handed a connect
 * option set with neither `hostVerifier` nor `hostHash`, so any key is accepted
 * silently. WireFerry does not either, despite its careful work elsewhere. That
 * leaves the SSH handshake open to a machine-in-the-middle -- the one gap in
 * this codebase that a correct password and a correct key cannot compensate
 * for.
 *
 * Two decisions distinguish this from sftp-neo's version, which is otherwise
 * the right idea:
 *
 *  - Fingerprints are rendered the way OpenSSH renders them, `SHA256:<base64>`,
 *    so a user can compare what we show against `ssh-keygen -lf` output. neo
 *    prints a hex digest, which matches nothing the user can obtain elsewhere,
 *    making the one moment that requires human judgement unverifiable.
 *  - The system `~/.ssh/known_hosts` is read as the source of truth. A host the
 *    user has already accepted in their terminal is not asked about again, and
 *    a key they have already rejected is not quietly re-accepted here.
 *
 * Pure: parsing and matching only. Reading files and asking the user live in
 * the adapter.
 */

export interface KnownHostEntry {
  /** `@revoked` and `@cert-authority` lines carry a marker. */
  marker?: 'revoked' | 'cert-authority';
  /** Literal host patterns, empty when the line is hashed. */
  patterns: string[];
  /** Present on `|1|salt|hash` lines, which is the Debian/Ubuntu default. */
  hashed?: { salt: Buffer; digest: Buffer };
  keyType: string;
  key: Buffer;
  source: string;
  line: number;
}

/**
 * OpenSSH's fingerprint format: base64 of the SHA-256 of the raw key blob,
 * with padding stripped. This is exactly what `ssh-keygen -lf` prints.
 */
export function fingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** How OpenSSH writes a host in known_hosts: bare, or `[host]:port` off 22. */
export function hostPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

export function parseKnownHosts(content: string, source: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  content.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;

    const fields = text.split(/\s+/);
    let cursor = 0;

    let marker: KnownHostEntry['marker'];
    if (fields[cursor]?.startsWith('@')) {
      const value = fields[cursor].slice(1);
      if (value === 'revoked' || value === 'cert-authority') marker = value;
      cursor += 1;
    }

    const hostField = fields[cursor++];
    const keyType = fields[cursor++];
    const keyBase64 = fields[cursor++];
    if (!hostField || !keyType || !keyBase64) return;

    let key: Buffer;
    try {
      key = Buffer.from(keyBase64, 'base64');
    } catch {
      return;
    }
    // An SSH key blob begins with its own length-prefixed algorithm name, and
    // that name must be the one in the second field. Checking it is what
    // separates a real entry from an arbitrary line that happens to have three
    // words on it -- Buffer.from(..., 'base64') decodes almost anything.
    if (readKeyType(key) !== keyType) return;

    const entry: KnownHostEntry = {
      marker,
      patterns: [],
      keyType,
      key,
      source,
      line: index + 1,
    };

    if (hostField.startsWith('|1|')) {
      // |1|<base64 salt>|<base64 HMAC-SHA1 of the hostname>
      const [, , saltPart, digestPart] = hostField.split('|');
      if (!saltPart || !digestPart) return;
      entry.hashed = {
        salt: Buffer.from(saltPart, 'base64'),
        digest: Buffer.from(digestPart, 'base64'),
      };
    } else {
      entry.patterns = hostField.split(',');
    }

    entries.push(entry);
  });

  return entries;
}

/** Reads the algorithm name from the front of an SSH public key blob. */
export function readKeyType(key: Buffer): string | null {
  if (key.length < 4) return null;
  const length = key.readUInt32BE(0);
  if (length <= 0 || length > key.length - 4) return null;
  return key.subarray(4, 4 + length).toString('ascii');
}

/** OpenSSH host patterns allow `*` and `?`, and a leading `!` to negate. */
function patternMatches(pattern: string, value: string): boolean {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;

  const expression = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const matched = new RegExp(`^${expression}$`, 'i').test(value);
  return negated ? !matched : matched;
}

export function entryMatchesHost(entry: KnownHostEntry, host: string, port: number): boolean {
  const candidates = [hostPattern(host, port)];
  // OpenSSH writes the bare hostname for port 22; tolerate a file that records
  // the bracketed form anyway.
  if (port === 22) candidates.push(`[${host}]:22`);

  if (entry.hashed) {
    return candidates.some(candidate => {
      const digest = createHmac('sha1', entry.hashed!.salt).update(candidate).digest();
      return (
        digest.length === entry.hashed!.digest.length &&
        timingSafeEqual(digest, entry.hashed!.digest)
      );
    });
  }

  // A negated pattern anywhere on the line excludes the host outright.
  if (entry.patterns.some(p => p.startsWith('!') && !patternMatches(p, candidates[0]))) {
    return false;
  }
  return entry.patterns.some(p => candidates.some(candidate => patternMatches(p, candidate)));
}

export type HostKeyVerdict =
  /** This exact key is already recorded for this host. */
  | { kind: 'trusted'; entry: KnownHostEntry }
  /** Nothing is recorded for this host at all. */
  | { kind: 'unknown' }
  /**
   * The host is known and offered a key of a type we have -- but a different
   * one. This is the machine-in-the-middle signal.
   */
  | { kind: 'changed'; expected: KnownHostEntry[] }
  /**
   * The host is known, but not with this key type. A server that has added an
   * ed25519 key alongside its RSA one looks like this, so it is a question
   * rather than an alarm.
   */
  | { kind: 'new-key-type'; existing: KnownHostEntry[] }
  /** The key is explicitly marked `@revoked`. Never acceptable. */
  | { kind: 'revoked'; entry: KnownHostEntry };

export function verifyHostKey(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  keyType: string,
  key: Buffer
): HostKeyVerdict {
  const forHost = entries.filter(entry => entryMatchesHost(entry, host, port));

  const sameKey = forHost.filter(
    entry => entry.key.length === key.length && timingSafeEqual(entry.key, key)
  );

  // Revocation wins over everything, including an otherwise matching entry.
  const revoked = sameKey.find(entry => entry.marker === 'revoked');
  if (revoked) return { kind: 'revoked', entry: revoked };

  const trusted = sameKey.find(entry => entry.marker === undefined);
  if (trusted) return { kind: 'trusted', entry: trusted };

  // Certificate authority lines say "trust keys signed by this", which is a
  // different check from "is this the key". We do not implement certificate
  // validation, so such lines are not evidence either way.
  const usable = forHost.filter(entry => entry.marker === undefined);
  if (usable.length === 0) return { kind: 'unknown' };

  const sameType = usable.filter(entry => entry.keyType === keyType);
  if (sameType.length > 0) return { kind: 'changed', expected: sameType };

  return { kind: 'new-key-type', existing: usable };
}

/** The line this key would be written as, in OpenSSH's own format. */
export function formatKnownHostLine(
  host: string,
  port: number,
  keyType: string,
  key: Buffer
): string {
  return `${hostPattern(host, port)} ${keyType} ${key.toString('base64')}`;
}
