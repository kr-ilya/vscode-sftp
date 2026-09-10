import { describe, test, expect } from 'vitest';
import {
  validateConfig,
  mergeDefaults,
  defaultConfig,
  parseConfigContent,
} from '../../src/core/config';

/**
 * These replace test/config.spec.js, which declared its own joi schema inline
 * and asserted things about joi. It exercised no line of this project's source.
 * These assert the schema the extension actually validates against.
 */

const minimal = {
  host: 'example.com',
  username: 'deploy',
  remotePath: '/var/www',
};

describe('config validation', () => {
  test('accepts a minimal config', () => {
    expect(validateConfig(minimal)).toBeUndefined();
  });

  test.each(['host', 'username', 'remotePath'])('requires %s', field => {
    const config: Record<string, unknown> = { ...minimal };
    delete config[field];
    const error = validateConfig(config);
    expect(error?.message).toContain(field);
  });

  test('reports every problem at once, not just the first', () => {
    // joi stopped at the first error, so a config with three mistakes took
    // three round trips to fix.
    const error = validateConfig({ host: 1, username: true, remotePath: [] });
    expect(error).toBeDefined();
    for (const field of ['host', 'username', 'remotePath']) {
      expect(error!.message).toContain(field);
    }
  });

  test('does not coerce types', () => {
    // joi ran with convert:false; a port given as a string is a mistake worth
    // surfacing, not something to silently paper over.
    expect(validateConfig({ ...minimal, port: '22' })?.message).toContain('port');
    expect(validateConfig({ ...minimal, port: 22 })).toBeUndefined();
  });

  test('keeps unknown keys, so a newer config does not break an older build', () => {
    expect(validateConfig({ ...minimal, someFutureOption: true })).toBeUndefined();
  });

  test('tolerates unknown keys inside nested option objects too', () => {
    expect(
      validateConfig({ ...minimal, watcher: { autoUpload: true, somethingNew: 1 } })
    ).toBeUndefined();
  });

  test('names the full path of a nested problem', () => {
    const error = validateConfig({ ...minimal, watcher: { autoUpload: 'yes' } });
    expect(error?.message).toContain('watcher.autoUpload');
  });

  test('reports a problem inside a named profile by profile name', () => {
    const error = validateConfig({
      ...minimal,
      profiles: { staging: { port: 'nope' } },
    });
    expect(error?.message).toContain('profiles.staging.port');
  });

  describe('fields that were accepted at runtime but missing from validation', () => {
    // Each of these was reachable in the old code yet absent from the joi
    // schema, so a typo in any of them passed silently.
    test.each([
      ['profiles', { profiles: { staging: { remotePath: '/srv/staging' } } }],
      ['hop', { hop: { host: 'bastion.example.com', username: 'jump' } }],
      ['hop as a chain', { hop: [{ host: 'a' }, { host: 'b' }] }],
      ['filePerm', { filePerm: 0o644 }],
      ['dirPerm', { dirPerm: 0o755 }],
      ['limitOpenFilesOnRemote', { limitOpenFilesOnRemote: true }],
      ['remote', { remote: 'my-named-remote' }],
      ['passive', { passive: true }],
    ])('%s is now part of the schema', (_label, extra) => {
      expect(validateConfig({ ...minimal, ...extra })).toBeUndefined();
    });

    test('and a wrong type in one of them is now caught', () => {
      expect(validateConfig({ ...minimal, filePerm: '644' })?.message).toContain('filePerm');
      expect(
        validateConfig({ ...minimal, profiles: { staging: 'not-an-object' } })?.message
      ).toContain('profiles.staging');
    });
  });

  describe('protocol', () => {
    test.each(['sftp', 'ftp', 'local'])('accepts %s', protocol => {
      expect(validateConfig({ ...minimal, protocol })).toBeUndefined();
    });

    test('rejects an unknown protocol', () => {
      expect(validateConfig({ ...minimal, protocol: 'scp' })?.message).toContain('protocol');
    });
  });

  describe('watcher.files', () => {
    test.each([['a glob', '**/*'], ['false to disable', false], ['null', null]])(
      'accepts %s',
      (_label, files) => {
        expect(validateConfig({ ...minimal, watcher: { files } })).toBeUndefined();
      }
    );

    test('rejects a number', () => {
      expect(validateConfig({ ...minimal, watcher: { files: 1 } })?.message).toContain(
        'watcher.files'
      );
    });
  });

  test('passphrase accepts a string or true, but not an arbitrary value', () => {
    expect(validateConfig({ ...minimal, passphrase: 'secret' })).toBeUndefined();
    expect(validateConfig({ ...minimal, passphrase: true })).toBeUndefined();
    expect(validateConfig({ ...minimal, passphrase: 42 })?.message).toContain('passphrase');
  });

  test('downloadOnOpen accepts booleans and "confirm"', () => {
    expect(validateConfig({ ...minimal, downloadOnOpen: true })).toBeUndefined();
    expect(validateConfig({ ...minimal, downloadOnOpen: 'confirm' })).toBeUndefined();
    expect(validateConfig({ ...minimal, downloadOnOpen: 'maybe' })?.message).toContain(
      'downloadOnOpen'
    );
  });
});

