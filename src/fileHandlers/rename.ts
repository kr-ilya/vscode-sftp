import { fileOperations } from '../core';
import { toRemotePath } from '../helper';
import createFileHandler from './createFileHandler';

/**
 * Renames a file on the server, instead of deleting it and uploading it again.
 *
 * Two things were wrong here, identically in upstream:
 *
 *  - Both paths handed to the remote `rename` were *local* ones. It asked the
 *    server to rename `D:\project\new.ts` to `D:\project\old.ts` -- paths that
 *    do not exist there -- so every rename failed.
 *  - The direction was inverted: the new path was passed as the source and the
 *    old one as the destination.
 *
 * `newLocalPath` is the file's new location on disk; the handler's own target
 * is its old one, so both remote paths are derived from the same mapping.
 */
export const renameRemote = createFileHandler<{ newLocalPath: string }>({
  name: 'rename',
  async handle({ newLocalPath }) {
    const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
    const from = this.target.remoteFsPath;
    const to = toRemotePath(newLocalPath, this.fileService.baseDir, this.config.remotePath);

    await fileOperations.rename(from, to, remoteFs);
  },
});
