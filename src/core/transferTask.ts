import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'stream';
import * as fileOperations from './fileBaseOperations';
import { FileSystem, FileType } from './fs';
import { Task } from './scheduler';
import logger from './logger';

let hasWarnedModifedTimePermission = false;

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  /**
   * Size of the source file, where the caller already knows it.
   *
   * Optional on purpose: the callers that walk a directory get it from the
   * listing they already have, and the single-file path from the lstat it
   * already does, but nothing should take an extra round trip just to be able
   * to show a percentage.
   */
  size?: number;
}

/** Bytes moved so far, and the total when it is known. */
export type TransferProgressListener = (transferred: number, total?: number) => void;

export default class TransferTask implements Task {
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _handle: Readable | undefined;
  private _cancelled = false;
  private _transferred = 0;
  private _onProgress?: TransferProgressListener;
  // private _fileStatus: FileStatus;

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  /** The source file's size, when the caller supplied it. */
  get size(): number | undefined {
    return this._TransferOption.size;
  }

  /**
   * Reports bytes as they move. Has to be installed before the task runs.
   *
   * The scheduler emits its start event before calling `run()`, which is the
   * window a listener has -- and the reason this is a method rather than a
   * constructor argument: the task is built by the code that walks the tree,
   * far from the code that draws progress.
   */
  trackProgress(listener: TransferProgressListener): void {
    this._onProgress = listener;
  }

  get transferType() {
    return this._transferDirection;
  }

