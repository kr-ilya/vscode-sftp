import { Client } from 'ssh2';
import upath from '../upath';
import RemoteClient, { ErrorCode, ConnectOption, Config } from './remoteClient';
import localFs from '../localFs';
import { FileSystem, RemoteFileSystem, SFTPFileSystem } from '../fs';
import logger from '../logger';
import CustomError from '../customError';
import { hostVerifierFor } from './hostVerification';
import {
  createFileDescriptorLimit,
  DEFAULT_OPEN_FD_LIMIT,
  MIN_OPEN_FD_LIMIT,
  type FileDescriptorLimit,
} from './fileDescriptorLimit';

export default class SSHClient extends RemoteClient {
  private sftp: any;
  private hoppingClients: SSHClient[];
  private _ended = false;
  private _fdLimit: FileDescriptorLimit | null = null;

  get protocol(): string {
    return 'sftp';
  }

  _initClient() {
    return new Client();
  }

  _hasProvideAuth(connectOption: ConnectOption) {
    return (
      // interactiveAuth : boolean
      connectOption.interactiveAuth === true ||
      // or interactiveAuth : array of phrases
      (Array.isArray(connectOption.interactiveAuth) && !!connectOption.interactiveAuth.length) ||
      // or key defined
      ['password', 'agent', 'privateKeyPath'].some(
        // tslint:disable-next-line triple-equals
        key => connectOption[key] != undefined
      )
    );
  }

  async _doConnect(
    connectOption: ConnectOption,
    config: Config
  ): Promise<void> {
    const { hop, ...option } = connectOption;

    let lastOption: ConnectOption = option;
    let fs: FileSystem | RemoteFileSystem = localFs;
    let sock;
    if (
      (Array.isArray(hop) && hop.length > 0) ||
      (hop && Object.keys(hop).length > 0)
    ) {
      this.hoppingClients = [];
      const connectOptions = Array.isArray(hop)
        ? [option].concat(hop)
        : [option, hop];
      lastOption = connectOptions.pop()!;

      for (let index = 0; index < connectOptions.length; index++) {
        const curOpt = connectOptions[index];
        if (curOpt.port === undefined) {
          curOpt.port = 22;
        }
        const preClient = this.hoppingClients[index - 1];
        if (preClient) {
          sock = await this._makeHopping(preClient, curOpt.host, curOpt.port);
          fs = new SFTPFileSystem(upath, {
            client: preClient,
          });
        }

        if (curOpt.privateKeyPath) {
          const buffer = await fs.readFile(curOpt.privateKeyPath);
          curOpt.privateKey = buffer.toString();
        }

        const client = new SSHClient(curOpt);
        this.hoppingClients.push(client);
        await client.connect({ ...curOpt, sock }, config);
      }

      const lastClient = this.hoppingClients[this.hoppingClients.length - 1];
      sock = await this._makeHopping(
        lastClient,
        lastOption.host,
        lastOption.port
      );
      fs = new SFTPFileSystem(upath, {
        client: lastClient,
      });
    }

    if (lastOption.privateKeyPath) {
      const buffer = await fs.readFile(lastOption.privateKeyPath);
      lastOption.privateKey = buffer.toString();
    }

    await this._connectSSHClient(this._client, { ...lastOption, sock }, config);
    this.sftp = await this._getSftp(this._client);

    if (lastOption.limitOpenFilesOnRemote) {
      // Per connection. This was a module-wide `let` set from whichever config
      // connected last, so two servers with different limits -- or one asking
      // for `true` after one that asked for a number -- shared whatever it
      // happened to hold.
      const max =
        typeof lastOption.limitOpenFilesOnRemote === 'number'
          ? Math.max(MIN_OPEN_FD_LIMIT, lastOption.limitOpenFilesOnRemote)
          : DEFAULT_OPEN_FD_LIMIT;
      this._limitSftpFileDescriptor(max);
    }
  }

  // connect1(readline): Promise<void> {
  //   const {
  //     interactiveAuth,
  //     password,
  //     privateKeyPath,
  //     connectTimeout,
  //     ...option // tslint:disable-line
  //   } = this.getOption();
  //   return new Promise<void>((resolve, reject) => {
  //     const connectWithCredential = (passwd?, privateKey?) =>
  //       this.client
  //         .on('ready', () => {
  //           this.client.sftp((err, sftp) => {
  //             if (err) {
  //               reject(err);
  //             }

  //             this.sftp = sftp;
  //             resolve();
  //           });
  //         })
  //         .on('error', err => {
  //           reject(err);
  //         })
  //         .connect({
  //           keepaliveInterval: 1000 * 30,
  //           keepaliveCountMax: 2,
  //           readyTimeout: interactiveAuth ? Math.max(60 * 1000, connectTimeout) : connectTimeout,
  //           ...option,
  //           privateKey,
  //           password: passwd,
  //           tryKeyboard: interactiveAuth,
  //         });

  //     if (interactiveAuth) {
  //       this.client.on('keyboard-interactive', function redo(
  //         name,
  //         instructions,
  //         instructionsLang,
  //         prompts,
  //         finish,
  //         stackedAnswers
  //       ) {
  //         const answers = stackedAnswers || [];
  //         if (answers.length < prompts.length) {
  //           readline(prompts[answers.length].prompt).then(answer => {
  //             answers.push(answer);
  //             redo(name, instructions, instructionsLang, prompts, finish, answers);
  //           });
  //         } else {
  //           finish(answers);
  //         }
  //       });
  //     }

