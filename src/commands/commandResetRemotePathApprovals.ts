import * as vscode from 'vscode';
import { COMMAND_RESET_REMOTE_PATH_APPROVALS } from '../constants';
import { resetApprovals } from '../modules/remotePathApproval';
import { checkCommand } from './abstract/createCommand';

/**
 * Makes SyncX ask again before the next upload to each destination.
 *
 * Needed because the confirmation is remembered: a destination approved by
 * reflex, or approved and later repointed, would otherwise never be questioned
 * again.
 */
export default checkCommand({
  id: COMMAND_RESET_REMOTE_PATH_APPROVALS,

  async handleCommand() {
    const count = await resetApprovals();
    await vscode.window.showInformationMessage(
      count === 0
        ? 'SyncX: no upload destinations had been confirmed.'
        : `SyncX: cleared ${count} confirmed destination(s). You will be asked again before the next upload.`
    );
  },
});
