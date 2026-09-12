import type { CredentialIdentity, CredentialStore } from './credentials';
import upath from './upath';
import logger from './logger';
import { ConnectOption } from './remote-client/remoteClient';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';
import localFs from './localFs';

/**
 * The two things connecting needs from the host: a way to ask the user for a
 * password, and somewhere to report that a connection is in progress.
 *
 * Injected rather than imported so that core does not reach into the status bar
 * or the editor's input box. The defaults make an unconfigured core usable --
 * and testable -- rather than crashing: no prompt available means password
 * authentication simply fails, which is the honest outcome.
 */
export interface RemoteFsHost {
  promptForPassword(prompt: string): Promise<string | undefined>;
  onConnecting(timeoutMs: number | undefined): void;
  onConnected(): void;
  /** Where remembered passwords live. Absent means nothing is remembered. */
  credentials?: CredentialStore;
  /** Asked, after a password has worked, whether to keep it. */
  offerToRemember?(identity: CredentialIdentity): Promise<boolean>;
}

let host: RemoteFsHost = {
  promptForPassword: async () => undefined,
  onConnecting: () => undefined,
  onConnected: () => undefined,
};

export function setRemoteFsHost(next: RemoteFsHost): void {
  host = next;
}

function hashOption(opiton) {
  return Object.keys(opiton)
    .map(key => opiton[key])
    .join('');
}

class KeepAliveRemoteFs {
  private isValid: boolean = false;

  private pendingPromise: Promise<RemoteFileSystem> | null = null;

  private fs!: RemoteFileSystem;

  async getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    }
  ): Promise<RemoteFileSystem> {
    if (this.isValid) {
      this.pendingPromise = null;
      return Promise.resolve(this.fs);
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    const connectOption = Object.assign({}, option);
    // tslint:disable variable-name
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

        if (!log) return;

        if (log[2].match(/200 NOOP/)) return;

        if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

        logger.debug(`${log[1]} ${log[2]}`);
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    this.fs = new FsConstructor(upath, {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
    });
    this.fs.onDisconnected(this.invalid.bind(this));

    host.onConnecting(connectOption.connectTimeout);
    this.pendingPromise = this.fs
      .connect(connectOption, {
        askForPasswd: prompt => host.promptForPassword(prompt),
        credentials: host.credentials,
        offerToRemember: host.offerToRemember,
      })
      .then(
        () => {
          host.onConnected();
          this.isValid = true;
          return this.fs;
        },
        err => {
          this.fs.end();
          this.invalid('error');
          throw err;
        }
      );

    return this.pendingPromise;
  }

  invalid(_reason: string) {
    this.pendingPromise = null;
    this.fs.end();
    this.isValid = false;
  }

  end() {
    this.fs.end();
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(option): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option);
}

export function removeRemoteFs(option) {
  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}
