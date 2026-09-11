import * as vscode from 'vscode';
import { COMMAND_FORGET_PASSWORD } from '../constants';
import { getAllFileService } from '../modules/serviceManager';
import { forgetAll } from '../modules/credentials';
import { describeIdentity, type CredentialIdentity } from '../core/credentials';
import { checkCommand } from './abstract/createCommand';

/**
 * Drops a remembered password.
 *
 * Necessary rather than decorative: a password that has been remembered and
 * later changed on the server would otherwise be retried on every connection
 * with no way to clear it from inside the editor.
 */
export default checkCommand({
  id: COMMAND_FORGET_PASSWORD,

  async handleCommand() {
    const identities = collectIdentities();
    if (identities.length === 0) {
      await vscode.window.showInformationMessage('SyncX: no configured servers found.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      identities.map(identity => ({ label: describeIdentity(identity), identity })),
      { placeHolder: 'Forget the saved password for which server?' }
    );
    if (!picked) return;

    await forgetAll(picked.identity);
    await vscode.window.showInformationMessage(
      `SyncX: forgot the saved credentials for ${picked.label}.`
    );
  },
});

function collectIdentities(): CredentialIdentity[] {
  const seen = new Map<string, CredentialIdentity>();

  for (const service of getAllFileService()) {
    for (const config of service.getAllConfig()) {
      if (!config.host || !config.username) continue;
      const identity: CredentialIdentity = {
        protocol: config.protocol ?? 'sftp',
        host: config.host,
        port: config.port ?? (config.protocol === 'ftp' ? 21 : 22),
        username: config.username,
      };
      seen.set(describeIdentity(identity), identity);
    }
  }

  return [...seen.values()];
}
