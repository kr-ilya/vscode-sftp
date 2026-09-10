import { describe, test, expect } from 'vitest';
import {
  fingerprint,
  hostPattern,
  parseKnownHosts,
  entryMatchesHost,
  verifyHostKey,
  formatKnownHostLine,
} from '../../../src/core/ssh/knownHosts';
import { createHmac } from 'node:crypto';

/**
 * The two fixtures below were produced by real OpenSSH tooling and their
 * fingerprints checked against `ssh-keygen -lf`. Getting either the fingerprint
 * format or the hashed-host matching subtly wrong would not break anything
 * visibly -- it would just mean the user is shown a string they cannot verify,
 * or that known hosts are treated as unknown forever.
 */
const ED25519 = {
  type: 'ssh-ed25519',
  base64: 'AAAAC3NzaC1lZDI1NTE5AAAAIAbLCPyIZjjrTihLC54aAWwjuF4cbi6K/Q1KhM6YfNpD',
  // Measured, not invented: `ssh-keygen -lf` on the generated key printed this.
  expected: 'SHA256:s4p6iijvtCochLfRHbTCi0eNPD/9m+eAAt6XP+HAsh8',
};
const RSA = {
  type: 'ssh-rsa',
  base64:
    'AAAAB3NzaC1yc2EAAAADAQABAAABAQCjO7xwwe9L5Vnn6Fuj0O9N5xDtBgAc7Jhq/ecIJyUMF3Zq3BQzDm+M0+uAnHWfi5WoDQ4yYymzKrUNLJyKfBXrt7zwHhLLc3OC6NkYYmxMzvNM2UlBvMzePNws+LO1iNkZNec1UzsVXru8qiZc8qshOUd/3yOhiLbSWIyZUuorPGIqnFH7sa5qJPPzLj0JAd+URAzpXpgjyFrrKSdNxnjMxkWx9fGqA0Ielv/JEcFkJhs3lqQLuzKyfgFWqZ7k1rmZJQe3TzTGF7PsVGY6E+9fl77H0P+oJj+TXOCT7qnpen7FnkOp+vUI4+NiMslCQSr9ajKnBOQrnp+EWvCwTZ7f',
  expected: 'SHA256:rqydDu8NYjF6BtTD6sLUMdT2ZhSi7OIlDJf2Bk1okX8',
};

const edKey = Buffer.from(ED25519.base64, 'base64');
const rsaKey = Buffer.from(RSA.base64, 'base64');
// A different, structurally valid ed25519 key: what an impersonating host
// would present.
const otherKey = Buffer.concat([
  edKey.subarray(0, 4 + 11),
  Buffer.from('AAAAIA==', 'base64'),
  Buffer.alloc(32, 0x5a),
]);

describe('fingerprint', () => {
  test('matches the format ssh-keygen -lf prints', () => {
    expect(fingerprint(edKey)).toBe(ED25519.expected);
  });

  test('is base64 without padding, as OpenSSH renders it', () => {
    expect(fingerprint(edKey)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fingerprint(edKey)).not.toContain('=');
  });

  test('differs for a different key', () => {
    expect(fingerprint(edKey)).not.toBe(fingerprint(otherKey));
  });

  test('matches ssh-keygen for an RSA key too', () => {
    expect(fingerprint(rsaKey)).toBe(RSA.expected);
  });
});

describe('hostPattern', () => {
  test('a bare hostname on port 22, the bracketed form otherwise', () => {
    expect(hostPattern('example.com', 22)).toBe('example.com');
    expect(hostPattern('example.com', 2222)).toBe('[example.com]:2222');
  });
});

describe('parseKnownHosts', () => {
  test('reads a plain line', () => {
    const [entry] = parseKnownHosts(`example.com ${ED25519.type} ${ED25519.base64}`, 'f');
    expect(entry.patterns).toEqual(['example.com']);
    expect(entry.keyType).toBe(ED25519.type);
    expect(entry.key.equals(edKey)).toBe(true);
  });

  test('skips comments and blank lines', () => {
    const entries = parseKnownHosts(
      `# a comment\n\n   \nexample.com ${ED25519.type} ${ED25519.base64}\n`,
      'f'
    );
    expect(entries).toHaveLength(1);
  });

  test('reads several comma-separated hosts on one line', () => {
    const [entry] = parseKnownHosts(`a.com,b.com,1.2.3.4 ${ED25519.type} ${ED25519.base64}`, 'f');
    expect(entry.patterns).toEqual(['a.com', 'b.com', '1.2.3.4']);
  });

  test('reads @revoked and @cert-authority markers', () => {
    const entries = parseKnownHosts(
      `@revoked a.com ${ED25519.type} ${ED25519.base64}\n` +
        `@cert-authority b.com ${ED25519.type} ${ED25519.base64}`,
      'f'
    );
    expect(entries.map(e => e.marker)).toEqual(['revoked', 'cert-authority']);
  });

  test('records the source file and line, so a warning can point at it', () => {
    const [entry] = parseKnownHosts(`\n\nexample.com ${ED25519.type} ${ED25519.base64}`, '/x/kh');
    expect(entry.source).toBe('/x/kh');
    expect(entry.line).toBe(3);
  });

  test('ignores malformed lines rather than throwing', () => {
    expect(parseKnownHosts('nonsense\nalso nonsense here\n', 'f')).toEqual([]);
  });
});

