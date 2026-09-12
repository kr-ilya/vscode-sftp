import { describe, test, expect } from 'vitest';
import { Readable } from 'stream';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import FTPFileSystem from '../../src/core/fs/ftpFileSystem';
import { setHostVerifierFactory } from '../../src/core/remote-client/hostVerification';
import { runFileSystemContract, type ContractCapabilities } from './fileSystemContract';

/**
 * The same contract, against real servers.
 *
 * Skipped unless the corresponding environment variable is set, because these
 * need the containers in test/fixtures/docker to be up:
 *
 *   docker compose -f test/fixtures/docker/docker-compose.yml up -d --wait
 *   SYNCX_CONTRACT_SFTP=1 SYNCX_CONTRACT_FTP=1 npm test
 *
 * `npm test` therefore stays hermetic and fast, while the suite that actually
 * proves SFTP and FTP are interchangeable is one command away.
 */

/** A round trip to a container is orders of magnitude slower than memory. */
const REMOTE_TIMEOUT_MS = 30_000;

const text = (content: string) => Readable.from([Buffer.from(content, 'utf8')]);

const sftpEnabled = Boolean(process.env.SYNCX_CONTRACT_SFTP);
const ftpEnabled = Boolean(process.env.SYNCX_CONTRACT_FTP);

const sftpOption = {
  host: process.env.SYNCX_CONTRACT_SFTP_HOST ?? '127.0.0.1',
  port: Number(process.env.SYNCX_CONTRACT_SFTP_PORT ?? 2222),
  username: process.env.SYNCX_CONTRACT_SFTP_USER ?? 'syncx',
  password: process.env.SYNCX_CONTRACT_SFTP_PASSWORD ?? 'syncx-test',
  debug: () => undefined,
};

const ftpOption = {
  host: process.env.SYNCX_CONTRACT_FTP_HOST ?? '127.0.0.1',
  port: Number(process.env.SYNCX_CONTRACT_FTP_PORT ?? 2121),
  username: process.env.SYNCX_CONTRACT_FTP_USER ?? 'syncx',
  password: process.env.SYNCX_CONTRACT_FTP_PASSWORD ?? 'syncx-test',
  debug: () => undefined,
};

/**
 * The host key check refuses by default when no verifier is installed -- that
 * is the point of it, and the reason this suite could not connect until it said
 * so explicitly. A throwaway container is exactly the case where accepting any
 * key is correct, so the opt-in is here rather than a weaker default there.
 */
function acceptAnyHostKey(): void {
  setHostVerifierFactory(() => (_key, callback) => callback(true));
}

describe.skipIf(!sftpEnabled)('sftp file system', () => {
  runFileSystemContract(async () => {
    acceptAnyHostKey();
    const fs = new SFTPFileSystem(upath, {
      clientOption: sftpOption as never,
      remoteTimeOffsetInHours: 0,
    });

    return {
      name: 'sftp',
      fs,
      // linuxserver/openssh-server puts the account's home at /config.
      root: `${process.env.SYNCX_CONTRACT_SFTP_ROOT ?? '/config'}/contract-${Date.now()}`,
      // SFTP does all three; that is the baseline the FTP side is measured
      // against.
      capabilities: { symlinks: true, setTimes: true, chmod: true },
      async setup() {
        await fs.connect(sftpOption as never, { askForPasswd: async () => undefined });
      },
      async teardown() {
        fs.end();
      },
    };
  }, REMOTE_TIMEOUT_MS);
});

describe.skipIf(!ftpEnabled)('ftp file system', () => {
  runFileSystemContract(async () => {
    const fs = new FTPFileSystem(upath, {
      clientOption: ftpOption as never,
      remoteTimeOffsetInHours: 0,
    });

    await fs.connect(ftpOption as never, { askForPasswd: async () => undefined });

    return {
      name: 'ftp',
      fs,
      // The server is not chrooted: `/` is the real root, which the account
      // cannot write to. Its home is where a client actually lands.
      root: `${process.env.SYNCX_CONTRACT_FTP_ROOT ?? '/home/syncx'}/contract-${Date.now()}`,
      // Detected rather than assumed -- which of these an FTP server has varies
      // per server, and hard-coding the answer would mean either skipping a
      // capability this one does have or failing on one it does not.
      capabilities: await detectFtpCapabilities(fs),
      async teardown() {
        fs.end();
      },
    };
  }, REMOTE_TIMEOUT_MS);
});

async function detectFtpCapabilities(fs: FTPFileSystem): Promise<ContractCapabilities> {
  const features = await fs.getClient().getFsClient().features();
  return {
    // FTP has no notion of symbolic links at all.
    symlinks: false,
    // MFMT is an extension. This container reports EPRT, EPSV, MDTM, PASV,
    // REST, SIZE, TVFS and UTF8 -- and no MFMT, which is exactly the common
    // case the transport has to degrade gracefully for.
    setTimes: features.has('MFMT'),
    // SITE CHMOD is not advertised through FEAT, so it has to be tried.
    chmod: await supportsSiteChmod(fs),
  };
}

async function supportsSiteChmod(fs: FTPFileSystem): Promise<boolean> {
  try {
    await fs.getClient().getFsClient().send('SITE HELP');
    return true;
  } catch {
    return false;
  }
}

/**
 * `limitOpenFilesOnRemote` against a real sshd.
 *
 * The limiter wraps ssh2's own handle calls, so nothing but a real server
 * exercises the path it sits in. With the cap set to one, every listing and
 * every read has to queue behind the last -- if the accounting is wrong in
 * either direction this either deadlocks or stops limiting.
 */
describe.skipIf(!sftpEnabled)('limiting open file descriptors', () => {
  const LIMIT = 1;
  const root = `${process.env.SYNCX_CONTRACT_SFTP_ROOT ?? '/config'}/fdlimit-${Date.now()}`;

  test(
    'transfers still complete with the cap set to one',
    async () => {
      acceptAnyHostKey();
      const fs = new SFTPFileSystem(upath, {
        clientOption: { ...sftpOption, limitOpenFilesOnRemote: LIMIT } as never,
        remoteTimeOffsetInHours: 0,
      });
      await fs.connect(
        { ...sftpOption, limitOpenFilesOnRemote: LIMIT } as never,
        { askForPasswd: async () => undefined }
      );

      try {
        await fs.ensureDir(root);

        // Concurrent, so they contend for the single descriptor.
        const names = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => `${root}/${n}.txt`);
        await Promise.all(names.map(name => fs.put(text(name), name)));

        const listed = (await fs.list(root)).map(item => item.name).sort();
        expect(listed).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']);

        // A failed open used to keep its reservation forever, so this is where
        // a cap of one would wedge permanently.
        await expect(fs.lstat(`${root}/not-there.txt`)).rejects.toBeTruthy();
        await expect(fs.lstat(`${root}/also-not-there.txt`)).rejects.toBeTruthy();

        const stillWorks = await fs.list(root);
        expect(stillWorks).toHaveLength(6);

        await fs.rmdir(root, true);
      } finally {
        fs.end();
      }
    },
    REMOTE_TIMEOUT_MS
  );
});
