import { Client, FTPError } from 'basic-ftp';
import logger from '../logger';
import RemoteClient, { ConnectOption } from './remoteClient';

/**
 * FTP/FTPS transport, on `basic-ftp`.
 *
 * This replaces `ftp@0.3.10`, whose last release was 2015-04-05 and which the
 * project had to reach into: upstream monkey-patched `Client.prototype._send`
 * to fix command queueing, and bolted a `setLastMod` method onto the prototype
 * because the package had no MFMT support. Both are gone -- patching another
 * package's internals is a maintenance bill that comes due at the worst moment.
 *
 * `basic-ftp` is promise-based, ships its own types, and is maintained. It also
 * enforces what FTP requires anyway: one command in flight at a time. Callers
 * serialise through src/core/util/serialQueue.
 *
 * One capability is lost, deliberately: `basic-ftp` is passive-only, so
 * `passive: false` can no longer be honoured. Active mode requires the server
 * to open a connection back to the client, which fails behind any NAT or
 * firewall -- that is, almost everywhere -- and is why passive has been the
 * default for decades. A configured `passive: false` is warned about rather
 * than silently ignored.
 */
export default class FTPClient extends RemoteClient {
  private connected = false;
  private disconnectListeners: Array<(reason: string) => void> = [];

  get protocol(): string {
    return 'ftp';
  }

  _initClient(): Client {
    // basic-ftp takes the per-operation timeout in the constructor and exposes
    // it read-only afterwards, so the configured value has to be known here.
    // The option object is available: RemoteClient assigns it before calling.
    return new Client(this._option?.connectTimeout ?? 10 * 1000);
  }

  _hasProvideAuth(connectOption: ConnectOption): boolean {
    return connectOption.password !== undefined && connectOption.password !== null;
  }

  async _doConnect(connectOption: ConnectOption): Promise<void> {
    const {
      host,
      port,
      username,
      password,
      secure,
      secureOptions,
      passive,
    } = connectOption;

    const client = this.client;

    if (passive === false) {
      logger.warn(
        '[ftp] `passive: false` is not supported: the FTP transport is ' +
          'passive-only. Connecting in passive mode.'
      );
    }

    try {
      await client.access({
        host,
        port,
        user: username,
        password,
        // basic-ftp: false = plain, true = explicit FTPS (AUTH TLS, then PROT P
        // for the data channel), 'implicit' = TLS from the first byte.
        secure: secure === 'implicit' ? 'implicit' : Boolean(secure),
        secureOptions: secureOptions as never,
      });

      // `secure: 'control'` means encrypt the control connection but not the
      // data transfer. basic-ftp always requests PROT P, so downgrade
      // explicitly rather than quietly giving the user more than they asked
      // for -- some servers reject PROT P outright.
      if (secure === 'control') {
        await client.send('PROT C');
      }

      this.connected = true;
      this.watchSocket();
    } catch (error) {
      this.connected = false;
      throw asConnectionError(error, host, port);
    }
  }

  private get client(): Client {
    return this._client as Client;
  }

  /**
   * The `basic-ftp` client itself.
   *
   * Returned rather than wrapped because the file system layer needs the whole
   * surface: streams, directory listings, and raw commands for MFMT and SITE.
   */
  getFsClient(): Client {
    return this.client;
  }

  isConnected(): boolean {
    return this.connected && !this.client.closed;
  }

  end(): void {
    this.connected = false;
    try {
      this.client.close();
    } catch {
      // Closing an already-closed client is not worth reporting.
    }
  }

  /**
   * basic-ftp's Client is not an EventEmitter, so the base class's `.on(...)`
   * wiring does not apply. Listeners are kept here and attached to the real
   * socket once there is one -- subscribing before `access()` would bind to the
   * placeholder socket basic-ftp starts with and never fire.
   */
  onDisconnected(cb: (reason: string) => void): void {
    this.disconnectListeners.push(cb);
    if (this.connected) this.watchSocket();
  }

  private watchSocket(): void {
    const socket = this.client.ftp.socket;
    if (!socket) return;

    const listeners = this.disconnectListeners;
    this.disconnectListeners = [];
    for (const cb of listeners) {
      socket.once('close', () => {
        this.connected = false;
        cb('close');
      });
    }
  }
}

/** Gives a failed connection a message that names what actually went wrong. */
function asConnectionError(error: unknown, host: string, port: number): Error {
  if (error instanceof FTPError) {
    return new Error(`[${host}:${port}] FTP ${error.code}: ${error.message}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[${host}:${port}] ${message}`);
}
