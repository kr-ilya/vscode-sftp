import { Readable, Writable } from 'stream';
import FileSystem, {
  FileEntry,
  FileType,
  FileStats,
  FileOption,
} from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import { remoteFailure } from './remoteError';
import { SSHClient } from '../remote-client';

type FileHandle = Buffer;

interface SFTPFileDescriptor {
  handle: FileHandle;
  path: string;
}

interface WriteStream extends Writable {
  handle: Buffer;
  path: string;
  flags: string;
  mode: number;
  close(): void;
}

function toSimpleFileMode(mode: number) {
  return mode & parseInt('777', 8); // tslint:disable-line:no-bitwise
}

export default class SFTPFileSystem extends RemoteFileSystem {
  get sftp() {
    return this.getClient().getFsClient();
  }

  toFileStat(stat): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      mode: toSimpleFileMode(stat.mode), // tslint:disable-line:no-bitwise
      size: stat.size,
      mtime: this.toLocalTime(stat.mtime * 1000),
      atime: this.toLocalTime(stat.atime * 1000),
    };
  }

  toFileEntry(fullPath, item): FileEntry {
    return {
      fspath: fullPath,
      name: item.filename,
      ...this.toFileStat(item.attrs),
    };
  }

  _createClient(option) {
    return new SSHClient(option);
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, stat) => {
        if (err) {
          reject(remoteFailure('lstat', path, err));
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  open(
    path: string,
    flags: string,
    mode?: number
  ): Promise<SFTPFileDescriptor> {
    return new Promise((resolve, reject) => {
      this.sftp.open(path, flags, mode, (err, handle) => {
        if (err) {
          return reject(remoteFailure(`open (${flags})`, path, err));
        }

        resolve({
          path,
          handle,
        });
      });
    });
  }

  close(fd: SFTPFileDescriptor): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.close(fd.handle, err => {
        if (err) {
          reject(remoteFailure('close', fd.path, err));
          return;
        }

        resolve();
      });
    });
  }

  fstat(fd: SFTPFileDescriptor): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.fstat(fd.handle, (err, stat) => {
        if (err) {
          // Try stat() for sftp servers that may not support fstat() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.stat(fd.path, (_err, _stat) => {
            if (_err) {
              reject(remoteFailure('fstat', fd.path, err));
              return;
            }

            resolve(this.toFileStat(_stat));
          });
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  futimes(fd: SFTPFileDescriptor, atime: number, mtime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.futimes(
        fd.handle,
        this.toRemoteTimeInSecnonds(atime),
        this.toRemoteTimeInSecnonds(mtime),
        err => {
          if (err) {
            reject(remoteFailure('set times on', fd.path, err));
            return;
          }

          resolve();
        }
      );
    });
  }

  fchmod(fd: SFTPFileDescriptor, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fchmod(fd.handle, mode, err => {
        if (err) {
          // Try chmod() for sftp servers that may not support fchmod() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.chmod(fd.path, mode, _err => {
            if (_err) {
              reject(remoteFailure('chmod', fd.path, err));
              return;
            }

            resolve();
          });
          return;
        }

        resolve();
      });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(path, mode, err => {
        if(err) {
          reject(remoteFailure('chmod', path, err))
          return
        }
        resolve();
      });
    })
  }

  get(path, option?: FileOption): Promise<Readable> {
    return new Promise((resolve, reject) => {
      // const opt = { ...option, autoDestroy: false };
      try {
        // const stream = this.sftp.createReadStream(path, opt);
        const stream = this.sftp.createReadStream(path, option);
        resolve(stream);
      } catch (err) {
        reject(remoteFailure('read', path, err));
      }
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(srcPath, destPath, err => {
        if (err) {
          return reject(remoteFailure('rename', `${srcPath} -> ${destPath}`, err));
        }

        resolve();
      });
    });
  }

  // See: https://github.com/mscdex/ssh2/issues/1054
  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(srcPath, destPath, err => {
        if (err) {
          return reject(remoteFailure('rename (posix-rename)', `${srcPath} -> ${destPath}`, err));
        }

        resolve();
      });
    });
  }

  async put(input: Readable, path, option?: FileOption): Promise<void> {
    if (option && option.fd) {
      const fd = option.fd as SFTPFileDescriptor;
      // const opt = { ...option, handle: fd.handle, autoDestroy: false };
      const opt = { ...option, handle: fd.handle };
      delete opt.fd;

      if (opt.mode) {
        // mode will get ignored if handle passed in.
        // call chmod manunally.
        try {
          await this.fchmod(fd, opt.mode);
        } catch {
          // ignore error
        }
      }

      return this._put(input, path, opt);
    }

    return this._put(input, path, option);
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.readlink(path, (err, linkString) => {
        if (err) {
          reject(remoteFailure('readlink', path, err));
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.symlink(targetPath, path, err => {
        if (err) {
          reject(remoteFailure('symlink', `${path} -> ${targetPath}`, err));
          return;
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, err => {
        if (err) {
          reject(remoteFailure('mkdir', dir, err));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Treats "it is already a directory" as success, and anything else as the
   * failure that was originally reported.
   */
  private async _acceptExistingDirectory(dir: string, original: unknown): Promise<void> {
    try {
      const stat = await this.lstat(dir);
      if (stat.type !== FileType.Directory) throw original;
    } catch {
      // A failed stat is stranger than the original error; report that one.
      throw original;
    }
  }

  async ensureDir(dir: string): Promise<void> {
    // test is root path
    // win: c:/, c://, c:\, c:\\
    // *nix: /
    if (dir === '/' || dir.match(/^[a-zA-Z]:(\/|\\)\1?$/)) {
      return;
    }

    let err;
    try {
      await this.mkdir(dir);
      return;
    } catch (error) {
      // avoid nested code block
      err = error;
    }

    switch (err.code) {
      case 2: {
        const parentPath = this.pathResolver.dirname(dir);
        if (parentPath === dir) throw err;
        await this.ensureDir(parentPath);
        try {
          await this.mkdir(dir);
        } catch (afterParent) {
          // It can have appeared while the parent was being created: two
          // transfers into the same new folder walk the same chain, and the
          // one that loses gets "failure" from a directory that now exists.
          // Unguarded, this made concurrent uploads into one directory fail.
          await this._acceptExistingDirectory(dir, afterParent);
        }
        break;
      }

      // Any other error: see whether a directory is there already. If so, then
      // hooray; if not, something is genuinely wrong.
      default:
        await this._acceptExistingDirectory(dir, err);
        break;
    }
  }

  list(dir: string): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, result) => {
        if (err) {
          reject(remoteFailure('list', dir, err));
          return;
        }

        const fileEntries = result.map(item =>
          this.toFileEntry(this.pathResolver.join(dir, item.filename), item)
        );
        resolve(fileEntries);
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.unlink(path, err => {
        if (err) {
          reject(remoteFailure('unlink', path, err));
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!recursive) {
        this.sftp.rmdir(path, err => {
          if (err) {
            reject(remoteFailure('rmdir', path, err));
            return;
          }
          resolve();
        });
        return;
      }

      this.list(path).then(
        fileEntries => {
          if (!fileEntries.length) {
            this.rmdir(path, false).then(resolve, e => {
              reject(e);
            });
            return;
          }

          const rmPromises = fileEntries.map(file => {
            if (file.type === FileType.Directory) {
              return this.rmdir(file.fspath, true);
            }
            return this.unlink(file.fspath);
          });

          Promise.all(rmPromises)
            .then(() => this.rmdir(path, false))
            .then(resolve, e => {
              // BUG just reject will occur weird bug.
              reject(e);
            });
        },
        err => {
          reject(err);
        }
      );
    });
  }

  private _put(
    input: Readable,
    path,
    option?: {
      flags?: string;
      encoding?: string;
      mode?: number;
      autoClose?: boolean;
      handle?: FileHandle;
    }
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const writer: WriteStream = this.sftp.createWriteStream(path, option);

      // Settle on whichever terminal event arrives, not on 'finish' alone.
      // ssh2's SFTP write stream destroys itself inside _final when autoClose
      // is on -- which is the default -- and a destroyed stream emits 'close'
      // instead of 'finish'. Waiting only for 'finish' therefore hung forever
      // on a transfer that had in fact completed: every caller that did not
      // pass `autoClose: false` explicitly, which includes creating a file on
      // the server.
      writer.once('error', err => reject(remoteFailure('write', path, err)));
      writer.once('finish', resolve);
      writer.once('close', resolve);

      input.once('error', err => {
        reject(err);
        writer.end();
      });
      input.pipe(writer);
    });
  }
}
