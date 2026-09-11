import { describe, test, expect } from 'vitest';
import {
  defaultPort,
  fieldRules,
  draftToConfig,
  draftToConnectOption,
  validateDraft,
  type ConnectionDraft,
} from '../../src/core/setup/draft';

const draft = (over: Partial<ConnectionDraft> = {}): ConnectionDraft => ({
  protocol: 'sftp',
  host: 'example.com',
  username: 'deploy',
  authMethod: 'password',
  password: 'secret',
  remotePath: '/var/www/site',
  uploadOnSave: false,
  ...over,
});

describe('field rules', () => {
  test('a hostname is required and has no spaces', () => {
    expect(fieldRules.host('')).toBeTruthy();
    expect(fieldRules.host('a b')).toBeTruthy();
    expect(fieldRules.host('example.com')).toBeUndefined();
    expect(fieldRules.host('192.168.1.10')).toBeUndefined();
  });

  test('a scheme in the hostname is rejected', () => {
    // Pasting `sftp://example.com` is the obvious mistake to make here.
    expect(fieldRules.host('sftp://example.com')).toBeTruthy();
  });

  test('a port must be a whole number in range, or left blank', () => {
    expect(fieldRules.port('')).toBeUndefined();
    expect(fieldRules.port('22')).toBeUndefined();
    expect(fieldRules.port('65535')).toBeUndefined();
    expect(fieldRules.port('0')).toBeTruthy();
    expect(fieldRules.port('70000')).toBeTruthy();
    expect(fieldRules.port('22.5')).toBeTruthy();
    expect(fieldRules.port('two')).toBeTruthy();
  });

  test('a local-looking remote path is rejected', () => {
    // The mistake this catches is copying a local path into the remote field,
    // which is how a project ends up somewhere unintended.
    expect(fieldRules.remotePath('C:\\work\\project')).toBeTruthy();
    expect(fieldRules.remotePath('D:/work/project')).toBeTruthy();
    expect(fieldRules.remotePath('/var/www/site')).toBeUndefined();
  });

  test('a remote path is required', () => {
    expect(fieldRules.remotePath('   ')).toBeTruthy();
  });
});

describe('defaultPort', () => {
  test('22 for sftp, 21 for ftp', () => {
    expect(defaultPort('sftp')).toBe(22);
    expect(defaultPort('ftp')).toBe(21);
  });
});

describe('draftToConfig', () => {
  test('never writes the password into the config file', () => {
    // The whole point: the config file is usually committed.
    const config = draftToConfig(draft({ password: 'hunter2' }));
    expect(JSON.stringify(config)).not.toContain('hunter2');
    expect(config).not.toHaveProperty('password');
  });

  test('carries the connection details', () => {
    expect(draftToConfig(draft())).toMatchObject({
      host: 'example.com',
      protocol: 'sftp',
      port: 22,
      username: 'deploy',
      remotePath: '/var/www/site',
    });
  });

  test('fills in the protocol default port', () => {
    expect(draftToConfig(draft({ protocol: 'ftp', port: undefined })).port).toBe(21);
  });

  test('trims what the user typed', () => {
    const config = draftToConfig(draft({ host: '  example.com  ', remotePath: ' /srv/app ' }));
    expect(config.host).toBe('example.com');
    expect(config.remotePath).toBe('/srv/app');
  });

  test('omits an empty name rather than writing an empty string', () => {
    expect(draftToConfig(draft({ name: '   ' }))).not.toHaveProperty('name');
    expect(draftToConfig(draft({ name: 'Staging' })).name).toBe('Staging');
  });

  test('records a private key when that is the method', () => {
    const config = draftToConfig(
      draft({ authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' })
    );
    expect(config.privateKeyPath).toBe('/home/me/.ssh/id_ed25519');
  });

  test('does not record a key path chosen and then abandoned', () => {
    const config = draftToConfig(
      draft({ authMethod: 'password', privateKeyPath: '/home/me/.ssh/id_ed25519' })
    );
    expect(config).not.toHaveProperty('privateKeyPath');
  });

  test('writes uploadOnSave only when it was asked for', () => {
    // A config file should say what is different about this project, not
    // restate the defaults.
    expect(draftToConfig(draft({ uploadOnSave: false }))).not.toHaveProperty('uploadOnSave');
    expect(draftToConfig(draft({ uploadOnSave: true })).uploadOnSave).toBe(true);
  });
});

describe('draftToConnectOption', () => {
  test('carries the password, which the config does not', () => {
    expect(draftToConnectOption(draft()).password).toBe('secret');
  });

  test('passes the agent socket when that is the method', () => {
    expect(draftToConnectOption(draft({ authMethod: 'agent' })).agent).toBe('$SSH_AUTH_SOCK');
  });
});

describe('validateDraft', () => {
  test('a complete draft satisfies the real config schema', () => {
    // Checked against the same schema the extension loads with, so the wizard
    // cannot produce a file that is then refused.
    expect(validateDraft(draft())).toBeUndefined();
  });

  test('a draft missing a required field is rejected', () => {
    expect(validateDraft(draft({ host: '' }))?.message).toContain('host');
  });
});
