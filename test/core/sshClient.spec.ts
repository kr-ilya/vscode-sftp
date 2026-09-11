import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import SSHClient from '../../src/core/remote-client/sshClient';
import type { ConnectOption, Config } from '../../src/core/remote-client/remoteClient';
import type { CredentialIdentity, CredentialStore } from '../../src/core/credentials';
import { credentialKey } from '../../src/core/credentials';

/**
 * Connection wiring, against a stand-in for ssh2's Client.
 *
 * This exists because of a bug that made every SSH connection fail outright and
 * that no amount of type checking or linting could see: the connect listeners
 * were wired as `.on('close', this.end())` -- calling `end()` at wiring time and
 * passing its return value, `undefined`, as the listener. So the client was
 * ended before it connected, and Node then threw "the listener argument must be
 * of type function". It had been in upstream since 2023 and was only found by
 * trying to upload a file.
 *
 * The property worth asserting is narrow and cheap: listeners must be
 * functions, and connecting must not end the client.
 */

/** Enough of ssh2's Client to exercise the wiring. */
class FakeSsh2Client extends EventEmitter {
  readonly listenerArguments: Array<{ event: string; listener: unknown }> = [];
  connectOptions: Record<string, unknown> | null = null;
  endCalls = 0;
  /** Whether end() was called before connect() -- the symptom of the bug. */
  endedBeforeConnect = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listenerArguments.push({ event, listener });
    // Node's EventEmitter rejects a non-function listener, which is how the
    // original bug surfaced. Keeping that behaviour is the point of the fake.
    return super.on(event, listener);
  }

  connect(options: Record<string, unknown>): this {
    this.connectOptions = options;
    setImmediate(() => this.emit('ready'));
    return this;
  }

  end(): void {
    this.endCalls += 1;
    if (this.connectOptions === null) this.endedBeforeConnect = true;
  }

  sftp(callback: (err: Error | null, sftp: unknown) => void): void {
    callback(null, { on: () => undefined });
  }
}

/**
 * Substitutes the fake for the real ssh2 Client.
 *
 * The fake is read back off `_client` rather than kept in a field of its own:
 * the base constructor calls `_initClient()` before subclass fields are
 * initialised, and under `useDefineForClassFields` a declared field is then
 * defined as `undefined`, silently discarding whatever the constructor stored.
 */
class TestableSSHClient extends SSHClient {
  _initClient() {
    return new FakeSsh2Client();
  }

  get fake(): FakeSsh2Client {
    return this._client as FakeSsh2Client;
  }
}

const option = (over: Partial<ConnectOption> = {}): ConnectOption =>
  ({
    host: 'example.com',
    port: 22,
    username: 'deploy',
    password: 'secret',
    debug: () => undefined,
    ...over,
  }) as ConnectOption;

const config: Config = { askForPasswd: async () => undefined };

describe('connecting', () => {
  test('every listener it registers is a function', async () => {
    const client = new TestableSSHClient(option());
    await client.connect(option(), config);

    expect(client.fake.listenerArguments.length).toBeGreaterThan(0);
    for (const { event, listener } of client.fake.listenerArguments) {
      expect(typeof listener, `listener for "${event}"`).toBe('function');
    }
  });

  test('does not end the client on the way to connecting', async () => {
    const client = new TestableSSHClient(option());
    await client.connect(option(), config);

    expect(client.fake.endedBeforeConnect).toBe(false);
    expect(client.fake.connectOptions).not.toBeNull();
  });

  test('registers handlers for the disconnection events', async () => {
    const client = new TestableSSHClient(option());
    await client.connect(option(), config);

    const events = client.fake.listenerArguments.map(entry => entry.event);
    expect(events).toContain('close');
    expect(events).toContain('end');
    expect(events).toContain('error');
  });

  test('asks the host key verifier about the server', async () => {
    const client = new TestableSSHClient(option());
    await client.connect(option(), config);

    // Upstream passed neither hostVerifier nor hostHash, so ssh2 accepted any
    // key silently.
    expect(typeof client.fake.connectOptions?.hostVerifier).toBe('function');
  });
});

describe('ending', () => {
  test('is idempotent', async () => {
    // Both 'close' and 'end' arrive for one disconnection, and a caller may end
    // explicitly too.
    const client = new TestableSSHClient(option());
    await client.connect(option(), config);

    client.end();
    client.end();
    client.end();

    expect(client.fake.endCalls).toBe(1);
  });

  test('a disconnection ends the client exactly once', async () => {
    const client = new TestableSSHClient(option());
    await client.connect(option(), config);

    client.fake.emit('close');
    client.fake.emit('end');

    expect(client.fake.endCalls).toBe(1);
  });
});

