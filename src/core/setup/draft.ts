import { validateConfig } from '../config';

/**
 * The values a setup wizard collects, and turning them into a configuration.
 *
 * Pure, so the field rules and the shape of what gets written are testable
 * without an editor. The wizard itself only asks the questions.
 */

export type AuthMethod = 'password' | 'privateKey' | 'agent';

export interface ConnectionDraft {
  name?: string;
  protocol: 'sftp' | 'ftp';
  host: string;
  port?: number;
  username: string;
  authMethod: AuthMethod;
  /** Never written to the config file; handed to secret storage instead. */
  password?: string;
  privateKeyPath?: string;
  remotePath: string;
  uploadOnSave: boolean;
}

export function defaultPort(protocol: ConnectionDraft['protocol']): number {
  return protocol === 'ftp' ? 21 : 22;
}

/** Field-level rules, used to validate each prompt as it is typed. */
export const fieldRules = {
  host(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return 'A hostname or IP address is required.';
    if (/\s/.test(trimmed)) return 'A hostname cannot contain spaces.';
    if (/^[a-z]+:\/\//i.test(trimmed)) return 'Enter just the hostname, without a scheme.';
    return undefined;
  },

  port(value: string): string | undefined {
    if (!value.trim()) return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'A port is a whole number between 1 and 65535.';
    }
    return undefined;
  },

  username(value: string): string | undefined {
    return value.trim() ? undefined : 'A username is required.';
  },

  remotePath(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return 'A remote path is required.';
    // A Windows-style path here is the sign of a path copied from the local
    // side, which is the mistake that sends a project somewhere unintended.
    if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('\\')) {
      return 'This looks like a local path. The remote path uses forward slashes.';
    }
    return undefined;
  },
} as const;

/**
 * The configuration to write.
 *
 * The password is deliberately absent: it goes to secret storage, so it does
 * not end up in a file that is usually committed. Defaults that match the
 * built-in ones are left out too -- a config file should say what is different
 * about this project, not restate the defaults.
 */
export function draftToConfig(draft: ConnectionDraft): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: draft.name?.trim() || undefined,
    host: draft.host.trim(),
    protocol: draft.protocol,
    port: draft.port ?? defaultPort(draft.protocol),
    username: draft.username.trim(),
    remotePath: draft.remotePath.trim(),
  };

  if (draft.authMethod === 'privateKey' && draft.privateKeyPath) {
    config.privateKeyPath = draft.privateKeyPath.trim();
  }
  if (draft.authMethod === 'agent') {
    config.agent = '$SSH_AUTH_SOCK';
  }
  if (draft.uploadOnSave) {
    config.uploadOnSave = true;
  }

  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key];
  }
  return config;
}

/** The connection options to try before anything is written. */
export function draftToConnectOption(draft: ConnectionDraft): Record<string, unknown> {
  return {
    host: draft.host.trim(),
    port: draft.port ?? defaultPort(draft.protocol),
    username: draft.username.trim(),
    password: draft.password,
    privateKeyPath: draft.authMethod === 'privateKey' ? draft.privateKeyPath?.trim() : undefined,
    agent: draft.authMethod === 'agent' ? '$SSH_AUTH_SOCK' : undefined,
  };
}

/**
 * Checks the finished draft against the real configuration schema.
 *
 * Catching a malformed config here rather than on the next reload means the
 * wizard cannot produce a file the extension will then refuse to load.
 */
export function validateDraft(draft: ConnectionDraft): Error | undefined {
  return validateConfig(draftToConfig(draft));
}
