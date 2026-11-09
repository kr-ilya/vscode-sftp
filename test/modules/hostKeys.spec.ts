import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Uri, type ExtensionContext } from 'vscode';
import { formatKnownHostLine } from '../../src/core/ssh/knownHosts';
import { createHostVerifier, initializeHostKeys } from '../../src/modules/ssh/hostKeys';

const mocks = vi.hoisted(() => ({
  homedir: vi.fn<() => string>(),
  showErrorMessage: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  showInformationMessage: vi.fn<(...args: unknown[]) => Promise<undefined>>(),
  showWarningMessage: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
}));

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof os>(),
  homedir: mocks.homedir,
}));

vi.mock('vscode', async importOriginal => ({
  ...await importOriginal<typeof import('vscode')>(),
  window: {
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
  },
}));

const REMOVE_KEY = 'Remove old key from SyncX';
const HOST = 'syncx-key-test.invalid';
const PORT = 2222;
const TYPE = 'ssh-ed25519';
const oldKey = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIAbLCPyIZjjrTihLC54aAWwjuF4cbi6K/Q1KhM6YfNpD', 'base64');
const newKey = Buffer.concat([oldKey.subarray(0, 19), Buffer.alloc(32, 0x5a)]);
const anotherKey = Buffer.concat([oldKey.subarray(0, 19), Buffer.alloc(32, 0x5b)]);
const oldLine = formatKnownHostLine(HOST, PORT, TYPE, oldKey);

let root: string;
let store: string;
let openSshStore: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncx-host-keys-'));
  const storage = path.join(root, 'globalStorage');
  store = path.join(storage, 'known_hosts');
  openSshStore = path.join(root, '.ssh', 'known_hosts2');
  fs.mkdirSync(storage);
  fs.mkdirSync(path.dirname(openSshStore));
  mocks.homedir.mockReturnValue(root);
  vi.stubEnv('ProgramData', root);
  mocks.showErrorMessage.mockReset().mockResolvedValue(undefined);
  mocks.showInformationMessage.mockReset().mockResolvedValue(undefined);
  mocks.showWarningMessage.mockReset().mockResolvedValue(undefined);
  initializeHostKeys({ globalStorageUri: Uri.file(storage) } as ExtensionContext);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function verify(key = newKey): Promise<boolean> {
  return new Promise(resolve => createHostVerifier(HOST, PORT)(key, resolve));
}

function waitForRemovalNotice(): Promise<void> {
  return vi.waitFor(() => expect(mocks.showInformationMessage).toHaveBeenCalledOnce());
}

describe('forgetting a changed host key', () => {
  test('refuses the handshake, removes only the conflicting keys and asks on the next connection', async () => {
    const salt = Buffer.from('test salt');
    const digest = createHmac('sha1', salt).update(`[${HOST}]:${PORT}`).digest('base64');
    const hashedLine = `|1|${salt.toString('base64')}|${digest} ${TYPE} ${oldKey.toString('base64')}`;
    const otherPort = formatKnownHostLine(HOST, 22, TYPE, oldKey);
    const otherHost = formatKnownHostLine('another.invalid', PORT, TYPE, oldKey);
    const otherType = formatKnownHostLine(HOST, PORT, 'ssh-rsa', Buffer.from('AAAAB3NzaC1yc2E=', 'base64'));
    const original = `# SyncX keys\r\n${oldLine}\r\n${otherPort}\n${hashedLine}\n${otherHost}\r\n${otherType}`;
    const preserved = `# SyncX keys\r\n${otherPort}\n${otherHost}\r\n${otherType}`;
    fs.writeFileSync(store, original);
    let choose!: (choice: string) => void;
    mocks.showErrorMessage.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));

    expect(await verify()).toBe(false);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(`${HOST}:${PORT}`),
      { modal: true, detail: expect.stringContaining(`${store}:2`) },
      REMOVE_KEY
    );
    expect(fs.readFileSync(store, 'utf8')).toBe(original);
    fs.writeFileSync(store, `# Added while the dialog was open\n${original}`);
    choose(REMOVE_KEY);
    await waitForRemovalNotice();

    expect(fs.readFileSync(store, 'utf8')).toBe(`# Added while the dialog was open\n${preserved}`);
    expect(fs.readdirSync(path.dirname(store))).toEqual(['known_hosts']);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    expect(await verify()).toBe(false);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('has not been seen before'),
      { modal: true, detail: expect.stringContaining('SHA256:') },
      'Connect and remember',
      'Connect once'
    );

    mocks.showWarningMessage.mockResolvedValueOnce('Connect and remember');
    expect(await verify()).toBe(true);
    const newLine = formatKnownHostLine(HOST, PORT, TYPE, newKey);
    expect(fs.readFileSync(store, 'utf8')).toBe(`# Added while the dialog was open\n${preserved}\n${newLine}\n`);
    mocks.showWarningMessage.mockClear();
    expect(await verify()).toBe(true);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
  });

  test('leaves the record when the dialog is dismissed', async () => {
    fs.writeFileSync(store, oldLine);

    expect(await verify()).toBe(false);
    expect(fs.readFileSync(store, 'utf8')).toBe(oldLine);
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  test.each([false, true])('points to the OpenSSH file without offering removal (also in SyncX: %s)', async storedInSyncX => {
    fs.writeFileSync(openSshStore, oldLine);
    if (storedInSyncX) fs.writeFileSync(store, oldLine);

    expect(await verify()).toBe(false);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('HOST KEY CHANGED'),
      { modal: true, detail: expect.stringContaining(`${openSshStore}:1`) }
    );
    expect(fs.readFileSync(openSshStore, 'utf8')).toBe(oldLine);
  });

  test('offers no deletion for a line shared with another host', async () => {
    fs.writeFileSync(store, oldLine.replace(`]:${PORT}`, `]:${PORT},another.invalid`));

    expect(await verify()).toBe(false);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('HOST KEY CHANGED'),
      { modal: true, detail: expect.stringContaining(`${store}:1`) }
    );
  });

  test('offers no deletion for a revoked key', async () => {
    fs.writeFileSync(store, `${oldLine}\n@revoked ${formatKnownHostLine(HOST, PORT, TYPE, newKey)}\n`);

    expect(await verify()).toBe(false);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('marked revoked'),
      { modal: true, detail: expect.stringContaining(`${store}:2`) }
    );
  });

  test('keeps a different old key written while the dialog is open', async () => {
    fs.writeFileSync(store, oldLine);
    const replacement = formatKnownHostLine(HOST, PORT, TYPE, anotherKey);
    mocks.showErrorMessage.mockImplementationOnce(async () => {
      fs.writeFileSync(store, replacement);
      return REMOVE_KEY;
    });

    expect(await verify()).toBe(false);
    await waitForRemovalNotice();

    expect(fs.readFileSync(store, 'utf8')).toBe(replacement);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('could not safely remove'));
  });
});
