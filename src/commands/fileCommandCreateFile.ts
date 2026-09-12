import { COMMAND_CREATE_FILE } from '../constants';
import { createRemoteFile } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { promptForNewEntryUri, uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_CREATE_FILE,

  async getFileTarget(item, items) {
    const parent = uriFromExplorerContextOrEditorContext(item, items);
    if (!parent) {
      return undefined;
    }

    return promptForNewEntryUri(parent, 'Please input file name');
  },

  handleFile: createRemoteFile,
});
