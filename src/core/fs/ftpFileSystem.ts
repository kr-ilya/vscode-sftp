import { PassThrough, Readable, Writable } from 'stream';
import { Client, FileInfo, FileType as FtpFileType, FTPError } from 'basic-ftp';
import {
  ASSUMED_MODE,
  formatMfmtTimestamp,
  toFileStat,
  toFileType,
} from './ftpMapping';
import logger from '../logger';
import { FileEntry, FileType, FileStats, FileOption } from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import { FTPClient } from '../remote-client';
import { createSerialQueue } from '../util/serialQueue';

/**
 * The FTP side of the RemoteFileSystem contract, on `basic-ftp`.
 *
 * Everything goes through one serial queue: FTP has a single control
 * connection, so a second command issued while the first is in flight corrupts
 * the exchange. basic-ftp enforces that by throwing; the queue makes the
 * enforcement unnecessary.
 *
 * Several contract methods have no FTP equivalent. They are implemented as the
 * closest honest thing rather than silently pretending -- see each one.
 */

/** FTP has no file descriptors; the path is the handle. */
interface FtpFileHandle {
  path: string;
  flags: string;
  mode?: number;
}

export default class FTPFileSystem extends RemoteFileSystem {
  /** Set false the first time the server rejects MFMT, so we stop asking. */
  private supportsMfmt = true;
  private readonly queue = createSerialQueue();

  static getFileType(type: FtpFileType): FileType {
    return toFileType(type);
  }

  private get ftp(): Client {
    return (this.getClient() as FTPClient).getFsClient();
  }

  /** Runs one FTP command with the control connection to itself. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.run(task);
  }

  _createClient(option): FTPClient {
    return new FTPClient(option);
  }

  toFileStat(info: FileInfo): FileStats {
    return toFileStat(info, ms => this.toLocalTime(ms));
  }

  toFileEntry(fullPath: string, info: FileInfo): FileEntry {
    return {
      fspath: fullPath,
      name: info.name,
      ...this.toFileStat(info),
    };
  }

  /**
   * FTP has no stat command, so a file's metadata comes from listing its
   * parent. That is what makes lstat comparatively expensive here.
   */
  async lstat(path: string): Promise<FileStats> {
    if (path === '/') {
      return { type: FileType.Directory, mode: ASSUMED_MODE, size: 0, mtime: 0, atime: 0 };
    }

    const parentPath = this.pathResolver.dirname(path);
    const name = this.pathResolver.basename(path);
    const entries = await this.list(parentPath);
    const found = entries.find(entry => entry.name === name);

    if (!found) {
      throw enoent(path);
    }
    return found;
  }

  open(path: string, flags: string, mode?: number): Promise<FtpFileHandle> {
    return Promise.resolve({ path, flags, mode });
  }

  close(_fd: FtpFileHandle): Promise<void> {
    return Promise.resolve();
  }

  fstat(fd: FtpFileHandle): Promise<FileStats> {
    return this.lstat(fd.path);
  }

  /**
   * Sets the modification time via MFMT, where the server supports it.
   *
   * Many do not. A failure is recorded once and then not retried, because
   * asking on every transfer costs a round trip for a command that will fail
   * again. Not being able to preserve a timestamp is not a transfer failure.
   */
  async futimes(fd: FtpFileHandle, _atime: number, mtime: number): Promise<void> {
    if (!this.supportsMfmt) return;

    const stamp = formatMfmtTimestamp(new Date(this.toRemoteTimeInSecnonds(mtime) * 1000));
    try {
      await this.exclusive(() => this.ftp.send(`MFMT ${stamp} ${fd.path}`));
    } catch {
      logger.info('[ftp] server does not support MFMT; timestamps will not be preserved');
      this.supportsMfmt = false;
    }
  }

