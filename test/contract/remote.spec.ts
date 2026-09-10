import { describe } from 'vitest';
import upath from '../../src/core/upath';
import SFTPFileSystem from '../../src/core/fs/sftpFileSystem';
import FTPFileSystem from '../../src/core/fs/ftpFileSystem';
import { runFileSystemContract } from './fileSystemContract';

/**
 * The same contract, against real servers.
 *
 * Skipped unless the corresponding environment variable is set, because these
 * need the containers in test/fixtures/docker to be up. `npm test` therefore
 * stays hermetic and fast, while the suite that actually proves SFTP and FTP
 * are interchangeable is one command away.
 *
 * Status: written, never executed. The docker fixtures have not been brought up
 * yet, so treat a first run as debugging the harness as much as the transport.
 */

const sftpEnabled = Boolean(process.env.SYNCX_CONTRACT_SFTP);
const ftpEnabled = Boolean(process.env.SYNCX_CONTRACT_FTP);

describe.skipIf(!sftpEnabled)('sftp file system', () => {
  runFileSystemContract(async () => {
    const fs = new SFTPFileSystem(upath, {
      clientOption: {
        host: process.env.SYNCX_CONTRACT_SFTP_HOST ?? '127.0.0.1',
        port: Number(process.env.SYNCX_CONTRACT_SFTP_PORT ?? 2222),
        username: process.env.SYNCX_CONTRACT_SFTP_USER ?? 'syncx',
        password: process.env.SYNCX_CONTRACT_SFTP_PASSWORD ?? 'syncx-test',
        debug: () => undefined,
      } as never,
      remoteTimeOffsetInHours: 0,
    });

    return {
      name: 'sftp',
      fs,
      root: `/config/contract-${Date.now()}`,
      // SFTP does all three; that is the baseline the FTP side is measured
      // against.
      capabilities: { symlinks: true, setTimes: true, chmod: true },
      async setup() {
        await fs.connect(
          {
            host: process.env.SYNCX_CONTRACT_SFTP_HOST ?? '127.0.0.1',
            port: Number(process.env.SYNCX_CONTRACT_SFTP_PORT ?? 2222),
            username: process.env.SYNCX_CONTRACT_SFTP_USER ?? 'syncx',
            password: process.env.SYNCX_CONTRACT_SFTP_PASSWORD ?? 'syncx-test',
            debug: () => undefined,
          } as never,
          { askForPasswd: async () => undefined }
        );
      },
      async teardown() {
        fs.end();
      },
    };
  });
});

describe.skipIf(!ftpEnabled)('ftp file system', () => {
  runFileSystemContract(async () => {
    const option = {
      host: process.env.SYNCX_CONTRACT_FTP_HOST ?? '127.0.0.1',
      port: Number(process.env.SYNCX_CONTRACT_FTP_PORT ?? 2121),
      username: process.env.SYNCX_CONTRACT_FTP_USER ?? 'syncx',
      password: process.env.SYNCX_CONTRACT_FTP_PASSWORD ?? 'syncx-test',
      debug: () => undefined,
    };
    const fs = new FTPFileSystem(upath, {
      clientOption: option as never,
      remoteTimeOffsetInHours: 0,
    });

    return {
      name: 'ftp',
      fs,
      root: `/contract-${Date.now()}`,
      capabilities: {
        // FTP has no symbolic links at all; the contract asserts the operation
        // is refused rather than silently doing nothing.
        symlinks: false,
        // MFMT is an extension. vsftpd has it; plenty of servers do not.
        setTimes: true,
        // SITE CHMOD is likewise an extension, and Windows servers lack it.
        chmod: true,
      },
      async setup() {
        await fs.connect(option as never, { askForPasswd: async () => undefined });
      },
      async teardown() {
        fs.end();
      },
    };
  });
});
