import { reportError } from '../../helper';
import logger from '../../logger';

export interface ITarget {
  fsPath: string;
}

export interface CommandOption {
  [x: string]: any;
}

export default abstract class Command {
  private _commandDoneListeners: Array<(...args: any[]) => void> = [];

  /**
   * Identity comes from the factory that creates the subclass. It used to be
   * assigned afterwards by each subclass constructor, which is why the fields
   * could not be declared as always present.
   */
  constructor(readonly id: string, readonly name: string) {}

  onCommandDone(listener) {
    this._commandDoneListeners.push(listener);

    return () => {
      const index = this._commandDoneListeners.indexOf(listener);
      if (index > -1) this._commandDoneListeners.splice(index, 1);
    };
  }

  protected abstract doCommandRun(...args: any[]): unknown | Promise<unknown>;

  async run(...args) {
    logger.trace(`run command '${this.name}'`);
    try {
      await this.doCommandRun(...args);
    } catch (error) {
      reportError(error);
    } finally {
      this.commitCommandDone(...args);
    }
  }

  private commitCommandDone(...args: any[]) {
    this._commandDoneListeners.forEach(listener => listener(...args));
  }
}