  async run() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    switch (this.fileType) {
      case FileType.File:
        await this._transferFile();
        break;
      case FileType.SymbolicLink:
        await fileOperations.transferSymlink(src, target, srcFs, targetFs);
        break;
      default:
        logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
    }
  }

  /**
   * Marks the task cancelled and aborts its stream if there is one.
   *
   * The flag is set unconditionally. Previously the whole body was guarded on
   * `this._handle`, so cancelling a task before its source stream existed --
   * which is every task still queued, and every one in the window between
   * starting and opening the stream -- did nothing at all, and `isCancelled()`
   * kept reporting `undefined`. A Cancel button that silently misses the tasks
   * that have not started yet is the wrong way round: those are the easiest
   * ones to stop.
   */
  /**
   * Where to stage an upload before moving it into place.
   *
   * Unique per attempt: upstream used a fixed `<target>.new`, so two transfers
   * to the same path -- two profiles, a retry overlapping its predecessor --
   * wrote to one staging file and produced a corrupt result with no error.
   *
   * Named like rsync's: a leading dot hides it on Unix, and the suffix says
   * plainly what it is, so debris from a killed process is recognisable rather
   * than mysterious.
   */
  private _tempTargetPath(target: string): string {
    const resolver = (this._targetFs as unknown as {
      pathResolver: { dirname(p: string): string; basename(p: string): string; join(a: string, b: string): string };
    }).pathResolver;

    const dir = resolver.dirname(target);
    const name = resolver.basename(target);
    const unique = `${process.pid.toString(36)}${randomBytes(4).toString('hex')}`;
    return resolver.join(dir, `.${name}.syncx-${unique}.tmp`);
  }

  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    if (this._handle) {
      FileSystem.abortReadableStream(this._handle);
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  /**
   * Wraps the source so the bytes passing through it can be counted.
   *
   * A `data` listener on the source itself would be shorter, but listening
   * switches a stream to flowing mode at once, and the transports do not all
   * consume their input in the same tick -- the FTP one waits for its command
   * queue first -- so the opening chunks would be delivered to nobody. A
   * transform in the middle moves nothing until the transport pulls on it.
   */
  private _measured(source: Readable): Readable {
    const report = this._onProgress;
    if (!report) return source;

    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this._transferred += chunk.length;
        report(this._transferred, this.size);
        callback(null, chunk);
      },
    });

    // pipe() forwards neither errors nor an abort, and cancel() aborts the
    // source. Without this the transport would sit waiting for an end that is
    // never coming.
    source.on('error', error => counter.destroy(error));
    source.pipe(counter);
    return counter;
  }

  private async _transferFile() {
    // Cancelled while queued: do not start moving bytes.
    if (this._cancelled) return;

    // Staging files must be cleaned up on *every* failure path, including one
    // that happens while opening -- the target descriptor and the source stream
    // are opened together, so the staging file can exist before the transfer
    // body is ever entered.
    const staged: string[] = [];
    try {
      await this._runTransfer(staged);
    } catch (error) {
      for (const path of staged) {
        try {
          await this._targetFs.unlink(path);
        } catch {
          // It may never have been created.
        }
      }
      throw error;
    }
  }

  private async _runTransfer(staged: string[]) {

    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      openSsh,
      fallbackMode,
      atime,
      mtime,
      filePerm
    } = this._TransferOption;
    // Set the mode if it's specified in the config, otherwise get mode from server.
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd; // Destination file
    let uploadFd; // Temp file or destination file when no temp file is used
    // Not const: both can be stood down if the directory refuses a staging file.
    let useTempFile = this._TransferOption.useTempFile !== false;
    let uploadTarget = useTempFile ? this._tempTargetPath(target) : target;
    if (useTempFile) staged.push(uploadTarget);

    // Use mode first.
    // Then check perserveTargetMode and fallback to fallbackMode if fail to get mode of target
    if (mode === undefined && perserveTargetMode) {
      if (useTempFile) {
        [targetFd, uploadFd] = await Promise.all([
          targetFs.open(target, 'r')  // Get handle for reading the target mode
            .catch(() => null), // Return null if target file doesn't exist
          targetFs.open(uploadTarget, 'w')  // Get handle for the file upload
        ]);
      } else {
        targetFd = uploadFd = await targetFs.open(uploadTarget, 'w');
      }

      if (targetFd) {
        [this._handle, mode] = await Promise.all([
          srcFs.get(src),
          targetFs
            .fstat(targetFd)
            .then(stat => stat.mode)
            .catch(() => fallbackMode),
        ]);

        if (useTempFile) {
          targetFs.close(targetFd);
        }

      } else {
        this._handle = await srcFs.get(src);
        mode = fallbackMode;
      }

    } else {
      [this._handle, uploadFd] = await Promise.all([
        srcFs.get(src),
        targetFs.open(uploadTarget, 'w').catch(error => {
          if (!useTempFile) throw error;
          // Some directories allow overwriting an existing file but not
          // creating a new one. Falling back keeps those working, at the cost
          // of the atomicity the staging file was buying -- so it is logged,
          // not swallowed.
          logger.warn(
            `cannot stage ${uploadTarget} (${(error as Error).message}); ` +
              'writing directly to the target, which is not atomic'
          );
          useTempFile = false;
          uploadTarget = target;
          staged.length = 0;
          return targetFs.open(target, 'w');
        }),
      ]);
    }

    try {
      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      await targetFs.put(this._measured(this._handle), uploadTarget, {
        mode,
        fd: uploadFd,
        autoClose: false,
      });
      if (atime && mtime) {
        try {
          await targetFs.futimes(
            uploadFd,
            Math.floor(atime / 1000),
            Math.floor(mtime / 1000)
          );
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      if (useTempFile) {
        logger.info(`moving ${uploadTarget} to ${target}`);
        if (openSsh) {
          await targetFs.renameAtomic(uploadTarget, target);
        } else {
          // Rename first. On POSIX this replaces the target in one step, which
          // is the entire point of staging. Upstream unlinked the target first
          // and then renamed, which opens a window where the file does not
          // exist at all -- the opposite of atomic, and visible to anything
          // reading from the server at that moment.
          try {
            await targetFs.rename(uploadTarget, target);
          } catch (error) {
            // Windows refuses to rename onto an existing file, and some SFTP
            // servers do too. Removing first is the fallback, not the plan.
            try {
              await targetFs.unlink(target);
            } catch {
              // Not there after all.
            }
            await targetFs.rename(uploadTarget, target);
          }
        }
      }

      // Moved into place: there is nothing left to clean up.
      staged.length = 0;
    } finally {
      await targetFs.close(uploadFd);
    }
  }
}
