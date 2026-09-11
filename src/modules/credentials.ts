import * as vscode from 'vscode';
import logger from '../logger';
import {
  credentialKey,
  describeIdentity,
  type CredentialIdentity,
  type CredentialKind,
  type CredentialStore,
} from '../core/credentials';

/**
 * Passwords, kept in the editor's SecretStorage rather than in the workspace.
 *
 * Upstream reads the password straight out of `.vscode/sftp.json`, which is a
 * file people commit. Neither fork changed that for existing configs; sftp-neo
 * added SecretStorage but under a key with no protocol and no port, so an FTP
 * and an SFTP account for the same `user@host` silently overwrite each other.
 *
 * A plaintext `password` in the config still works. This is additive: when
 * there is none, the user is asked, and -- only after the password has proved
 * to work -- offered somewhere better than a tracked file to keep it.
 */

let secrets: vscode.SecretStorage | null = null;

export function initializeCredentials(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
}

export const credentialStore: CredentialStore = {
  async get(identity, kind) {
    if (!secrets) return undefined;
    try {
      return await secrets.get(credentialKey(identity, kind));
    } catch (error) {
      // An unavailable keychain must not block connecting; the user is asked
      // instead, which is what would have happened anyway.
      logger.warn('[credentials] could not read from SecretStorage', error);
      return undefined;
    }
  },

  async store(identity, kind, value) {
    if (!secrets) return;
    try {
      await secrets.store(credentialKey(identity, kind), value);
      logger.info(`[credentials] remembered the ${kind} for ${describeIdentity(identity)}`);
    } catch (error) {
      logger.warn('[credentials] could not write to SecretStorage', error);
      void vscode.window.showWarningMessage(
        'SyncX could not save the password to the system keychain. You will be asked again next time.'
      );
    }
  },

  async forget(identity, kind) {
    if (!secrets) return;
    try {
      await secrets.delete(credentialKey(identity, kind));
    } catch (error) {
      logger.warn('[credentials] could not delete from SecretStorage', error);
    }
  },
};

/**
 * Asks whether to remember a password that has just worked.
 *
 * Deliberately not a silent save: a password is the user's to place, and an
 * editor extension quietly copying one into a system keychain is not a
 * decision to make on their behalf.
 */
export async function offerToRemember(identity: CredentialIdentity): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `Save the password for ${describeIdentity(identity)}?`,
    {
      detail:
        'It goes to the editor\'s secret storage, which is the system keychain -- ' +
        'not into .vscode/sftp.json, which is usually committed.',
      modal: false,
    },
    'Save',
    'Not now'
  );
  return choice === 'Save';
}

/** Drops every credential SyncX has stored for one identity. */
export async function forgetAll(identity: CredentialIdentity): Promise<void> {
  const kinds: CredentialKind[] = ['password', 'passphrase'];
  for (const kind of kinds) {
    await credentialStore.forget(identity, kind);
  }
}
