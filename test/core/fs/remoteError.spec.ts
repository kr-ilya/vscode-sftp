import { describe, test, expect } from 'vitest';
import {
  RemoteOperationError,
  remoteFailure,
  underlying,
} from '../../../src/core/fs/remoteError';

/**
 * Saying what failed, and where.
 *
 * The report that prompted this read `Error: Failure` and nothing else -- SFTP
 * status 4, the catch-all, arriving through a stack made entirely of the
 * transport library's own frames. Neither the operation nor the remote path was
 * anywhere in it, so the only way to find out what had happened was to
 * reproduce it.
 */

function serverError(message: string, code?: number | string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe('the message', () => {
  test('puts the operation and the path in front of what the server said', () => {
    const error = remoteFailure('mkdir', '/srv/www/site', serverError('Failure'));

    expect((error as Error).message).toBe('mkdir /srv/www/site: Failure');
  });

  test('keeps the server text, which is sometimes the informative part', () => {
    const error = remoteFailure('open (w)', '/srv/www/x.php', serverError('Permission denied'));

    expect((error as Error).message).toContain('Permission denied');
    expect((error as Error).message).toContain('/srv/www/x.php');
  });

  test('stands alone when the transport said nothing at all', () => {
    const error = remoteFailure('rmdir', '/srv/www/site', serverError(''));

    expect((error as Error).message).toBe('rmdir /srv/www/site');
  });

  test('describes a move by both of its paths', () => {
    const error = remoteFailure('rename', '/tmp/a.tmp -> /srv/a', serverError('Failure'));

    expect((error as Error).message).toBe('rename /tmp/a.tmp -> /srv/a: Failure');
  });
});

describe('what callers still need from it', () => {
  test('the status code survives, because the code branches on it', () => {
    // `ensureDir` reads code 2 as "no parent" and builds the chain. Losing it
    // would turn a missing directory into a hard failure.
    const error = remoteFailure('mkdir', '/srv/a/b', serverError('No such file', 2));

    expect((error as RemoteOperationError).code).toBe(2);
  });

  test('so does the transport error itself, underneath', () => {
    const cause = serverError('550 Not found', 550);

    expect(underlying(remoteFailure('list', '/srv', cause))).toBe(cause);
  });

  test('underlying passes through anything that was never wrapped', () => {
    const plain = serverError('ENOENT');

    expect(underlying(plain)).toBe(plain);
  });
});

describe('operations that call each other', () => {
  test('a failure keeps the description it was given first', () => {
    // `ensureDir` retries `mkdir`, and a recursive `rmdir` walks itself. Adding
    // a second layer would report the outermost path for a failure that
    // happened several levels down -- which is the defect this replaces, in a
    // new form.
    const inner = remoteFailure('mkdir', '/srv/a/b/c', serverError('Failure'));

    const outer = remoteFailure('ensureDir', '/srv/a', inner);

    expect(outer).toBe(inner);
    expect((outer as Error).message).toBe('mkdir /srv/a/b/c: Failure');
  });
});
