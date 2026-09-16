import { refreshRemoteExplorer, destinationOf } from './shared';
import { fileOperations } from '../core';
import createFileHandler from './createFileHandler';
import { ensureRemotePathApproved } from '../modules/remotePathApproval';
import { FileHandleOption } from './option';

/**
 * Creating an entry writes to the destination, so it asks the same question an
 * upload does.
 *
 * It used to ask nothing at all, and the watcher creates directories *before*
 * it uploads anything -- so with a mistyped `remotePath` the first thing to
 * happen on the server was a `mkdir` nobody had approved.
 */

export const createRemoteFile = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'createRemoteFile',
  async handle() {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;

    await ensureRemotePathApproved(destinationOf(this), remoteFs);

    const promise = fileOperations.createFile(remoteFsPath, remoteFs);

    /*
    const stat = await remoteFs.lstat(remoteFsPath);
    switch (stat.type) {
      case FileType.Directory:
        if (option.skipDir) {
          return;
        }
        promise = fileOperations.createDir(remoteFsPath, remoteFs);
        // promise = fileOperations.removeDir(remoteFsPath, remoteFs);
        break;
      case FileType.File:
      case FileType.SymbolicLink:
        // promise = fileOperations.removeFile(remoteFsPath, remoteFs);
        break;
      default:
        throw new Error(`Unsupported file type (type = ${stat.type})`);
    }*/
    await promise;
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.ignore,
    };
  },
  afterHandle() {
    void refreshRemoteExplorer(this.target, false);
  },
});

export const createRemoteFolder = createFileHandler<FileHandleOption & { skipDir?: boolean }>({
  name: 'createRemoteFolder',
  async handle() {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const { remoteFsPath } = this.target;

    await ensureRemotePathApproved(destinationOf(this), remoteFs);

    const promise = fileOperations.createDir(remoteFsPath, remoteFs);

    /*
    const stat = await remoteFs.lstat(remoteFsPath);
    switch (stat.type) {
      case FileType.Directory:
        if (option.skipDir) {
          return;
        }
        promise = fileOperations.createDir(remoteFsPath, remoteFs);
        // promise = fileOperations.removeDir(remoteFsPath, remoteFs);
        break;
      case FileType.File:
      case FileType.SymbolicLink:
        // promise = fileOperations.removeFile(remoteFsPath, remoteFs);
        break;
      default:
        throw new Error(`Unsupported file type (type = ${stat.type})`);
    }*/
    await promise;
  },
  transformOption() {
    const config = this.config;
    return {
      ignore: config.ignore,
    };
  },
  afterHandle() {
    void refreshRemoteExplorer(this.target, false);
  },
});
