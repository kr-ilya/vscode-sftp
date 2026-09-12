import { commands } from 'vscode';
import { LRUCache } from 'lru-cache';
import StatusBarItem from './ui/statusBarItem';
import TransferProgress from './ui/transferProgress';
import { COMMAND_CANCEL_ALL_TRANSFER, COMMAND_TOGGLE_OUTPUT } from './constants';
import AppState from './modules/appState';
import RemoteExplorer from './modules/remoteExplorer';

interface App {
  fsCache: LRUCache<string, string>;
  state: AppState;
  sftpBarItem: StatusBarItem;
  transferProgress: TransferProgress;
  remoteExplorer: RemoteExplorer;
}

const app: App = Object.create(null);

app.state = new AppState();
app.sftpBarItem = new StatusBarItem(
  () => {
    if (app.state.profile) {
      return `SyncX: ${app.state.profile}`;
    } else {
      return 'SyncX';
    }
  },
  'SyncX — SFTP & FTP sync',
  COMMAND_TOGGLE_OUTPUT
);
// Cancel goes through the existing command rather than reaching into the
// services: the command is what the command palette already runs, and one
// definition of "stop everything" is enough.
app.transferProgress = new TransferProgress(() => {
  void commands.executeCommand(COMMAND_CANCEL_ALL_TRANSFER);
});
app.fsCache = new LRUCache<string, string>({ max: 6 });

export default app;
