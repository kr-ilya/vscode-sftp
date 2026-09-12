import { COMMAND_LIST_ALL } from '../constants';
import { showTextDocument } from '../host';
import logger from '../logger';
import { FileType } from '../core';
import { downloadFile, downloadFolder } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { selectFileFromAll } from './shared';

export default checkFileCommand({
  id: COMMAND_LIST_ALL,
  getFileTarget: selectFileFromAll,

  async handleFile(ctx) {
    const remotefs = await ctx.fileService.getRemoteFileSystem(ctx.config);
    const fileEntry = await remotefs.lstat(ctx.target.remoteFsPath);
    if (fileEntry.type !== FileType.Directory) {
      await downloadFile(ctx, { ignore: null });
      try {
        await showTextDocument(ctx.target.localUri);
      } catch (error) {
        // Showing the file is a convenience; the download itself succeeded.
        logger.debug('could not open the downloaded file', error);
      }
    } else {
      await downloadFolder(ctx, { ignore: null });
    }
  },
});
