import CustomError from '../customError';
import {
  noCredentialStore,
  type CredentialIdentity,
  type CredentialStore,
} from '../credentials';

export interface ConnectOption {
  // common
  host: string;
  port: number;
  username?: string;
  password?: string;
  connectTimeout?: number;
  debug(x: string): void;

  // ssh-only
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string | boolean;
  interactiveAuth?: boolean | string[];
  agent?: string;
  sock?: any;
  hop?: ConnectOption | ConnectOption[];
  limitOpenFilesOnRemote?: boolean | number;

  // ftp-only
  secure?: any;
  secureOptions?: object;
  passive?: boolean;
}

export enum ErrorCode {
  CONNECT_CANCELLED,
}

export interface Config {
  askForPasswd(msg: string): Promise<string | undefined>;
  /**
   * Asked before prompting, and offered the answer afterwards. Optional so a
   * caller that has nowhere to keep secrets simply prompts every time.
   */
  credentials?: CredentialStore;
  /**
   * Whether to offer to remember a password the user has just typed. The
   * decision is the editor layer's; core only asks.
   */
  offerToRemember?(identity: CredentialIdentity): Promise<boolean>;
}

export default abstract class RemoteClient {
  protected _client: any;
  protected _option: ConnectOption;

  /** Part of the credential key, so two protocols on one host stay distinct. */
  abstract get protocol(): string;

  constructor(option: ConnectOption) {
    this._option = option;
    this._client = this._initClient();
  }

  abstract end(): void;
  abstract getFsClient(): any;
  protected abstract _doConnect(connectOption: ConnectOption, config: Config): Promise<void>;
  protected abstract _hasProvideAuth(connectOption: ConnectOption): boolean;
  protected abstract _initClient(): any;

  async connect(connectOption: ConnectOption, config: Config) {
    if (this._hasProvideAuth(connectOption)) {
      return this._doConnect(connectOption, config);
    }

    const store = config.credentials ?? noCredentialStore;
    const identity = this.credentialIdentity(connectOption);

    const remembered = await store.get(identity, 'password');
    if (remembered !== undefined) {
      try {
        return await this._doConnect({ ...connectOption, password: remembered }, config);
      } catch (error) {
        // A stored password that no longer works must not lock the user out of
        // their own server: drop it and fall through to asking.
        await store.forget(identity, 'password');
        if (error instanceof CustomError) throw error;
      }
    }

    const password = await config.askForPasswd(`[${connectOption.host}]: Enter your password`);

    // cancel connect
    if (password === undefined) {
      throw new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled');
    }

    await this._doConnect({ ...connectOption, password }, config);

    // Offered only after the password is known to work, so a typo is never
    // saved and then replayed on every subsequent connection.
    if (await config.offerToRemember?.(identity)) {
      await store.store(identity, 'password', password);
    }
  }

  protected credentialIdentity(connectOption: ConnectOption): CredentialIdentity {
    return {
      protocol: this.protocol,
      host: connectOption.host,
      port: connectOption.port,
      username: connectOption.username ?? '',
    };
  }

  onDisconnected(cb) {
    this._client
      .on('end', () => {
        cb('end');
      })
      .on('close', () => {
        cb('close');
      })
      .on('error', err => {
        cb('error');
      });
  }
}
