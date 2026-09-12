import { describe, test, expect } from 'vitest';
import {
  createFileDescriptorLimit,
  DEFAULT_OPEN_FD_LIMIT,
} from '../../src/core/remote-client/fileDescriptorLimit';

/**
 * The cap on descriptors open at once on the server.
 *
 * This had no tests at all, because it lived inside SSHClient patching methods
 * on a live ssh2 object. Reading it once it could be tested turned up three
 * defects, each of which has a test below.
 */

/** A stand-in for ssh2's `open`: hands back a handle, or an error, on demand. */
function fakeOpen() {
  const pending: Array<(error: Error | null, handle?: string) => void> = [];
  const paths: string[] = [];

  const open = function (this: unknown, path: string, callback: (e: Error | null, h?: string) => void) {
    paths.push(path);
    pending.push(callback);
    return true;
  };

  return {
    open,
    paths,
    get outstanding() {
      return pending.length;
    },
    succeed(index = 0) {
      pending.splice(index, 1)[0](null, `handle-${index}`);
    },
    fail(index = 0, message = 'No such file') {
      pending.splice(index, 1)[0](new Error(message));
    },
  };
}

/** Runs deferred work synchronously, so tests do not have to await ticks. */
const immediately = (run: () => void) => run();

describe('reserving a descriptor', () => {
  test('is done when the call goes out, not when the reply comes back', async () => {
    // The count used to rise in the callback, so a burst of concurrent opens
    // all passed the check while it was still zero -- which is the one case the
    // limit exists for.
    const server = fakeOpen();
    const limit = createFileDescriptorLimit(2, immediately);
    const open = limit.guardAcquire(server.open);

    open('a', () => undefined);
    open('b', () => undefined);
    open('c', () => undefined);

    expect(server.paths).toEqual(['a', 'b']);
    expect(limit.waiting).toBe(1);
  });

  test('a waiting call goes out when a descriptor is closed', () => {
    const server = fakeOpen();
    const closes: Array<(e: Error | null) => void> = [];
    const close = function (_handle: string, callback: (e: Error | null) => void) {
      closes.push(callback);
    };

    const limit = createFileDescriptorLimit(1, immediately);
    const guardedOpen = limit.guardAcquire(server.open);
    const guardedClose = limit.guardRelease(close);

    guardedOpen('a', () => undefined);
    guardedOpen('b', () => undefined);
    expect(server.paths).toEqual(['a']);

    server.succeed();
    guardedClose('handle-0', () => undefined);
    closes[0](null);

    expect(server.paths).toEqual(['a', 'b']);
  });

  test('waiting calls go out in the order they arrived', () => {
    // They were released newest first, so under sustained pressure the oldest
    // request need never run at all.
    const server = fakeOpen();
    const limit = createFileDescriptorLimit(1, immediately);
    const open = limit.guardAcquire(server.open);
    const close = limit.guardRelease(function (_h: string, cb: (e: Error | null) => void) {
      cb(null);
    });

    for (const path of ['a', 'b', 'c', 'd']) open(path, () => undefined);
    expect(server.paths).toEqual(['a']);

    close('h', () => undefined);
    close('h', () => undefined);
    close('h', () => undefined);

    expect(server.paths).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('a failed open', () => {
  test('gives its reservation back', () => {
    // It used to take one and keep it forever. Opening a path that is not there
    // is an ordinary event, so a long enough session would end with the count
    // stuck at the limit and every request queued behind a descriptor that was
    // never open -- a client that stops transferring and never recovers.
    const server = fakeOpen();
    const limit = createFileDescriptorLimit(1, immediately);
    const open = limit.guardAcquire(server.open);

    open('missing', () => undefined);
    server.fail();

    expect(limit.reserved).toBe(0);

    open('next', () => undefined);
    expect(server.paths).toEqual(['missing', 'next']);
  });

  test('lets a waiting call through', () => {
    const server = fakeOpen();
    const limit = createFileDescriptorLimit(1, immediately);
    const open = limit.guardAcquire(server.open);

    open('missing', () => undefined);
    open('next', () => undefined);
    expect(server.paths).toEqual(['missing']);

    server.fail();

    expect(server.paths).toEqual(['missing', 'next']);
  });

  test('the error still reaches the caller unchanged', () => {
    const server = fakeOpen();
    const limit = createFileDescriptorLimit(1, immediately);
    const open = limit.guardAcquire(server.open);
    const seen: unknown[] = [];

    open('missing', (error: unknown) => seen.push(error));
    server.fail(0, 'No such file');

    expect((seen[0] as Error).message).toBe('No such file');
  });
});

describe('staying transparent', () => {
  test('arguments and the handle are passed through untouched', () => {
    const calls: unknown[][] = [];
    const limit = createFileDescriptorLimit(4, immediately);
    const open = limit.guardAcquire(function (...args: unknown[]) {
      calls.push(args.slice(0, -1));
      (args[args.length - 1] as (e: null, h: string) => void)(null, 'the-handle');
      return true;
    });
    const received: unknown[] = [];

    open('/some/path', 'w', { mode: 0o644 }, (error: unknown, handle: unknown) =>
      received.push(error, handle)
    );

    expect(calls[0]).toEqual(['/some/path', 'w', { mode: 0o644 }]);
    expect(received).toEqual([null, 'the-handle']);
  });

  test('the call keeps the receiver it was invoked on', () => {
    // These wrappers are installed as methods on ssh2's SFTP stream, and the
    // function underneath reads its own state off `this`.
    const limit = createFileDescriptorLimit(4, immediately);
    const stream = {
      marker: 'the stream',
      seen: null as unknown,
      open(this: { marker: string; seen: unknown }, _path: string, callback: () => void) {
        this.seen = this.marker;
        callback();
      },
    };
    stream.open = limit.guardAcquire(stream.open);

    stream.open('a', () => undefined);

    expect(stream.seen).toBe('the stream');
  });

  test('the callback keeps it too', () => {
    const limit = createFileDescriptorLimit(4, immediately);
    const stream = {
      marker: 'the stream',
      seenInCallback: null as unknown,
      open(_path: string, callback: (e: null) => void) {
        callback(null);
      },
    };
    stream.open = limit.guardAcquire(stream.open);

    stream.open.call(stream, 'a', function (this: typeof stream) {
      stream.seenInCallback = this?.marker;
    } as never);

    expect(stream.seenInCallback).toBe('the stream');
  });
});

describe('releasing', () => {
  test('a descriptor is only given back once its close has answered', () => {
    const limit = createFileDescriptorLimit(4, immediately);
    let answer: (e: Error | null) => void = () => undefined;
    const close = limit.guardRelease(function (_h: string, cb: (e: Error | null) => void) {
      answer = cb;
    });
    const open = limit.guardAcquire(function (_p: string, cb: (e: null, h: string) => void) {
      cb(null, 'h');
    });

    open('a', () => undefined);
    expect(limit.reserved).toBe(1);

    close('h', () => undefined);
    expect(limit.reserved).toBe(1);

    answer(null);
    expect(limit.reserved).toBe(0);
  });

  test('the next call starts only after the close callback has returned', () => {
    // Releasing from inside the callback would start the next request before
    // the one that freed the descriptor had finished reporting.
    const order: string[] = [];
    const deferred: Array<() => void> = [];
    const limit = createFileDescriptorLimit(1, run => deferred.push(run));

    const open = limit.guardAcquire(function (path: string, cb: (e: null, h: string) => void) {
      order.push(`open ${path}`);
      cb(null, 'h');
    });
    const close = limit.guardRelease(function (_h: string, cb: (e: null) => void) {
      cb(null);
    });

    open('a', () => undefined);
    open('b', () => undefined);
    close('h', () => order.push('close reported'));

    expect(order).toEqual(['open a', 'close reported']);
    deferred.forEach(run => run());
    expect(order).toEqual(['open a', 'close reported', 'open b']);
  });
});

describe('the default', () => {
  test('is upstream\'s, so behaviour does not change for anyone relying on it', () => {
    expect(DEFAULT_OPEN_FD_LIMIT).toBe(222);
  });

  test('an unlimited-looking number still holds the line', () => {
    const server = fakeOpen();
    const limit = createFileDescriptorLimit(DEFAULT_OPEN_FD_LIMIT, immediately);
    const open = limit.guardAcquire(server.open);

    for (let i = 0; i < 300; i += 1) open(`file-${i}`, () => undefined);

    expect(server.outstanding).toBe(DEFAULT_OPEN_FD_LIMIT);
    expect(limit.waiting).toBe(300 - DEFAULT_OPEN_FD_LIMIT);
  });
});
