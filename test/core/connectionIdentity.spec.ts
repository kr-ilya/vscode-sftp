import { describe, test, expect } from 'vitest';
import { getHostInfo } from '../../src/core/config/serviceConfig';
import { __testing } from '../../src/core/remoteFs';

/**
 * What decides that two configurations are the same connection.
 *
 * The identity was the option *values* joined together: no keys, no separator,
 * and every nested object rendered as "[object Object]". Two configurations
 * differing only in `hop` therefore shared a connection -- so one of them sent
 * its files through the other's tunnel, to the wrong server, with the wrong
 * credentials.
 */

const identity = (config: Record<string, unknown>) =>
  __testing.hashOption(getHostInfo(config) as Record<string, unknown>);

const base = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/srv/www',
};

describe('configurations that must not share a connection', () => {
  test('different jump hosts', () => {
    const a = { ...base, hop: { host: 'bastion-a', username: 'jump', password: 'a' } };
    const b = { ...base, hop: { host: 'bastion-b', username: 'jump', password: 'b' } };

    expect(identity(a)).not.toBe(identity(b));
  });

  test('a jump host against a direct connection', () => {
    expect(identity({ ...base, hop: { host: 'bastion' } })).not.toBe(identity(base));
  });

  test('values that concatenate into the same string', () => {
    // "example.com" + 22 and "example.com2" + 2 were one key.
    const a = { ...base, host: 'example.com', port: 22 };
    const b = { ...base, host: 'example.com2', port: 2 };

    expect(identity(a)).not.toBe(identity(b));
  });

  test('different credentials on the same host', () => {
    expect(identity({ ...base, password: 'one' })).not.toBe(identity({ ...base, password: 'two' }));
  });

  test('a different descriptor limit, which is a property of the connection', () => {
    expect(identity({ ...base, limitOpenFilesOnRemote: 4 })).not.toBe(
      identity({ ...base, limitOpenFilesOnRemote: 8 })
    );
  });
});

describe('configurations that are the same connection', () => {
  test('the order the keys were written in does not matter', () => {
    const a = { protocol: 'sftp', host: 'example.com', port: 22, username: 'deploy' };
    const b = { username: 'deploy', port: 22, host: 'example.com', protocol: 'sftp' };

    expect(identity(a)).toBe(identity(b));
  });

  test.each([
    ['what to upload on save', { uploadOnSave: true }],
    ['where the local root is', { context: './build' }],
    ['which profiles exist', { profiles: { staging: { host: 'stage' } } }],
    ['what the explorer hides', { remoteExplorer: { filesExclude: ['**/node_modules'] } }],
    ['the permissions to set', { filePerm: 0o644, dirPerm: 0o755 }],
  ])('%s is not part of the connection', (_label, extra) => {
    expect(identity({ ...base, ...extra })).toBe(identity(base));
  });
});
