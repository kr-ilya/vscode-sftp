import { COMMAND_CREATE_FOLDER } from '../constants';
import { createRemoteFolder } from '../fileHandlers';
import { checkFileCommand } from './abstract/createCommand';
import { promptForNewEntryUri, uriFromExplorerContextOrEditorContext } from './shared';

export default checkFileCommand({
  id: COMMAND_CREATE_FOLDER,

  async getFileTarget(item, items) {
    const parent = uriFromExplorerContextOrEditorContext(item, items);
    if (!parent) {
      return undefined;
    }

    return promptForNewEntryUri(parent, 'Please input folder name');
  },

  handleFile: createRemoteFolder,
});
