import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  hostVerifierFor,
  setHostVerifierFactory,
  type HandshakeClient,
  type HostVerifier,
} from '../../src/core/remote-client/hostVerification';

/**
 * The handshake clock must not run while a human is being asked a question.
 *
 * On a first connection the extension shows a modal with the server's
 * fingerprint. ssh2 arms `readyTimeout` before connecting and leaves it running
 * across `hostVerifier`, so the handshake died at ten seconds while the dialog
 * was still on screen -- and the answer, arriving afterwards, was delivered into
 * a protocol ssh2 had already torn down, which threw
 * `protocol._destruct is not a function` from inside ssh2.
 *
 * Both halves are asserted here: the clock stops while the question is up, and
 * the answer cannot throw out of the verifier.
 */

const READY_TIMEOUT = 10_000;

/** Enough of ssh2's Client to have a handshake clock. */
class FakeSsh2Client extends EventEmitter implements HandshakeClient {
  _readyTimeout?: ReturnType<typeof setTimeout>;
  readonly config = { readyTimeout: READY_TIMEOUT };
  timedOut = false;
  endCalls = 0;

  /** What ssh2 does at the start of connect(). */
  startHandshake(): void {
    this._readyTimeout = setTimeout(() => {
      this.timedOut = true;
      this.emit('error', new Error('Timed out while waiting for handshake'));
    }, this.config.readyTimeout);
  }

  /** What ssh2 does once the handshake completes. */
  finishHandshake(): void {
    clearTimeout(this._readyTimeout);
  }

  end(): void {
    this.endCalls += 1;
  }
}

function connected(verify: HostVerifier): { client: FakeSsh2Client; verifier: HostVerifier } {
  setHostVerifierFactory(() => verify);
  const client = new FakeSsh2Client();
  client.on('error', () => undefined); // an unhandled 'error' would throw
  const verifier = hostVerifierFor(client, 'example.com', 22);
  client.startHandshake();
  return { client, verifier };
}

const KEY = Buffer.from('a host key');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Leave the refusing default in place for whatever runs next.
  setHostVerifierFactory(() => (_key, callback) => callback(false));
});

describe('while the user is being asked', () => {
  test('a slow answer does not blow the handshake timeout', async () => {
    // The reported case: the user needs longer than readyTimeout to read a
    // fingerprint they have never seen before.
    let answer: (accepted: boolean) => void = () => undefined;
    const accepted = vi.fn();
    const { client, verifier } = connected((_key, callback) => {
      answer = callback;
    });

    verifier(KEY, accepted);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT * 3);

    expect(client.timedOut).toBe(false);
    answer(true);
    expect(accepted).toHaveBeenCalledWith(true);
  });

  test('the timeout that had already been armed is cleared, not merely ignored', () => {
    const { client, verifier } = connected(() => undefined);

    verifier(KEY, () => undefined);

    expect(client._readyTimeout).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('once the question is answered', () => {
  test('the clock starts again, so a stalled handshake still fails', async () => {
    // Stopping the clock must not mean disarming it: a server that accepts the
    // connection and then says nothing has to be given up on.
    const { client, verifier } = connected((_key, callback) => callback(true));

    verifier(KEY, () => undefined);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT - 1);
    expect(client.timedOut).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(client.endCalls).toBe(1);
  });

  test('the restarted timer is the one ssh2 clears when the handshake completes', async () => {
    // It goes back on `_readyTimeout` for exactly this reason; a timer kept
    // anywhere else would fire on a connection that had succeeded.
    const { client, verifier } = connected((_key, callback) => callback(true));
    const errors: Error[] = [];
    client.on('error', error => errors.push(error as Error));

    verifier(KEY, () => undefined);
    client.finishHandshake();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT * 2);

    expect(errors).toEqual([]);
    expect(client.endCalls).toBe(0);
  });

  test('an answer refused by a connection that has gone away does not throw', () => {
    // ssh2 tears the protocol down on a refusal, and tearing down a second time
    // goes through a `_destruct` it has already cleared. That TypeError reached
    // the user on top of the timeout error.
    const { verifier } = connected((_key, callback) => callback(false));

    expect(() =>
      verifier(KEY, () => {
        throw new TypeError('protocol._destruct is not a function');
      })
    ).not.toThrow();
  });

  test('answering twice reaches ssh2 once', () => {
    const accepted = vi.fn();
    const { verifier } = connected((_key, callback) => {
      callback(true);
      callback(false);
    });

    verifier(KEY, accepted);

    expect(accepted).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledWith(true);
  });
});

describe('the default verifier', () => {
  test('refuses, so a wiring mistake cannot open the connection', async () => {
    // Loaded fresh, because the suite installs its own factory: this asserts
    // what a build with nothing wired up would do.
    vi.resetModules();
    const pristine = await import('../../src/core/remote-client/hostVerification');
    const accepted = vi.fn();

    pristine.hostVerifierFor(new FakeSsh2Client(), 'example.com', 22)(KEY, accepted);

    expect(accepted).toHaveBeenCalledWith(false);
  });
});