  //     if (!privateKeyPath) {
  //       connectWithCredential(password);
  //       return;
  //     }

  //     fs.readFile(privateKeyPath, (err, data) => {
  //       if (err) {
  //         reject(err);
  //         return;
  //       }
  //       connectWithCredential(password, data);
  //     });
  //   });
  // }

  private _limitSftpFileDescriptor(max: number) {
    if (!this.sftp) {
      return;
    }

    const limit = createFileDescriptorLimit(max);
    this._fdLimit = limit;

    // On the SFTP object itself. Upstream patched `sftp._stream`, which ssh2
    // has not had for years: turning `limitOpenFilesOnRemote` on threw
    // "Cannot read properties of undefined (reading 'open')" during connect, so
    // the option did not merely fail to limit anything -- it made the
    // connection fail. Found by running it against a real server.
    const sftp = this.sftp;
    sftp.open = limit.guardAcquire(sftp.open.bind(sftp));
    sftp.opendir = limit.guardAcquire(sftp.opendir.bind(sftp));
    sftp.close = limit.guardRelease(sftp.close.bind(sftp));
  }

  /** Descriptors reserved and calls waiting, for diagnostics and tests. */
  get fileDescriptorUsage(): { reserved: number; waiting: number } | null {
    return this._fdLimit && { reserved: this._fdLimit.reserved, waiting: this._fdLimit.waiting };
  }

  private async _connectSSHClient(
    client,
    remoteOption: ConnectOption,
    config: Config
  ): Promise<any> {
    const {
      interactiveAuth,
      connectTimeout,
      ...option // tslint:disable-line
    } = remoteOption;

    // explict compare to true, cause we want to distinct between string and true
    if (option.passphrase === true) {
      option.passphrase = await config.askForPasswd(
        `[${option.host}]: Enter your passphrase`
      );
      if (option.passphrase === undefined) {
        throw new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled');
      }
    }

    return new Promise<void>((resolve, reject) => {
      if (interactiveAuth) {
        client.on('keyboard-interactive', function redo(
          name,
          instructions,
          instructionsLang,
          prompts,
          finish,
          stackedAnswers
        ) {
          const answers = stackedAnswers ||
            // load predefined answeres if any
            (Array.isArray(interactiveAuth) ? interactiveAuth : undefined) ||
            [];
          if (answers.length < prompts.length) {
            config
              .askForPasswd(
                `[${option.host}]: ${prompts[answers.length].prompt}`
              )
              .then(answer => {
                if (answer === undefined) {
                  return reject(
                    new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled')
                  );
                }

                answers.push(answer);
                redo(
                  name,
                  instructions,
                  instructionsLang,
                  prompts,
                  finish,
                  answers
                );
              });
          } else {
            finish(answers);
          }
        });
      }

      client
        .on('ready', resolve)
        .on('error', err => {
          reject(new Error(`[${option.host}]: ${err.message}`));
        })
        // `this.end()` rather than `this.end` -- and never `this.end()` as the
        // argument, which calls it at wiring time and passes its return value.
        // That is what upstream did: every SSH connection ended the client
        // before connecting and then threw "listener must be a function".
        .on('close', () => this.end())
        .on('end', () => this.end())
        .connect({
          keepaliveInterval: 1000 * 30, // 30 secs, original
          // keepaliveInterval: 1000 * 600, // 10 mins
          // keepaliveInterval: 1000 * 1800, // 30 mins
          keepaliveCountMax: 2, // x2 original
          // keepaliveCountMax: 3, // x3
          // keepaliveCountMax: 6, // x6
          readyTimeout: interactiveAuth
            ? Math.max(60 * 1000, connectTimeout || 0) // 60 secs, original
            // ? Math.max(1800 * 1000, connectTimeout || 0) // 30 mins
            // ? Math.max(10800 * 1000, connectTimeout || 0) // 180 mins
            : connectTimeout,
          ...option,
          tryKeyboard: !!interactiveAuth,
          // Upstream passed neither hostVerifier nor hostHash, so ssh2 accepted
          // any key silently and the handshake was open to a
          // machine-in-the-middle. Omitting hostHash means the raw key blob
          // arrives here, which is what lets the fingerprint be shown in
          // OpenSSH's own format.
          hostVerifier: hostVerifierFor(client, option.host, option.port ?? 22),
        });
    });
  }

  private _getSftp(client): Promise<any> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err);
        }

        resolve(sftp);
      });
    });
  }

  private _makeHopping(sshClient: SSHClient, dstHost, dstPort): Promise<any> {
    logger.info(`hopping from ${sshClient._option.host} to ${dstHost}`);
    return new Promise((resolve, reject) => {
      // Create a connect form 127.0.0.1:port to dstHost:dstPort
      sshClient._client.forwardOut(
        '127.0.0.1',
        sshClient._option.port,
        dstHost,
        dstPort,
        (error, stream) => {
          if (error) {
            return reject(error);
          }

          resolve(stream);
        }
      );
    });
  }

  end() {
    // Both 'close' and 'end' arrive for a single disconnection, and a caller may
    // end explicitly as well, so this has to tolerate being called repeatedly.
    if (this._ended) return;
    this._ended = true;

    this._client.end();

    if (this.hoppingClients) {
      // Last connected, first ended. Copied rather than reversed in place:
      // `reverse()` mutates, so a second call would walk the chain the wrong
      // way round.
      [...this.hoppingClients].reverse().forEach(client => client.end());
    }
  }

  getFsClient() {
    return this.sftp;
  }
}
