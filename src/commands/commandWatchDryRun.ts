import { COMMAND_WATCH_DRY_RUN } from '../constants';
import { runDryRun } from '../modules/watch/dryRun';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_WATCH_DRY_RUN,

  async handleCommand() {
    await runDryRun();
  },
});
