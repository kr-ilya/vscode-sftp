import { COMMAND_WATCH_DIAGNOSTICS } from '../constants';
import { showWatchDiagnostics } from '../modules/watch/output';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_WATCH_DIAGNOSTICS,

  handleCommand() {
    showWatchDiagnostics();
  },
});
