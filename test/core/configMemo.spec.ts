import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fse from 'fs-extra';

vi.mock('../../src/modules/serviceManager', () => ({ getAllFileService: () => [] }));

import FileService from '../../src/core/fileService';
import { fileContentCache } from '../../src/core/fileContentCache';

/**
 * getConfig() answers from a memo, because it is asked once per file handled
 * and answering costs about a third of a millisecond -- parsing ssh_config and
 * compiling the ignore rules every time, from inputs that do not move.
 *
 * The memo is only worth having if it cannot go stale, which is what these
 * assert: the things that legitimately change the answer still change it.
 */

let workDir: string;
const at = (...parts: string[]) => path.join(workDir, ...parts);

function service(over: Record<string, unknown> = {}) {
  return new FileService(workDir, workDir, {
    host: 'example.com',
    // Left out on purpose: an explicit value wins over ssh_config, so this is
    // the field the ssh_config section is observed through.
    remotePath: '/srv/app',
    protocol: 'sftp',
    sshConfigPath: at('ssh_config'),
    ...over,
  } as never);
}

beforeEach(async () => {
  workDir = await fse.mkdtemp(path.join(os.tmpdir(), 'syncx-memo-'));
  await fse.outputFile(at('ssh_config'), 'Host example.com\n  User from-ssh-config\n');
});

afterEach(async () => {
  fileContentCache.delete(at('ssh_config'));
  await fse.remove(workDir);
});

describe('answers that must stay the same', () => {
  test('repeated calls agree', () => {
    const fileService = service();
    expect(fileService.getConfig().username).toBe(fileService.getConfig().username);
  });

  test('the ssh_config section is applied, memo or no memo', () => {
    expect(service().getConfig().username).toBe('from-ssh-config');
  });
});

describe('answers that must change', () => {
  test('editing ~/.ssh/config takes effect once the cache is dropped', async () => {
    // What the save handler does: drop the path, which bumps the generation the
    // memo is keyed on.
    const fileService = service();
    expect(fileService.getConfig().username).toBe('from-ssh-config');

    await fse.outputFile(at('ssh_config'), 'Host example.com\n  User edited\n');
    fileContentCache.delete(at('ssh_config'));

    expect(fileService.getConfig().username).toBe('edited');
  });

  test('a profile is answered with its own configuration', () => {
    const fileService = service({
      profiles: {
        staging: { host: 'staging.example.com' },
        production: { host: 'prod.example.com' },
      },
    });

    expect(fileService.getConfig('staging').host).toBe('staging.example.com');
    expect(fileService.getConfig('production').host).toBe('prod.example.com');
    // Back again: one memo entry per profile, not one entry overwritten.
    expect(fileService.getConfig('staging').host).toBe('staging.example.com');
  });

  test('switching the active profile switches the answer', () => {
    let active: string | undefined;
    const fileService = service({
      profiles: { staging: { host: 'staging.example.com' }, prod: { host: 'prod.example.com' } },
    });
    fileService.setActiveProfileProvider(() => active);

    active = 'staging';
    expect(fileService.getConfig().host).toBe('staging.example.com');
    active = 'prod';
    expect(fileService.getConfig().host).toBe('prod.example.com');
  });

  test('getAllConfig answers for every profile', () => {
    const fileService = service({
      profiles: { staging: { host: 'staging.example.com' }, prod: { host: 'prod.example.com' } },
    });

    expect(fileService.getAllConfig().map(config => config.host).sort()).toEqual([
      'prod.example.com',
      'staging.example.com',
    ]);
  });
});

describe('failures are not memoised', () => {
  test('an invalid configuration reports itself every time', () => {
    // Caching a throw would make the first call the only one that explains
    // itself, and a later fix would look like it had not been picked up.
    const fileService = service();
    let calls = 0;
    fileService.setConfigValidator(() => {
      calls += 1;
      return { message: 'host is required' };
    });

    expect(() => fileService.getConfig()).toThrow(/host is required/);
    expect(() => fileService.getConfig()).toThrow(/host is required/);
    expect(calls).toBe(2);
  });

  test('an unknown profile keeps throwing', () => {
    const fileService = service({ profiles: { staging: { host: 'staging.example.com' } } });

    expect(() => fileService.getConfig('nope')).toThrow(/Unkown Profile/);
    expect(() => fileService.getConfig('nope')).toThrow(/Unkown Profile/);
  });
});
