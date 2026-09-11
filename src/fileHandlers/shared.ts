import { FileService, FileType } from '../core';
import UResource from '../uResource';
import app from '../app';
import logger from '../logger';

// NEED_VSCODE_UPDATE: detect explorer view visible
// refresh will open explorer view which cause a problem https://github.com/liximomo/vscode-sftp/issues/286
// export function refreshLocalExplorer(localUri: Uri) {
//   // do nothing
// }

export async function refreshRemoteExplorer(target: UResource, isDirectory: FileService | boolean) {
  if (isDirectory instanceof FileService) {
    const fileService = isDirectory;
    const localFs = fileService.getLocalFileSystem();
    const fileEntry = await localFs.lstat(target.localFsPath);
    isDirectory = fileEntry.type === FileType.Directory;
  }

  try {
    await app.remoteExplorer.refresh({
      resource: UResource.makeResource(target.remoteUri),
      isDirectory,
    });
  } catch (error) {
    // Every caller fires this and moves on, so anything thrown here used to
    // arrive as an unhandled rejection -- an error on screen for an operation
    // that had already succeeded. A tree that could not redraw is not a failed
    // upload.
    logger.debug('[explorer] could not refresh the remote explorer', error);
  }
}
