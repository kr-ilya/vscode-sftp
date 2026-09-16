/**
 * Says what was attempted and where, on top of what the server answered.
 *
 * Remote file systems report failures at their narrowest: SFTP has a fixed set
 * of status codes, and code 4 is the catch-all -- it arrives as the single word
 * `Failure`. That reaches the user through a stack that is entirely inside
 * ssh2's packet handling, so nothing in it says which request failed or which
 * path it was about. A real report read, in full, `Error: Failure ... when
 * local ➞ remote c:\project\upload`, where even that path is the folder the
 * command was given rather than the one that failed.
 *
 * The server's own message is kept, because sometimes it is the informative
 * part; the operation and the remote path are put in front of it, because
 * usually they are.
 */

/** What the transports carry on an error, whichever library raised it. */
interface ErrorWithCode {
  code?: number | string;
  message?: string;
  stack?: string;
}

export class RemoteOperationError extends Error {
  /** The server's status code, where it gave one; callers branch on it. */
  readonly code?: number | string;

  constructor(operation: string, target: string, cause: unknown) {
    const reported = (cause as ErrorWithCode)?.message;
    super(`${operation} ${target}${reported ? `: ${reported}` : ''}`, { cause });
    this.name = 'RemoteOperationError';
    this.code = (cause as ErrorWithCode)?.code;
  }
}

/**
 * Wraps a transport failure, or passes one through that is already described.
 *
 * Re-wrapping matters because these operations call each other: `ensureDir`
 * retries `mkdir`, a recursive `rmdir` walks itself. Wrapping twice would
 * report the outermost path for a failure that happened several levels down.
 */
export function remoteFailure(operation: string, target: string, cause: unknown): unknown {
  if (cause instanceof RemoteOperationError) return cause;
  return new RemoteOperationError(operation, target, cause);
}

/** The original error, for callers that need to recognise the transport's own. */
export function underlying(error: unknown): unknown {
  return error instanceof RemoteOperationError ? error.cause : error;
}
