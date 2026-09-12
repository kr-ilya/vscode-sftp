import * as output from '../ui/output';
import logger from '../logger';
import { showErrorMessage } from '../host';

/**
 * A target that turned out not to be one, which is not a failure.
 *
 * Thrown where a command was handed something that only looks like a file --
 * a menu contribution whose `${command:...}` variable never resolved, for
 * instance. Reported to the log and nowhere else: there is nothing for the user
 * to do about it, and an error notification for it is noise.
 */
export class SkippedTargetError extends Error {
  constructor(readonly target: { toString(skipEncoding?: boolean): string }) {
    super(`Not a transferable target: ${target.toString(true)}`);
    this.name = 'SkippedTargetError';
  }
}

export function reportError(error: unknown, context?: string): void {
  if (error instanceof SkippedTargetError) {
    logger.debug(error.message, context);
    return;
  }

  const message = messageOf(error);
  if (error instanceof Error) {
    logger.error(`${error.stack}`, context);
  } else {
    logger.error(message, context);
  }

  void showErrorMessage(message, 'Detail').then(result => {
    if (result === 'Detail') {
      output.show();
    }
  });
}

/**
 * Something to put in front of the user.
 *
 * Upstream took `Error | string` and showed it verbatim, so a thrown non-Error
 * -- which the codebase did have -- could open a notification with no text in
 * it at all.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return `Unexpected error: ${String(error)}`;
}
