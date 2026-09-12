import { FileService, FileType } from '../core';
import UResource from '../uResource';
import app from '../app';
import logger from '../logger';

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
