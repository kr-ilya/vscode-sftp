import upath from '../../core/upath';
import SFTPFileSystem from '../../core/fs/sftpFileSystem';
import FTPFileSystem from '../../core/fs/ftpFileSystem';
import type RemoteFileSystem from '../../core/fs/remoteFileSystem';

/**
 * Opens a connection with the collected values, and closes it again.
 *
 * Its own short-lived file system rather than the service registry's: nothing
 * has been configured yet, and a failed attempt must not leave a half-built
 * service behind for the rest of the session.
 */

export interface VerificationResult {
  ok: boolean;
  message?: string;
}

/** Short on purpose: this is a "does it answer" check, not a transfer. */
const VERIFY_TIMEOUT_MS = 15_000;

export async function verifyConnection(
  protocol: 'sftp' | 'ftp',
  connectOption: Record<string, unknown>
): Promise<VerificationResult> {
  const option = { ...connectOption, connectTimeout: VERIFY_TIMEOUT_MS, debug: () => undefined };

  const fs: RemoteFileSystem =
    protocol === 'ftp'
      ? new FTPFileSystem(upath, { clientOption: option as never })
      : new SFTPFileSystem(upath, { clientOption: option as never });

  try {
    await fs.connect(option as never, {
      // No prompting: the wizard has already asked for everything, and a
      // password box appearing on top of the wizard would be confusing.
      askForPasswd: async () => undefined,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      fs.end();
    } catch {
      // Closing a connection that never opened is not worth reporting.
    }
  }
}
