import { FileService, FileType } from '../core';
import type { RemoteDestination } from '../core/remotePathGuard';
import type { FileHandlerContext } from './createFileHandler';
import UResource from '../uResource';
import app from '../app';
import logger from '../logger';

/**
 * The destination a write would land in, as configured.
 *
 * Built from `config.remotePath` rather than from the file's own remote path:
 * the question the guard asks is whether the *configuration* points where it
 * was meant to, not whether one particular file does.
 */
export function destinationOf(context: FileHandlerContext): RemoteDestination {
  const { config } = context;
  return {
    protocol: config.protocol ?? 'sftp',
    host: config.host,
    port: config.port ?? (config.protocol === 'ftp' ? 21 : 22),
    username: config.username ?? '',
    remotePath: config.remotePath,
  };
}

/**
 * Redraws the remote explorer after an operation.
 *
 * Called and deliberately not awaited -- the transfer it follows has already
 * succeeded -- which is why every failure is contained here rather than left to
 * become an unhandled rejection at each call site.
 */
export async function refreshRemoteExplorer(
  target: UResource,
  isDirectory: FileService | boolean
): Promise<void> {
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
