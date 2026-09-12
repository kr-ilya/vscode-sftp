import { reportError } from '../../helper';
import logger from '../../logger';

/**
 * One registered command.
 *
 * `run` is what VS Code calls, which is why it reports rather than rethrows: an
 * exception out of a command handler reaches the user as a generic host error
 * with no context, and the output channel is where the detail lives.
 */
export default abstract class Command {
  /**
   * Identity comes from the factory that creates the subclass. It used to be
   * assigned afterwards by each subclass constructor, which is why the fields
   * could not be declared as always present.
   */
  constructor(readonly id: string, readonly name: string) {}

  protected abstract doCommandRun(...args: unknown[]): unknown | Promise<unknown>;

  async run(...args: unknown[]): Promise<void> {
    logger.trace(`run command '${this.name}'`);
    try {
      await this.doCommandRun(...args);
    } catch (error) {
      reportError(error);
    }
  }
}
