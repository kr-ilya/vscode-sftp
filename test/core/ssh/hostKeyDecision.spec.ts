import { describe, test, expect } from 'vitest';
import { decideHostKey } from '../../../src/core/ssh/hostKeyDecision';
import { parseKnownHosts } from '../../../src/core/ssh/knownHosts';

const TYPE = 'ssh-ed25519';
const B64 = 'AAAAC3NzaC1lZDI1NTE5AAAAIAbLCPyIZjjrTihLC54aAWwjuF4cbi6K/Q1KhM6YfNpD';
const KEY = Buffer.from(B64, 'base64');
const OTHER = Buffer.concat([
  KEY.subarray(0, 15),
  Buffer.from('AAAAIA==', 'base64'),
  Buffer.alloc(32, 0x5a),
]);

const known = (line: string) => parseKnownHosts(line, '/home/u/.ssh/known_hosts');

describe('a key already on record', () => {
  test('is accepted without asking, and says where from', () => {
    const outcome = decideHostKey({
      host: 'example.com', port: 22, keyType: TYPE, key: KEY,
      entries: known(`example.com ${TYPE} ${B64}`),
    });
    expect(outcome.action).toBe('accept');
    if (outcome.action === 'accept') {
      expect(outcome.reason).toContain('/home/u/.ssh/known_hosts:1');
    }
  });
});

describe('an unknown host', () => {
  const outcome = decideHostKey({
    host: 'example.com', port: 2222, keyType: TYPE, key: KEY, entries: [],
  });

  test('is a question, not a refusal', () => {
    expect(outcome.action).toBe('ask');
  });

  test('shows the fingerprint in the format ssh-keygen prints', () => {
    // The user has to compare this against something. A hex digest, which
    // sftp-neo shows, matches nothing they can obtain elsewhere.
    expect(outcome.action === 'ask' && outcome.detail).toContain(
      'SHA256:s4p6iijvtCochLfRHbTCi0eNPD/9m+eAAt6XP+HAsh8'
    );
  });

  test('tells the user how to obtain the real fingerprint', () => {
    expect(outcome.action === 'ask' && outcome.detail).toContain('ssh-keygen -lf');
  });

  test('names the port when it is not 22', () => {
    expect(outcome.action === 'ask' && outcome.title).toContain('example.com:2222');
  });
});

describe('a changed host key', () => {
  const outcome = decideHostKey({
    host: 'example.com', port: 22, keyType: TYPE, key: OTHER,
    entries: known(`example.com ${TYPE} ${B64}`),
  });

  test('is refused outright and never offered as a question', () => {
    // sftp-neo throws here and then catches its own error into a warning
    // toast, so the one signal that matters arrives dismissible.
    expect(outcome.action).toBe('refuse');
  });

  test('shows both fingerprints so the user can tell what changed', () => {
    expect(outcome.action === 'refuse' && outcome.detail).toContain('offered:');
    expect(outcome.action === 'refuse' && outcome.detail).toContain('expected:');
  });

  test('says plainly what this looks like, in both directions', () => {
    const detail = outcome.action === 'refuse' ? outcome.detail : '';
    expect(detail).toContain('machine-in-the-middle');
    expect(detail).toContain('rebuilt or reinstalled server');
  });

  test('gives the exact command to clear the old entry', () => {
    expect(outcome.action === 'refuse' && outcome.detail).toContain('ssh-keygen -R example.com');
  });

  test('quotes the bracketed form for a non-standard port', () => {
    const off22 = decideHostKey({
      host: 'example.com', port: 2222, keyType: TYPE, key: OTHER,
      entries: known(`[example.com]:2222 ${TYPE} ${B64}`),
    });
    expect(off22.action === 'refuse' && off22.detail).toContain("ssh-keygen -R '[example.com]:2222'");
  });
});

describe('a revoked key', () => {
  test('is refused, and not presented as something to override', () => {
    const outcome = decideHostKey({
      host: 'example.com', port: 22, keyType: TYPE, key: KEY,
      entries: known(`@revoked example.com ${TYPE} ${B64}`),
    });
    expect(outcome.action).toBe('refuse');
    expect(outcome.action === 'refuse' && outcome.detail).toContain('never acceptable');
  });
});

describe('a key type not seen before for a known host', () => {
  const outcome = decideHostKey({
    host: 'example.com', port: 22, keyType: TYPE, key: KEY,
    entries: known(
      'example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCjO7xwwe9L5Vnn6Fuj0O9N5xDtBgAc7Jhq/ecIJyUMF3Zq3BQzDm+M0+uAnHWfi5WoDQ4yYymzKrUNLJyKfBXrt7zwHhLLc3OC6NkYYmxMzvNM2UlBvMzePNws+LO1iNkZNec1UzsVXru8qiZc8qshOUd/3yOhiLbSWIyZUuorPGIqnFH7sa5qJPPzLj0JAd+URAzpXpgjyFrrKSdNxnjMxkWx9fGqA0Ielv/JEcFkJhs3lqQLuzKyfgFWqZ7k1rmZJQe3TzTGF7PsVGY6E+9fl77H0P+oJj+TXOCT7qnpen7FnkOp+vUI4+NiMslCQSr9ajKnBOQrnp+EWvCwTZ7f'
    ),
  });

  test('is a question, because a server can legitimately add one', () => {
    expect(outcome.action).toBe('ask');
  });

  test('says which types are already known, and that this can also be an attack', () => {
    const detail = outcome.action === 'ask' ? outcome.detail : '';
    expect(detail).toContain('ssh-rsa');
    expect(detail).toContain('impersonation');
  });
});
