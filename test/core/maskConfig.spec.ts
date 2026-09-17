import { describe, test, expect } from 'vitest';
import { maskConfig } from '../../src/core/config/mask';

/**
 * What reaches the output channel when a configuration is logged.
 *
 * It walked only the top level, so two whole categories of credential went out
 * in plain text: every jump host in `hop`, and every environment in `profiles`
 * -- which is the feature people use precisely because they have more than one
 * server. The configuration is logged on activation and on every save of
 * `sftp.json`, and that output is what gets pasted into bug reports.
 */

const config = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  password: 'TOP-LEVEL-SECRET',
  passphrase: 'TOP-LEVEL-PASSPHRASE',
  remotePath: '/srv/www',
  hop: [
    { host: 'bastion-a', username: 'jump', password: 'HOP-SECRET-A' },
    { host: 'bastion-b', username: 'jump', passphrase: 'HOP-SECRET-B' },
  ],
  profiles: {
    staging: { host: 'stage.example.com', username: 'stg', password: 'PROFILE-SECRET' },
    production: { host: 'example.com', username: 'prod', password: 'PROD-SECRET' },
  },
};

/** What the logger actually does with the masked copy. */
const logged = () => JSON.stringify(maskConfig(config));

describe('what a logged configuration may contain', () => {
  test.each([
    ['at the top level', 'TOP-LEVEL-SECRET'],
    ['a top-level passphrase', 'TOP-LEVEL-PASSPHRASE'],
    ['a jump host password', 'HOP-SECRET-A'],
    ['a jump host passphrase', 'HOP-SECRET-B'],
    ['a profile password', 'PROFILE-SECRET'],
    ['a second profile password', 'PROD-SECRET'],
  ])('never %s', (_label, secret) => {
    expect(logged()).not.toContain(secret);
  });

  test('usernames are hidden wherever they appear', () => {
    expect(logged()).not.toContain('deploy');
    expect(logged()).not.toContain('"jump"');
    expect(logged()).not.toContain('"stg"');
  });

  test('everything that is not a credential survives, so the log stays useful', () => {
    const masked = logged();
    expect(masked).toContain('example.com');
    expect(masked).toContain('bastion-a');
    expect(masked).toContain('stage.example.com');
    expect(masked).toContain('/srv/www');
    expect(masked).toContain('22');
  });
});

describe('shapes it has to survive', () => {
  test('a single hop object, not an array', () => {
    const masked = maskConfig({ hop: { host: 'b', password: 'ONE-HOP' } });
    expect(JSON.stringify(masked)).not.toContain('ONE-HOP');
  });

  test('interactive answers are replaced one for one', () => {
    const masked = maskConfig({ interactiveAuth: ['first', 'second'] }) as {
      interactiveAuth: string[];
    };
    expect(masked.interactiveAuth).toEqual(['******', '******']);
  });

  test('a function value -- `ignore` is one by then -- passes through untouched', () => {
    const ignore = () => false;
    const masked = maskConfig({ ignore }) as { ignore: unknown };
    expect(masked.ignore).toBe(ignore);
  });

  test('null and primitives are returned as they are', () => {
    expect(maskConfig(null)).toBeNull();
    expect(maskConfig('plain')).toBe('plain');
    expect(maskConfig({ agent: null })).toEqual({ agent: null });
  });

  test('the original is not modified', () => {
    const original = { password: 'KEEP', hop: { password: 'KEEP-TOO' } };
    maskConfig(original);
    expect(original.password).toBe('KEEP');
    expect(original.hop.password).toBe('KEEP-TOO');
  });
});
