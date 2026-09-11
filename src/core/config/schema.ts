/**
 * The configuration schema, and the single source of truth for it.
 *
 * Everything about a config field is declared once, here: its type, whether it
 * is required, its default, and its documentation. The JSON schema that gives
 * `.vscode/sftp.json` its editor IntelliSense is generated from this file by
 * `scripts/gen-schema.mjs`, and the TypeScript types are inferred from it.
 *
 * That single source is the point. Previously the same schema was written out
 * twice -- once in joi for validation, once by hand in schema/*.json for the
 * editor -- and the two had drifted: `profiles`, `hop`, `filePerm`, `dirPerm`,
 * `limitOpenFilesOnRemote` and `remote` were all accepted at runtime but absent
 * from validation, while `ignore`'s documented default never applied. The same
 * split is what let sftp-neo ship a `hooks` feature that executes shell
 * commands with no schema entry at all.
 *
 * No editor API is imported here: this module is pure, so it can be tested
 * directly and reused by the generator script.
 */

import { z } from 'zod';

/** joi ran with `convert: false`; zod does not coerce by default, so both agree. */

// --- shared building blocks -------------------------------------------------

const watcherSchema = z
  .looseObject({
    files: z
      .union([z.string(), z.literal(false), z.null()])
      .optional()
      .describe('A glob pattern selecting which files to watch.'),
    autoUpload: z
      .boolean()
      .optional()
      .describe('Upload a file when it changes on disk.'),
    autoDelete: z
      .boolean()
      .optional()
      .describe('Delete the remote file when the local one is deleted.'),
  })
  .describe('Watch for changes made outside the editor.');

const syncOptionSchema = z
  .looseObject({
    delete: z.boolean().optional().describe('Delete extraneous files from destination directories.'),
    skipCreate: z.boolean().optional().describe('Skip creating new files on the destination.'),
    ignoreExisting: z.boolean().optional().describe('Skip updating files that already exist on the destination.'),
    update: z.boolean().optional().describe('Update the destination only if the source is newer.'),
  })
  .describe('Behaviour of the Sync commands.');

const remoteExplorerSchema = z
  .looseObject({
    filesExclude: z
      .array(z.string())
      .optional()
      .describe('Glob patterns for files and folders the Remote Explorer should hide.'),
    order: z
      .number()
      .optional()
      .describe('Sort key for the Remote Explorer, ascending. Ties are broken by name.'),
  })
  .describe('Remote Explorer settings.');

/** Fields shared by every protocol. */
const optionShape = {
  remote: z
    .string()
    .optional()
    .describe('Name of a remote defined under `remotefs.remote` in User Settings; its values are merged in.'),
  uploadOnSave: z.boolean().optional().describe('Upload on every save.'),
  useTempFile: z
    .boolean()
    .optional()
    .describe('Write to a temporary file and rename it into place, so an interrupted upload cannot leave a truncated file.'),
  openSsh: z
    .boolean()
    .optional()
    .describe('Use an atomic rename on the server (OpenSSH only). Implies useTempFile.'),
  downloadOnOpen: z
    .union([z.boolean(), z.literal('confirm')])
    .optional()
    .describe('Download a file when it is opened. "confirm" asks first.'),
  filePerm: z.number().optional().describe('Octal mode to apply to uploaded files, e.g. 0o644.'),
  dirPerm: z.number().optional().describe('Octal mode to apply to created directories, e.g. 0o755.'),
  syncOption: syncOptionSchema.optional(),
  ignore: z
    .array(z.string().describe('An ignore pattern.'))
    .optional()
    .describe('Paths to ignore, with .gitignore semantics. Replaces the default list rather than adding to it.'),
  ignoreFile: z
    .string()
    .optional()
    .describe('Path to a .gitignore-style file, absolute or relative to the workspace root.'),
  remoteExplorer: remoteExplorerSchema.optional(),
  remoteTimeOffsetInHours: z
    .number()
    .optional()
    .describe('Hours the server clock is ahead of the local one (remote minus local).'),
  limitOpenFilesOnRemote: z
    .union([z.number(), z.literal(true)])
    .optional()
    .describe('Cap concurrently open remote file descriptors. `true` picks a safe default.'),
  concurrency: z.number().optional().describe('How many transfers may run at once.'),
};

