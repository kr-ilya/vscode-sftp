import { describe, test, expect } from 'vitest';
import {
  assessRemotePath,
  destinationKey,
  describeDestination,
  type RemoteDestination,
} from '../../src/core/remotePathGuard';

const destination = (over: Partial<RemoteDestination> = {}): RemoteDestination => ({
  protocol: 'sftp',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  remotePath: '/var/www/site',
  ...over,
});

describe('paths that are never what was meant', () => {
  test.each(['/', '', '   '])('the server root (%s)', path => {
    expect(assessRemotePath(path).risk).toBe('system');
  });

  test.each(['/etc', '/usr', '/bin', '/boot', '/root', '/sys', '/proc'])(
    'the system directory %s',
    path => {
      expect(assessRemotePath(path).risk).toBe('system');
    }
  );

  test('inside a system directory', () => {
    // `/etc/nginx` is a plausible-looking typo for a config deployment and
    // still somewhere a project does not belong.
    expect(assessRemotePath('/etc/nginx').risk).toBe('system');
    expect(assessRemotePath('/usr/local/share').risk).toBe('system');
  });

  test.each(['C:', 'C:/', 'd:'])('a bare drive root (%s)', path => {
    expect(assessRemotePath(path).risk).toBe('system');
  });

  test('each carries a reason the prompt can show', () => {
    for (const path of ['/', '/etc', '/usr/local']) {
      expect(assessRemotePath(path).reason).toBeTruthy();
    }
  });
});

describe('paths that are plausible but broad', () => {
  test.each(['/home', '/srv', '/opt', '/tmp', '/www', '/var'])(
    '%s is a question, not an alarm',
    path => {
      // A project can legitimately sit directly under one of these.
      expect(assessRemotePath(path).risk).toBe('broad');
    }
  );

  test('but what lives under them is ordinary', () => {
    // `/var/www/site` is the single most common deployment target there is. A
    // guard that objects to the ordinary case gets clicked through, and then it
    // is not guarding anything.
    expect(assessRemotePath('/var/www/site').risk).toBe('ordinary');
    expect(assessRemotePath('/home/deploy/app').risk).toBe('ordinary');
  });
});

describe('ordinary paths', () => {
  test.each([
    '/var/www/site',
    '/home/deploy/app',
    '/srv/http/example.com',
    '/opt/apps/api',
    'relative/path',
  ])('%s raises nothing', path => {
    expect(assessRemotePath(path).risk).toBe('ordinary');
    expect(assessRemotePath(path).reason).toBeUndefined();
  });

  test('a trailing separator does not change the verdict', () => {
    expect(assessRemotePath('/var/www/site/').risk).toBe('ordinary');
    expect(assessRemotePath('/etc/').risk).toBe('system');
  });

  test('case does not change the verdict', () => {
    expect(assessRemotePath('/ETC').risk).toBe('system');
  });
});

describe('destinationKey', () => {
  test('approving a path on one server does not approve it on another', () => {
    expect(destinationKey(destination({ host: 'a.com' }))).not.toBe(
      destinationKey(destination({ host: 'b.com' }))
    );
  });

  test.each([
    ['protocol', { protocol: 'ftp' }],
    ['port', { port: 2222 }],
    ['username', { username: 'root' }],
    ['remotePath', { remotePath: '/var/www/other' }],
  ])('a different %s is a different destination', (_label, over) => {
    expect(destinationKey(destination())).not.toBe(destinationKey(destination(over)));
  });

  test('the same destination always produces the same key', () => {
    // It has to: a key that varies would ask on every single upload.
    expect(destinationKey(destination())).toBe(destinationKey(destination()));
  });

  test('a trailing separator is the same destination', () => {
    expect(destinationKey(destination({ remotePath: '/var/www/site/' }))).toBe(
      destinationKey(destination({ remotePath: '/var/www/site' }))
    );
  });

  test('a value containing the separator cannot forge another key', () => {
    const a = destinationKey(destination({ host: 'a', username: 'b|c' }));
    const b = destinationKey(destination({ host: 'a|b', username: 'c' }));
    expect(a).not.toBe(b);
  });
});

describe('describeDestination', () => {
  test('names everything needed to recognise the target', () => {
    const described = describeDestination(destination({ port: 2222, remotePath: '/srv/app/' }));
    expect(described).toContain('/srv/app');
    expect(described).toContain('deploy');
    expect(described).toContain('example.com');
    expect(described).toContain('2222');
  });
});