describe('hashed host lines', () => {
  // `HashKnownHosts yes` is the default on Debian and Ubuntu, so getting this
  // wrong would mean treating most users' known hosts as unknown, forever.
  function hashedLine(hostForm: string): string {
    const salt = Buffer.from('0123456789abcdefghij');
    const digest = createHmac('sha1', salt).update(hostForm).digest();
    return `|1|${salt.toString('base64')}|${digest.toString('base64')} ${ED25519.type} ${ED25519.base64}`;
  }

  test('matches the host it was hashed from', () => {
    const [entry] = parseKnownHosts(hashedLine('example.com'), 'f');
    expect(entry.hashed).toBeTruthy();
    expect(entryMatchesHost(entry, 'example.com', 22)).toBe(true);
  });

  test('does not match a different host', () => {
    const [entry] = parseKnownHosts(hashedLine('example.com'), 'f');
    expect(entryMatchesHost(entry, 'evil.com', 22)).toBe(false);
  });

  test('matches a non-standard port through the bracketed form', () => {
    const [entry] = parseKnownHosts(hashedLine('[example.com]:2222'), 'f');
    expect(entryMatchesHost(entry, 'example.com', 2222)).toBe(true);
    expect(entryMatchesHost(entry, 'example.com', 22)).toBe(false);
  });
});

describe('entryMatchesHost', () => {
  const parse = (hostField: string) =>
    parseKnownHosts(`${hostField} ${ED25519.type} ${ED25519.base64}`, 'f')[0];

  test('port is part of the identity', () => {
    expect(entryMatchesHost(parse('example.com'), 'example.com', 22)).toBe(true);
    expect(entryMatchesHost(parse('example.com'), 'example.com', 2222)).toBe(false);
    expect(entryMatchesHost(parse('[example.com]:2222'), 'example.com', 2222)).toBe(true);
  });

  test('supports wildcard patterns', () => {
    expect(entryMatchesHost(parse('*.example.com'), 'build.example.com', 22)).toBe(true);
    expect(entryMatchesHost(parse('*.example.com'), 'example.org', 22)).toBe(false);
    expect(entryMatchesHost(parse('web?.example.com'), 'web1.example.com', 22)).toBe(true);
  });

  test('a negated pattern excludes the host', () => {
    expect(entryMatchesHost(parse('*.example.com,!secret.example.com'), 'secret.example.com', 22))
      .toBe(false);
  });

  test('matching is case-insensitive, as DNS is', () => {
    expect(entryMatchesHost(parse('Example.COM'), 'example.com', 22)).toBe(true);
  });
});

describe('verifyHostKey', () => {
  const known = (hostField: string, type = ED25519.type, b64 = ED25519.base64, marker = '') =>
    parseKnownHosts(`${marker}${hostField} ${type} ${b64}`, 'kh');

  test('a recorded key is trusted', () => {
    const verdict = verifyHostKey(known('example.com'), 'example.com', 22, ED25519.type, edKey);
    expect(verdict.kind).toBe('trusted');
  });

  test('an unrecorded host is unknown', () => {
    expect(verifyHostKey([], 'example.com', 22, ED25519.type, edKey).kind).toBe('unknown');
  });

  test('a different key of the same type is a change, not a question', () => {
    // The machine-in-the-middle signal.
    const verdict = verifyHostKey(known('example.com'), 'example.com', 22, ED25519.type, otherKey);
    expect(verdict.kind).toBe('changed');
    if (verdict.kind === 'changed') {
      expect(verdict.expected[0].source).toBe('kh');
    }
  });

  test('a key type never seen for a known host is a question, not an alarm', () => {
    // A server that added an ed25519 key beside its RSA one looks like this.
    const verdict = verifyHostKey(
      known('example.com', RSA.type, RSA.base64),
      'example.com',
      22,
      ED25519.type,
      edKey
    );
    expect(verdict.kind).toBe('new-key-type');
  });

  test('a revoked key is refused even though it matches', () => {
    const verdict = verifyHostKey(
      known('example.com', ED25519.type, ED25519.base64, '@revoked '),
      'example.com',
      22,
      ED25519.type,
      edKey
    );
    expect(verdict.kind).toBe('revoked');
  });

  test('a cert-authority line is not treated as evidence about this key', () => {
    // It says "trust keys signed by this", which is a different check. We do
    // not validate certificates, so it must not silently trust or reject.
    const verdict = verifyHostKey(
      known('example.com', ED25519.type, ED25519.base64, '@cert-authority '),
      'example.com',
      22,
      ED25519.type,
      otherKey
    );
    expect(verdict.kind).toBe('unknown');
  });

  test('a key recorded for another host does not vouch for this one', () => {
    expect(verifyHostKey(known('other.com'), 'example.com', 22, ED25519.type, edKey).kind).toBe(
      'unknown'
    );
  });

  test('the same host on a different port is a different identity', () => {
    expect(
      verifyHostKey(known('example.com'), 'example.com', 2222, ED25519.type, edKey).kind
    ).toBe('unknown');
  });
});

describe('formatKnownHostLine', () => {
  test('round-trips through the parser', () => {
    const line = formatKnownHostLine('example.com', 2222, ED25519.type, edKey);
    const [entry] = parseKnownHosts(line, 'f');
    expect(entryMatchesHost(entry, 'example.com', 2222)).toBe(true);
    expect(entry.key.equals(edKey)).toBe(true);
  });

  test('writes the bare host for port 22', () => {
    expect(formatKnownHostLine('example.com', 22, ED25519.type, edKey)).toMatch(
      /^example\.com ssh-ed25519 /
    );
  });
});