/** Connection endpoint. */
const hostShape = {
  host: z.string().min(1).describe('Hostname or IP address of the server.'),
  port: z.number().optional().describe('Port of the server.'),
  username: z.string().min(1).describe('Username to authenticate as.'),
  password: z.string().nullable().optional().describe('Password for password authentication.'),
  remotePath: z.string().min(1).describe('Absolute path on the server to sync against.'),
  connectTimeout: z.number().optional().describe('How long to wait for the connection, in milliseconds.'),
};

/** SSH-specific fields. */
const sftpShape = {
  agent: z
    .string()
    .nullable()
    .optional()
    .describe('Path to the ssh-agent socket. On Windows, use "pageant" or a named pipe.'),
  privateKeyPath: z.string().nullable().optional().describe('Absolute path to the private key.'),
  passphrase: z
    .union([z.string(), z.literal(true)])
    .nullable()
    .optional()
    .describe('Passphrase for an encrypted private key. `true` prompts for it.'),
  interactiveAuth: z
    .union([z.boolean(), z.array(z.string())])
    .optional()
    .describe('Keyboard-interactive authentication, e.g. for one-time codes.'),
  algorithms: z
    .looseObject({
      kex: z.array(z.string()).optional().describe('Key exchange algorithms.'),
      cipher: z.array(z.string()).optional().describe('Ciphers.'),
      serverHostKey: z.array(z.string()).optional().describe('Accepted server host key formats.'),
      hmac: z.array(z.string()).optional().describe('MAC algorithms.'),
    })
    .optional()
    .describe('Overrides for the negotiated transport algorithms.'),
  sshConfigPath: z.string().optional().describe('Path to an ssh_config file to read defaults from.'),
  sshCustomParams: z
    .string()
    .optional()
    .describe('Extra arguments appended to the command used by "Open SSH in Terminal".'),
};

/** A jump host, or a chain of them. */
const hopSchema = z.looseObject({ ...hostShape, ...sftpShape }).partial();

/** FTP-specific fields. */
const ftpShape = {
  secure: z
    .union([z.boolean(), z.literal('control'), z.literal('implicit')])
    .optional()
    .describe('TLS: true for control and data, "control" for the control channel only, "implicit" for implicit FTPS.'),
  secureOptions: z
    .looseObject({})
    .nullable()
    .optional()
    .describe('Options forwarded verbatim to Node\'s tls.connect().'),
  passive: z.boolean().optional().describe('Use passive mode.'),
};

// --- the composed config ----------------------------------------------------

/**
 * A profile overlays the base config, so every field in it is optional --
 * including the ones that are required at the top level.
 */
const profileSchema = z
  .looseObject({ ...optionShape, ...hostShape, ...sftpShape, ...ftpShape })
  .partial();

const rootShape = {
  name: z.string().optional().describe('A label for this configuration.'),
  context: z
    .string()
    .optional()
    .describe('Local directory to sync, relative to the workspace root.'),
  protocol: z
    .enum(['sftp', 'ftp', 'local'])
    .optional()
    .describe('Transfer protocol.'),
  watcher: watcherSchema.optional(),
  defaultProfile: z.string().optional().describe('Profile to select when none is chosen.'),
  profiles: z
    .record(z.string(), profileSchema)
    .optional()
    .describe('Named overlays on this configuration, keyed by profile name.'),
  hop: z
    .union([hopSchema, z.array(hopSchema)])
    .optional()
    .describe('Jump host, or an ordered chain of them, to tunnel the connection through.'),
};

/**
 * `looseObject` keeps unknown keys, matching joi's `allowUnknown: true`. That
 * tolerance is deliberate: a config written for a newer version of the
 * extension should not hard-fail on an older one.
 */
export const configSchema = z.looseObject({
  ...rootShape,
  ...optionShape,
  ...hostShape,
  ...sftpShape,
  ...ftpShape,
});

/** `.vscode/sftp.json` may hold one configuration or an array of them. */
export const configFileSchema = z.union([configSchema, z.array(configSchema)]);

export type Config = z.infer<typeof configSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type WatcherConfig = z.infer<typeof watcherSchema>;
