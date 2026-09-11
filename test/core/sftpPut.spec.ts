import { describe, test, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';

/**
 * How `put` decides a transfer is finished.
 *
 * ssh2's SFTP write stream destroys itself inside `_final` when `autoClose` is
 * on, which is the default:
 *
 *     WriteStream.prototype._final = function(cb) {
 *       if (this.autoClose) this.destroy();
 *       cb();
 *     };
 *
 * A destroyed stream emits `close` and never `finish`. `put` waited for
 * `finish` alone, so it hung forever on a transfer that had already completed
 * -- for every caller that did not pass `autoClose: false` explicitly, which
 * includes creating a file on the server.
 *
 * The real thing is covered by the contract suite, but that needs a server. A
 * stand-in reproduces the exact stream behaviour here so the regression is
 * caught by `npm test`.
 */

/** A writable that behaves the way ssh2's does for a given autoClose. */
class Ssh2LikeWriteStream extends Writable {
  readonly written: Buffer[] = [];

  constructor(private readonly autoClose: boolean) {
    super();
  }

  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.autoClose) this.destroy();
    callback();
  }
}

function makeFileSystem(autoClose: boolean) {
  const streams: Ssh2LikeWriteStream[] = [];

  // `sftp` is a getter over the client's session, so the client is what gets
  // substituted -- which is also the seam RemoteFileSystem already offers.
  const session = {
    createWriteStream(_path: string, option?: { autoClose?: boolean }) {
      const stream = new Ssh2LikeWriteStream(option?.autoClose ?? autoClose);
      streams.push(stream);
      return stream;
    },
  };
  const client = { getFsClient: () => session } as never;

  return { fs: new SFTPFileSystem(upath, { client }), streams };
}

describe('put settles when the transfer is over', () => {
  test('resolves for a stream that destroys itself instead of finishing', async () => {
    const { fs, streams } = makeFileSystem(true);

    await fs.put(Readable.from([Buffer.from('hello')]), '/remote/a.txt');

    expect(Buffer.concat(streams[0].written).toString()).toBe('hello');
  });

  test('resolves for a stream the caller will close itself', async () => {
    // `autoClose: false` is the path TransferTask takes, and the only one that
    // ever emitted `finish`. It has to keep working.
    const { fs, streams } = makeFileSystem(false);

    await fs.put(Readable.from([Buffer.from('hello')]), '/remote/a.txt', {
      autoClose: false,
    } as never);

    expect(Buffer.concat(streams[0].written).toString()).toBe('hello');
  });

  test('empty content still settles', async () => {
    const { fs } = makeFileSystem(true);
    await expect(fs.put(Readable.from([]), '/remote/empty.txt')).resolves.toBeUndefined();
  });

  test('content larger than one chunk settles', async () => {
    const { fs, streams } = makeFileSystem(true);
    const big = Buffer.alloc(200_000, 0x61);

    await fs.put(Readable.from([big]), '/remote/big.txt');

    expect(Buffer.concat(streams[0].written).length).toBe(big.length);
  });

  test('a failing source rejects rather than hanging', async () => {
    const { fs } = makeFileSystem(true);
    const failing = new Readable({
      read() {
        this.destroy(new Error('source went away'));
      },
    });

    await expect(fs.put(failing, '/remote/a.txt')).rejects.toThrow('source went away');
  });
});
