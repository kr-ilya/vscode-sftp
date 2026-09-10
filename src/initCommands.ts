import { ExtensionContext } from 'vscode';
import logger from './logger';
import { registerCommand } from './host';
import Command from './commands/abstract/command';
import { commandGroups, CommandEntry } from './commands/registry';

export default function init(context: ExtensionContext) {
  for (const group of commandGroups) {
    registerGroup(group.entries, group.create, context);
  }
}

function nomalizeCommandName(rawName: string) {
  const firstLetter = rawName[0].toUpperCase();
  return firstLetter + rawName.slice(1).replace(/[A-Z]/g, token => ` ${token[0]}`);
}

function registerGroup(
  entries: CommandEntry[],
  commandCreator: (option: any) => new () => Command,
  context: ExtensionContext
) {
  for (const [rawName, commandOption] of entries) {
    commandOption.name = nomalizeCommandName(rawName);

    try {
      // tslint:disable-next-line variable-name
      const Cmd = commandCreator(commandOption);
      const cmdInstance: Command = new Cmd();
      logger.debug(`register command "${commandOption.name}"`);
      registerCommand(context, commandOption.id, cmdInstance.run, cmdInstance);
    } catch (error) {
      logger.error(error, `load command "${rawName}"`);
    }
  }
}
