import { describe, test, expect } from 'vitest';
import upath from '../../src/core/upath';
import FTPFileSystem from '../../src/core/fs/ftpFileSystem';

/**
 * How file names are decoded on an FTP control connection.
 *
 * `basic-ftp` assumes UTF-8, which is right for a modern server and wrong for
 * an older one. A server that answers in a single-byte code page produces names
 * that look like damage -- and worse, the paths built from those names address
 * nothing, so every operation on them fails for a reason that has nothing to do
 * with the file. It is the complaint behind "the Chinese directory is garbled"
 * upstream, and there was no way to say otherwise.
 *
 * Needs the FTP container: SYNCX_CONTRACT_FTP=1.
 */

const enabled = Boolean(process.env.SYNCX_CONTRACT_FTP);

const option = {
  host: process.env.SYNCX_CONTRACT_FTP_HOST ?? '127.0.0.1',
  port: Number(process.env.SYNCX_CONTRACT_FTP_PORT ?? 2121),
  username: process.env.SYNCX_CONTRACT_FTP_USER ?? 'syncx',
  password: process.env.SYNCX_CONTRACT_FTP_PASSWORD ?? 'syncx-test',
  debug: () => undefined,
};

/** The encoding the live connection ended up using. */
async function encodingOf(extra: Record<string, unknown>): Promise<string> {
  const fs = new FTPFileSystem(upath, {
    clientOption: { ...option, ...extra } as never,
    remoteTimeOffsetInHours: 0,
  });
  await fs.connect({ ...option, ...extra } as never, { askForPasswd: async () => undefined });

  const client = (
    fs as unknown as { getClient(): { getFsClient(): { ftp: { encoding: string } } } }
  )
    .getClient()
    .getFsClient();

  const encoding = client.ftp.encoding;
  fs.end();
  return encoding;
}

describe.skipIf(!enabled)('ftp file name encoding', () => {
  test('defaults to UTF-8, as basic-ftp does', async () => {
    expect(await encodingOf({})).toBe('utf8');
  }, 20_000);

  test('a configured encoding reaches the connection', async () => {
    expect(await encodingOf({ encoding: 'latin1' })).toBe('latin1');
  }, 20_000);

  test('and the connection still works with it', async () => {
    const fs = new FTPFileSystem(upath, {
      clientOption: { ...option, encoding: 'latin1' } as never,
      remoteTimeOffsetInHours: 0,
    });
    await fs.connect({ ...option, encoding: 'latin1' } as never, {
      askForPasswd: async () => undefined,
    });

    await expect(fs.list('/')).resolves.toBeInstanceOf(Array);
    fs.end();
  }, 20_000);
});
