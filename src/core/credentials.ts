/**
 * Identifying a stored credential.
 *
 * The whole of this module is the key, and the key is the whole of the problem.
 * sftp-neo stores secrets under `sftp-neo:{host}:{username}:{type}` -- no
 * protocol, no port -- so an FTP account and an SFTP account for the same
 * `user@host` overwrite each other's password, as do two SSH servers on the
 * same host at different ports. That is not a theoretical collision: a bastion
 * on 2222 beside a service on 22 is an ordinary arrangement.
 *
 * Pure, so the key format is directly testable and cannot drift silently.
 */

export type CredentialKind = 'password' | 'passphrase';

export interface CredentialIdentity {
  protocol: string;
  host: string;
  port: number;
  username: string;
}

/**
 * A stable key for one credential.
 *
 * Every field that can distinguish two accounts is present, and each is escaped
 * so that a value containing the separator cannot be read as a field boundary
 * -- a username of `a:b` must not collide with a host of `b`.
 */
export function credentialKey(identity: CredentialIdentity, kind: CredentialKind): string {
  const parts = [
    'syncx',
    kind,
    identity.protocol,
    identity.host,
    String(identity.port),
    identity.username,
  ];
  return parts.map(escapeField).join(':');
}

function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** How the credential is described to the user when asking to save it. */
export function describeIdentity(identity: CredentialIdentity): string {
  const { protocol, host, port, username } = identity;
  return `${username}@${host}:${port} (${protocol})`;
}

export interface CredentialStore {
  get(identity: CredentialIdentity, kind: CredentialKind): Promise<string | undefined>;
  store(identity: CredentialIdentity, kind: CredentialKind, value: string): Promise<void>;
  forget(identity: CredentialIdentity, kind: CredentialKind): Promise<void>;
}

/**
 * Used when no store has been installed.
 *
 * Remembering nothing is the right default: it degrades to the previous
 * behaviour -- prompt every time -- rather than to storing secrets somewhere
 * unintended.
 */
export const noCredentialStore: CredentialStore = {
  async get() {
    return undefined;
  },
  async store() {
    /* nothing is remembered */
  },
  async forget() {
    /* nothing was remembered */
  },
};
