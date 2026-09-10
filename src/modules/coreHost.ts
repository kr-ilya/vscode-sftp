import app from '../app';
import { promptForPassword, getUserSetting } from '../host';
import { setRemoteFsHost } from '../core/remoteFs';
import { setNamedRemoteResolver } from '../core/fileService';
import { SETTING_KEY_REMOTE } from '../constants';

/**
 * Supplies src/core with the host capabilities it declares: asking the user for
 * a password, reporting connection progress, and resolving a named remote from
 * user settings.
 *
 * This is the composition root for that dependency -- core declares the shape,
 * the editor layer provides it, and neither imports the other's internals.
 */
export function installCoreHost(): void {
  setRemoteFsHost({
    promptForPassword,
    onConnecting: timeoutMs => app.sftpBarItem.showMsg('connecting...', timeoutMs),
    onConnected: () => app.sftpBarItem.reset(),
  });

  setNamedRemoteResolver(name =>
    getUserSetting(SETTING_KEY_REMOTE).get<Record<string, any>>(name)
  );
}
