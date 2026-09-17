import { describe, test, expect } from 'vitest';
import * as path from 'node:path';
import { filesIgnoredFromConfig } from '../../src/core/config/serviceConfig';
import Ignore from '../../src/core/ignore';

/**
 * The one file that is never sent, whatever the configuration says.
 *
 * `ignore` replaces the default list rather than extending it. A project that
 * writes its own and does not think to include `.vscode` uploads its own
 * connection settings to the server -- host, user, remote path, and a password
 * if one was written into the file rather than kept in secret storage. Reported
 * upstream by someone who found their `sftp.json` on their web server.
 */

const ignores = (config: Record<string, unknown>, file: string) =>
  Ignore.from(filesIgnoredFromConfig(config as never)).ignores(file);

const CONFIG = '.vscode/sftp.json';

describe('the configuration file', () => {
  test('is ignored when nothing is configured', () => {
    expect(ignores({}, CONFIG)).toBe(true);
  });

  test('is ignored when the default list is replaced by one that forgets it', () => {
    expect(ignores({ ignore: ['node_modules', 'dist'] }, CONFIG)).toBe(true);
  });

  test('is ignored when an ignore file is used instead', () => {
    expect(ignores({ ignore: [], ignoreFile: undefined }, CONFIG)).toBe(true);
  });

  test('cannot be re-included by a rule that asks for it', () => {
    // Appended last, where gitignore semantics make it win. There is no
    // legitimate reason to publish this file, and asking is more likely to be a
    // mistake than an intention.
    expect(ignores({ ignore: ['!.vscode/sftp.json'] }, CONFIG)).toBe(true);
  });

  test('is ignored with the separator this platform produces', () => {
    // What reaches the rule is the output of `path.relative`, so on Windows it
    // arrives with backslashes -- which are an ordinary character in a file
    // name elsewhere, and so cannot simply be asserted everywhere.
    const asGiven = path.join('.vscode', 'sftp.json');

    expect(ignores({ ignore: ['dist'] }, asGiven)).toBe(true);
  });
});

describe('what the rest of the configuration still decides', () => {
  test('other files are untouched by this', () => {
    expect(ignores({ ignore: ['dist'] }, 'src/app.ts')).toBe(false);
  });

  test('another file in .vscode is a matter of preference, not of protection', () => {
    // Only the connection settings are forced; a project that deliberately
    // syncs its editor settings may go on doing so.
    expect(ignores({ ignore: ['dist'] }, '.vscode/settings.json')).toBe(false);
  });

  test('a configured rule still applies', () => {
    expect(ignores({ ignore: ['dist'] }, 'dist/bundle.js')).toBe(true);
  });

  test('the default list still applies when nothing replaces it', () => {
    // `ignore` reaches this function already defaulted, so what is asserted
    // here is that appending does not disturb it.
    expect(ignores({ ignore: ['.vscode', '.git', '.DS_Store'] }, '.git/config')).toBe(true);
  });
});