describe('config defaults', () => {
  test('ignores .git, .vscode and .DS_Store out of the box', () => {
    // Upstream defaulted this to [], so the watcher uploaded .git/index on
    // every git operation and .vscode/sftp.json -- which holds credentials --
    // on every edit. The list below is what upstream's own JSON schema had
    // always documented; it just never reached the runtime.
    expect(defaultConfig.ignore).toEqual(['.vscode', '.git', '.DS_Store']);
  });

  test('does not ignore build output by default', () => {
    // Ignoring dist/ or build/ by default would silently break deploying a
    // built artifact, which is one of the main reasons to use this extension.
    for (const path of ['dist', 'build', 'out', 'node_modules']) {
      expect(defaultConfig.ignore).not.toContain(path);
    }
  });

  test('a user-supplied value replaces the default rather than extending it', () => {
    const merged = mergeDefaults({ ignore: ['secrets'] });
    expect(merged.ignore).toEqual(['secrets']);
  });

  test('merged defaults validate', () => {
    expect(validateConfig(mergeDefaults(minimal))).toBeUndefined();
  });

  test('leaves supplied values alone', () => {
    const merged = mergeDefaults({ ...minimal, concurrency: 12, protocol: 'ftp' });
    expect(merged.concurrency).toBe(12);
    expect(merged.protocol).toBe('ftp');
    expect(merged.remotePath).toBe('/var/www');
  });
});

describe('config parsing', () => {
  test('accepts plain JSON', () => {
    expect(parseConfigContent('{"host":"a"}', 'x.json')).toEqual({ host: 'a' });
  });

  test('accepts line and block comments', () => {
    const content = `{
      // the staging box
      "host": "staging.example.com",
      /* port is non-standard here */
      "port": 2222
    }`;
    expect(parseConfigContent(content, 'x.json')).toEqual({
      host: 'staging.example.com',
      port: 2222,
    });
  });

  test('accepts a trailing comma', () => {
    expect(parseConfigContent('{"host":"a","port":22,}', 'x.json')).toEqual({
      host: 'a',
      port: 22,
    });
  });

  test('accepts an array of configurations', () => {
    expect(parseConfigContent('[{"host":"a"},{"host":"b"}]', 'x.json')).toEqual([
      { host: 'a' },
      { host: 'b' },
    ]);
  });

  test('names the file and the offset when the syntax is broken', () => {
    expect(() => parseConfigContent('{"host": }', '.vscode/sftp.json')).toThrow(
      /\.vscode\/sftp\.json is not valid JSON/
    );
  });
});
