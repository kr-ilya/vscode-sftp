import logger from '../logger';

/**
 * Verifies the server's host key.
 *
 * Injected, because core must not reach the editor to ask the user a question.
 * The default REFUSES rather than accepting: this is a security control, and a
 * control that fails open when its wiring breaks is worse than none, because it
 * looks like it is working. src/modules/coreHost.ts installs the real one.
 */
export type HostVerifier = (key: Buffer, callback: (accepted: boolean) => void) => void;
export type HostVerifierFactory = (host: string, port: number) => HostVerifier;

let hostVerifierFactory: HostVerifierFactory = () => (_key, callback) => {
  logger.error(
    '[hostkey] no host key verifier is installed; refusing to connect. ' +
      'This is a wiring bug -- see src/modules/coreHost.ts.'
  );
  callback(false);
};

export function setHostVerifierFactory(factory: HostVerifierFactory): void {
  hostVerifierFactory = factory;
}

/** The part of ssh2's Client this needs. */
export interface HandshakeClient {
  _readyTimeout?: ReturnType<typeof setTimeout>;
  config?: { readyTimeout?: number };
  emit(event: string, ...args: unknown[]): boolean;
  end(): void;
}

/**
 * The verifier ssh2 gets, with the handshake clock stopped while it answers.
 *
 * `readyTimeout` is a budget for the *network*, not for the person at the
 * keyboard. ssh2 arms it before connecting and keeps it running while
 * `hostVerifier` is pending, so the modal asking the user to compare a
 * fingerprint counted against it: on a first connection the handshake died at
 * ten seconds with "Timed out while waiting for handshake" while the dialog was
 * still on screen, and the user's answer -- arriving seconds later -- was then
 * delivered into a protocol that had already been torn down, which threw
 * `protocol._destruct is not a function` out of ssh2 internals.
 *
 * So the clock is stopped for as long as the question is up and started again
 * once it is answered, and the answer itself is delivered defensively, because
 * the connection can still have gone away for reasons of its own.
 */
export function hostVerifierFor(
  client: HandshakeClient,
  host: string,
  port: number
): HostVerifier {
  const verify = hostVerifierFactory(host, port);

  return (key, callback) => {
    const restartClock = stopHandshakeClock(client);
    let answered = false;

    verify(key, accepted => {
      if (answered) return;
      answered = true;
      restartClock();

      try {
        callback(accepted);
      } catch (error) {
        // ssh2 tears the protocol down when a key is refused; if the connection
        // had already failed it tears down a second time, through a `_destruct`
        // it has cleared. The decision has been made and logged by this point,
        // so the throw carries no information the user needs.
        logger.info(
          `[hostkey] ${host}:${port} was answered after the connection had gone away`,
          error
        );
      }
    });
  };
}

/**
 * Clears ssh2's handshake timer, returning a function that arms a fresh one.
 *
 * The timer is put back on the same property ssh2 reads, so ssh2's own
 * `clearTimeout(this._readyTimeout)` on a completed handshake still finds it.
 * The replacement raises the error ssh2 would have raised, so nothing
 * downstream has to distinguish the two.
 */
function stopHandshakeClock(client: HandshakeClient): () => void {
  const pending = client._readyTimeout;
  if (!pending) {
    // No timeout configured, or the handshake is already over.
    return () => undefined;
  }

  clearTimeout(pending);
  client._readyTimeout = undefined;

  return () => {
    const budget = client.config?.readyTimeout ?? 0;
    if (budget <= 0) return;

    client._readyTimeout = setTimeout(() => {
      const timedOut = Object.assign(new Error('Timed out while waiting for handshake'), {
        level: 'client-timeout',
      });
      client.emit('error', timedOut);
      client.end();
    }, budget);
  };
}
