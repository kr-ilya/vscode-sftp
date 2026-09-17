import { describe, test, expect } from 'vitest';
import { FileService } from '../../src/core';
import type { WatcherService } from '../../src/core/fileService';

/**
 * What names the change-detection state belonging to a watcher.
 *
 * It carried the service's id -- a counter over the life of the process. Every
 * save of `sftp.json` rebuilds the services, so every save produced a new name:
 * the state recorded a moment ago was never found again, the whole tree was
 * hashed afresh on the next event, and the file it had been written to was left
 * behind in global storage. A month of ordinary editing leaves a directory full
 * of them.
 */

const base = {
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/srv/www',
  watcher: { files: '**/*', autoUpload: true, autoDelete: false },
};

/** The scope a freshly built service hands to the watcher, as a reload would. */
function scopeOf(config: Record<string, unknown>, profile = ''): string {
  const service = new FileService('D:\\work\\site', 'D:\\work\\site', config as never);
  service.setActiveProfileProvider(() => profile);

  let captured = '';
  const watcherService: WatcherService = {
    create: (_base, _config, context) => {
      captured = context.scope;
    },
    dispose: () => undefined,
  };
  service.setWatcherService(watcherService);

  return captured;
}

describe('the same configuration', () => {
  test('keeps its state across a reload', () => {
    // Two services built from one configuration are what a save of sftp.json
    // produces. They must look at the same state.
    expect(scopeOf(base)).toBe(scopeOf(base));
  });

  test('three reloads in a row still agree', () => {
    const scopes = [scopeOf(base), scopeOf(base), scopeOf(base)];

    expect(new Set(scopes).size).toBe(1);
  });

  test('settings that do not change where files go do not change it', () => {
    expect(scopeOf({ ...base, uploadOnSave: true, concurrency: 8 })).toBe(scopeOf(base));
  });
});

describe('a different destination is different state', () => {
  // State says "the server has these bytes". Said of another server, or another
  // directory on the same one, it is not true -- and a stale yes is the one
  // answer this mechanism must never give.
  test.each([
    ['another host', { host: 'other.example.com' }],
    ['another port', { port: 2222 }],
    ['another user', { username: 'someone-else' }],
    ['another remote path', { remotePath: '/srv/other' }],
    ['another protocol', { protocol: 'ftp', port: 21 }],
  ])('%s', (_label, difference) => {
    expect(scopeOf({ ...base, ...difference })).not.toBe(scopeOf(base));
  });

  test('and so is another profile', () => {
    expect(scopeOf(base, 'staging')).not.toBe(scopeOf(base, 'production'));
  });
});