describe('authentication', () => {
  test('prompts for a password when none is configured', async () => {
    const askForPasswd = vi.fn(async () => 'typed-in');
    const client = new TestableSSHClient(option({ password: undefined }));

    await client.connect(option({ password: undefined }), { askForPasswd });

    expect(askForPasswd).toHaveBeenCalledOnce();
    expect(client.fake.connectOptions?.password).toBe('typed-in');
  });

  test('a cancelled prompt does not connect', async () => {
    const client = new TestableSSHClient(option({ password: undefined }));

    await expect(
      client.connect(option({ password: undefined }), { askForPasswd: async () => undefined })
    ).rejects.toBeTruthy();

    expect(client.fake.connectOptions).toBeNull();
  });
});

/** An in-memory SecretStorage. */
function makeStore(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const store: CredentialStore = {
    async get(identity, kind) {
      return values.get(credentialKey(identity, kind));
    },
    async store(identity, kind, value) {
      values.set(credentialKey(identity, kind), value);
    },
    async forget(identity, kind) {
      values.delete(credentialKey(identity, kind));
    },
  };
  return { store, values };
}

/** Rejects until the expected password arrives, like a real server would. */
class PickyClient extends FakeSsh2Client {
  static expectedPassword = 'correct';

  connect(options: Record<string, unknown>): this {
    this.connectOptions = options;
    if (options.password === PickyClient.expectedPassword) {
      setImmediate(() => this.emit('ready'));
    } else {
      setImmediate(() => this.emit('error', new Error('All configured authentication methods failed')));
    }
    return this;
  }
}

class PickySSHClient extends SSHClient {
  _initClient() {
    return new PickyClient();
  }
  get fake(): PickyClient {
    return this._client as PickyClient;
  }
}

describe('remembered passwords', () => {
  const identity: CredentialIdentity = {
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'deploy',
  };

  test('a stored password is used without prompting', async () => {
    const { store } = makeStore({ [credentialKey(identity, 'password')]: 'correct' });
    const askForPasswd = vi.fn(async () => undefined);
    const client = new PickySSHClient(option({ password: undefined }));

    await client.connect(option({ password: undefined }), { askForPasswd, credentials: store });

    expect(askForPasswd).not.toHaveBeenCalled();
    expect(client.fake.connectOptions?.password).toBe('correct');
  });

  test('a password is offered for saving only after it has worked', async () => {
    const { store, values } = makeStore();
    const offerToRemember = vi.fn(async () => true);
    const client = new PickySSHClient(option({ password: undefined }));

    await client.connect(option({ password: undefined }), {
      askForPasswd: async () => 'correct',
      credentials: store,
      offerToRemember,
    });

    expect(offerToRemember).toHaveBeenCalledOnce();
    expect(values.get(credentialKey(identity, 'password'))).toBe('correct');
  });

  test('a rejected password is never saved', async () => {
    // Otherwise a typo is stored and replayed on every subsequent connection.
    const { store, values } = makeStore();
    const offerToRemember = vi.fn(async () => true);
    const client = new PickySSHClient(option({ password: undefined }));

    await expect(
      client.connect(option({ password: undefined }), {
        askForPasswd: async () => 'wrong',
        credentials: store,
        offerToRemember,
      })
    ).rejects.toBeTruthy();

    expect(offerToRemember).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  test('declining to save stores nothing', async () => {
    const { store, values } = makeStore();
    const client = new PickySSHClient(option({ password: undefined }));

    await client.connect(option({ password: undefined }), {
      askForPasswd: async () => 'correct',
      credentials: store,
      offerToRemember: async () => false,
    });

    expect(values.size).toBe(0);
  });

  test('a stored password that stopped working is dropped, and the user is asked', async () => {
    // A password changed on the server must not lock the user out of their own
    // machine by being retried forever.
    const { store, values } = makeStore({ [credentialKey(identity, 'password')]: 'stale' });
    const askForPasswd = vi.fn(async () => 'correct');
    const client = new PickySSHClient(option({ password: undefined }));

    await client.connect(option({ password: undefined }), {
      askForPasswd,
      credentials: store,
      offerToRemember: async () => false,
    });

    expect(askForPasswd).toHaveBeenCalledOnce();
    expect(values.has(credentialKey(identity, 'password'))).toBe(false);
    expect(client.fake.connectOptions?.password).toBe('correct');
  });

  test('a password in the config is used as-is, and nothing is stored', async () => {
    // Existing configs keep working exactly as before.
    const { store, values } = makeStore();
    const askForPasswd = vi.fn(async () => undefined);
    const offerToRemember = vi.fn(async () => true);
    const client = new PickySSHClient(option({ password: 'correct' }));

    await client.connect(option({ password: 'correct' }), {
      askForPasswd,
      credentials: store,
      offerToRemember,
    });

    expect(askForPasswd).not.toHaveBeenCalled();
    expect(offerToRemember).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  test('with no store installed, the behaviour is exactly the old one', async () => {
    const askForPasswd = vi.fn(async () => 'correct');
    const client = new PickySSHClient(option({ password: undefined }));

    await client.connect(option({ password: undefined }), { askForPasswd });

    expect(askForPasswd).toHaveBeenCalledOnce();
  });
});
