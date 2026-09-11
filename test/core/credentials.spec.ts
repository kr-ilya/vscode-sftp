import { describe, test, expect } from 'vitest';
import {
  credentialKey,
  describeIdentity,
  noCredentialStore,
  type CredentialIdentity,
} from '../../src/core/credentials';

const identity = (over: Partial<CredentialIdentity> = {}): CredentialIdentity => ({
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  ...over,
});

describe('credentialKey distinguishes everything that can differ', () => {
  // sftp-neo keys on {host, username, type}. Each case below is two real
  // accounts that its key cannot tell apart, so one silently overwrites the
  // other's password.
  test('protocol', () => {
    expect(credentialKey(identity({ protocol: 'sftp' }), 'password')).not.toBe(
      credentialKey(identity({ protocol: 'ftp' }), 'password')
    );
  });

  test('port', () => {
    // A bastion on 2222 beside a service on 22 is an ordinary arrangement.
    expect(credentialKey(identity({ port: 22 }), 'password')).not.toBe(
      credentialKey(identity({ port: 2222 }), 'password')
    );
  });

  test('host', () => {
    expect(credentialKey(identity({ host: 'a.com' }), 'password')).not.toBe(
      credentialKey(identity({ host: 'b.com' }), 'password')
    );
  });

  test('username', () => {
    expect(credentialKey(identity({ username: 'deploy' }), 'password')).not.toBe(
      credentialKey(identity({ username: 'root' }), 'password')
    );
  });

  test('kind', () => {
    // A key passphrase is not the account password.
    expect(credentialKey(identity(), 'password')).not.toBe(
      credentialKey(identity(), 'passphrase')
    );
  });
});

describe('field boundaries', () => {
  test('a value containing the separator cannot be read as two fields', () => {
    // Without escaping, host "a" + user "b:c" and host "a:b" + user "c" produce
    // the same string -- two different accounts sharing one secret.
    const a = credentialKey(identity({ host: 'a', username: 'b:c' }), 'password');
    const b = credentialKey(identity({ host: 'a:b', username: 'c' }), 'password');
    expect(a).not.toBe(b);
  });

  test('a value containing a backslash is unambiguous too', () => {
    const a = credentialKey(identity({ host: 'a\\', username: ':b' }), 'password');
    const b = credentialKey(identity({ host: 'a', username: 'b' }), 'password');
    expect(a).not.toBe(b);
  });
});

describe('key stability', () => {
  test('the same identity always produces the same key', () => {
    // It has to: a key that varies is a password that is never found again.
    expect(credentialKey(identity(), 'password')).toBe(credentialKey(identity(), 'password'));
  });

  test('the key is namespaced, so it cannot collide with another extension', () => {
    expect(credentialKey(identity(), 'password').startsWith('syncx:')).toBe(true);
  });
});

describe('describeIdentity', () => {
  test('names everything the user needs to tell two servers apart', () => {
    const described = describeIdentity(identity({ port: 2222, protocol: 'ftp' }));
    expect(described).toContain('deploy');
    expect(described).toContain('example.com');
    expect(described).toContain('2222');
    expect(described).toContain('ftp');
  });
});

describe('the default store', () => {
  test('remembers nothing, which degrades to prompting rather than to storing', async () => {
    await noCredentialStore.store(identity(), 'password', 'secret');
    expect(await noCredentialStore.get(identity(), 'password')).toBeUndefined();
    await expect(noCredentialStore.forget(identity(), 'password')).resolves.toBeUndefined();
  });
});
