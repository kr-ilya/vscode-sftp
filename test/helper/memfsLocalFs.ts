import * as fs from 'fs';
import { promisify } from 'util';
import LocalFileSystem from '../../src/core/fs/localFileSystem';
import type { FileStats } from '../../src/core/fs/fileSystem';

/**
 * A LocalFileSystem whose every call goes through `fs`.
 *
 * `vi.mock('fs')` redirects `fs` to memfs, but it cannot redirect `fs-extra`:
 * that is a package in node_modules, it reaches the real `fs` through
 * `graceful-fs`, and neither `server.deps.inline` nor mocking the specifier
 * changes what it sees -- verified by probing it. So the eight methods of
 * LocalFileSystem that are implemented with fs-extra escaped the mock and wrote
 * to the actual disk.
 *
 * That is not theoretical: the transfer tests create their trees at `/local`
 * and `/remote`, so on Windows they had been writing real files into the root
 * of the drive, and on Linux they fail with `EACCES: mkdir '/remote'`, which is
 * how CI found it.
 *
 * Overriding here rather than changing the source: the production
 * implementation is fine, and swapping its file access for the sake of a test
 * would touch the path every transfer takes.
 */

const open = promisify(fs.open);
const close = promisify(fs.close);
const fstat = promisify(fs.fstat);
const futimes = promisify(fs.futimes);
const rename = promisify(fs.rename);

export default class MemfsLocalFileSystem extends LocalFileSystem {
  open(path: string, flags: string, mode?: number): Promise<number> {
    return open(path, flags, mode) as Promise<number>;
  }

  close(fd: number): Promise<void> {
    return close(fd) as Promise<void>;
  }

  fstat(fd: number): Promise<FileStats> {
    return (fstat(fd) as Promise<fs.Stats>).then(stat => this.toFileStat(stat));
  }

  futimes(fd: number, atime: number, mtime: number): Promise<void> {
    return futimes(fd, atime, mtime) as Promise<void>;
  }

  /** What fse.ensureDir does, on the `fs` the test can see. */
  ensureDir(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.mkdir(dir, { recursive: true }, error => (error ? reject(error) : resolve()));
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    if (!recursive) {
      return super.rmdir(path, false);
    }
    return new Promise((resolve, reject) => {
      fs.rm(path, { recursive: true, force: true }, error =>
        error ? reject(error) : resolve()
      );
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return rename(srcPath, destPath) as Promise<void>;
  }

  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return this.rename(srcPath, destPath);
  }
}
