import { fingerprint, verifyHostKey, type KnownHostEntry, type HostKeyVerdict } from './knownHosts';

/**
 * Turns a verdict into what should happen and what the user should be told.
 *
 * Kept separate from both the parser and the editor so the policy -- which
 * cases are fatal, which are questions, and what each says -- is one testable
 * function rather than a shape spread through a prompt handler.
 */

export type HostKeyOutcome =
  /** Proceed without asking. */
  | { action: 'accept'; reason: string }
  /** Ask, and remember the answer if the user agrees. */
  | { action: 'ask'; title: string; detail: string }
  /** Refuse. Never offered as a question. */
  | { action: 'refuse'; title: string; detail: string };

export interface HostKeyRequest {
  host: string;
  port: number;
  keyType: string;
  key: Buffer;
  entries: readonly KnownHostEntry[];
}

export function decideHostKey(request: HostKeyRequest): HostKeyOutcome {
  const { host, port, keyType, key, entries } = request;
  const verdict: HostKeyVerdict = verifyHostKey(entries, host, port, keyType, key);
  const shown = fingerprint(key);
  const where = port === 22 ? host : `${host}:${port}`;

  switch (verdict.kind) {
    case 'trusted':
      return {
        action: 'accept',
        reason: `known host key (${verdict.entry.source}:${verdict.entry.line})`,
      };

    case 'unknown':
      return {
        action: 'ask',
        title: `The authenticity of ${where} can't be established.`,
        detail:
          `${keyType} key fingerprint is ${shown}\n\n` +
          'Verify it matches the server before continuing. On the server:\n' +
          '    ssh-keygen -lf /etc/ssh/ssh_host_' +
          shortType(keyType) +
          '_key.pub\n\n' +
          'Accepting records this key so you are only asked once.',
      };

    case 'new-key-type':
      return {
        action: 'ask',
        title: `${where} offered a ${keyType} key, which has not been seen before.`,
        detail:
          `Fingerprint: ${shown}\n\n` +
          `This host is already known by ${listTypes(verdict.existing)}. A server that has ` +
          'added a new key type looks exactly like this, and so does an ' +
          'impersonation attempt that avoids the key you already trust. Verify ' +
          'the fingerprint on the server before accepting.',
      };

    case 'changed':
      return {
        action: 'refuse',
        title: `HOST KEY CHANGED for ${where}. Connection refused.`,
        detail:
          'The server presented a key that does not match the one on record.\n\n' +
          `  offered:  ${shown}\n` +
          verdict.expected
            .map(e => `  expected: ${fingerprint(e.key)}  (${e.source}:${e.line})`)
            .join('\n') +
          '\n\nThis is what a machine-in-the-middle attack looks like. It is also ' +
          'what a rebuilt or reinstalled server looks like.\n\n' +
          'If you know the key legitimately changed, remove the old entry:\n' +
          `    ssh-keygen -R ${where.includes(':') ? `'[${host}]:${port}'` : host}\n` +
          'then connect once with ssh to record the new one.',
      };

    case 'revoked':
      return {
        action: 'refuse',
        title: `The host key for ${where} is marked revoked. Connection refused.`,
        detail:
          `Fingerprint: ${shown}\n\n` +
          `Revoked by ${verdict.entry.source}:${verdict.entry.line}. A revoked key is ` +
          'never acceptable, and this is not something to override here.',
      };
  }
}

/** ed25519 / rsa / ecdsa, for the ssh-keygen hint. */
function shortType(keyType: string): string {
  return keyType.replace(/^ssh-/, '').replace(/^ecdsa-sha2-.*/, 'ecdsa').replace(/-cert.*$/, '');
}

function listTypes(entries: readonly KnownHostEntry[]): string {
  return [...new Set(entries.map(e => e.keyType))].join(', ');
}