  /**
   * FTP transfers write into a stream rather than handing one back, so the
   * download is piped through a PassThrough.
   *
   * The queue slot is held for the whole transfer: the data connection belongs
   * to the control connection that opened it, so another command in between
   * would break both.
   */
  async get(path: string, _option?: FileOption): Promise<Readable> {
    const through = new PassThrough();

    // Deliberately not awaited: the caller needs the stream now, and the
    // transfer completes as it is consumed.
    void this.exclusive(async () => {
      try {
        await this.ftp.downloadTo(through as Writable, path);
      } catch (error) {
        through.destroy(error as Error);
      }
    });

    return through;
  }

  async put(input: Readable, path: string, _option?: FileOption): Promise<void> {
    return this.exclusive(async () => {
      try {
        await this.ftp.uploadFrom(input, path);
      } catch (error) {
        // A source that failed mid-transfer is the more useful error to report
        // than the FTP-side symptom it caused.
        throw (input as Readable & { _syncxError?: Error })._syncxError ?? error;
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    // Not part of FTP itself; SITE CHMOD is a widely implemented extension.
    await this.exclusive(() => this.ftp.send(`SITE CHMOD ${mode.toString(8)} ${path}`));
  }

  async mkdir(dir: string): Promise<void> {
    await this.exclusive(() => this.ftp.send(`MKD ${dir}`));
  }

  /**
   * basic-ftp's own ensureDir changes the working directory as it walks, which
   * would make every other path in flight relative to somewhere unexpected.
   * This creates the chain without moving.
   */
  async ensureDir(dir: string): Promise<void> {
    let stat: FileStats | undefined;
    try {
      stat = await this.lstat(dir);
    } catch {
      // Not there, which is the case this method exists for.
    }

    if (stat) {
      if (stat.type !== FileType.Directory) {
        throw new Error(`${dir} exists and is not a directory`);
      }
      return;
    }

    const parent = this.pathResolver.dirname(dir);
    if (parent !== dir) {
      await this.ensureDir(parent);
    }

    try {
      await this.mkdir(dir);
    } catch (error) {
      // 550 here usually means "already exists" -- another transfer in the same
      // batch got there first. Confirm rather than assume.
      const stillMissing = await this.lstat(dir).catch(() => undefined);
      if (!stillMissing || stillMissing.type !== FileType.Directory) throw error;
    }
  }

  async list(dir: string, _option?): Promise<FileEntry[]> {
    const entries = await this.exclusive(() => this.ftp.list(dir));

    return entries
      .filter(item => item.name && item.name !== '.' && item.name !== '..')
      .map(item => this.toFileEntry(this.pathResolver.join(dir, item.name), item));
  }

  /** FTP exposes a link target only through the listing, if at all. */
  async readlink(path: string): Promise<string> {
    const stat = await this.lstat(path);
    if (!stat.target) {
      throw new Error(`${path} is not a symbolic link, or the server does not report the target`);
    }
    return stat.target;
  }

  /**
   * Not expressible in FTP. Refusing is honest: upstream resolved silently,
   * so a sync that should have reported "cannot create this link" reported
   * success and produced nothing.
   */
  symlink(_targetPath: string, _path: string): Promise<void> {
    return Promise.reject(new Error('FTP cannot create symbolic links'));
  }

  async unlink(path: string): Promise<void> {
    await this.exclusive(() => this.ftp.remove(path));
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      await this.exclusive(() => this.ftp.removeDir(path));
      return;
    }
    await this.exclusive(() => this.ftp.send(`RMD ${path}`));
  }

  async rename(srcPath: string, destPath: string): Promise<void> {
    await this.exclusive(() => this.ftp.rename(srcPath, destPath));
  }

  /**
   * FTP's RNFR/RNTO is not atomic and does not replace an existing target on
   * most servers, so this is rename with the same caveats -- named separately
   * because the SFTP side genuinely can do better.
   */
  async renameAtomic(srcPath: string, destPath: string): Promise<void> {
    await this.rename(srcPath, destPath);
  }
}

function enoent(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${path}: no such file or directory`);
  error.code = 'ENOENT';
  return error;
}

/** Exposed for the error-mapping tests. */
export function isNotFound(error: unknown): boolean {
  if (error instanceof FTPError) return error.code === 550;
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
