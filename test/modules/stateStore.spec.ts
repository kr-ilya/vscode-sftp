import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri } from '../fakes/vscode';
import { loadPersistentState } from '../../src/modules/watch/stateStore';
import { recordFrom, type EntryFacts } from '../../src/core/watch/state';
import { createPathKeyer, type PathKey } from '../../src/core/watch/pathkey';

/**
 * What the change-detection state actually looks like on disk.
 *
 * The file holds one record per file in the workspace and is rewritten whole
 * whenever anything changes, so its shape is a cost paid over and over rather
 * than once. The pure serialisation is covered in core; this covers the loader
 * that puts it on a real disk and reads it back.
 */

const keyer = createPathKeyer('insensitive');
const facts: EntryFacts = { type: 'file', size: 10, mtimeMs: 100, ino: 1, dev: 2 };
const record = (hash: string) => recordFrom(facts, { algorithm: 'sha256', hash }, 50);

let storage: string;
let root: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'syncx-state-'));
  root = path.join(storage, 'project');
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

/** The single file the loader writes under the storage directory. */
function stateFile(): string {
  const dir = path.join(storage, 'watch-state');
  const [name] = fs.readdirSync(dir);
  return path.join(dir, name);
}

function load(scope = 'scope-1') {
  return loadPersistentState(Uri.file(storage) as never, root, scope, keyer(root));
}

describe('what is written', () => {
  test('keys are relative to the watched root, which is written once', async () => {
    const state = await load();
    state.store.set(keyer(path.join(root, 'src', 'app.ts')), record('one'));
    await state.flush();

    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));

    expect(raw.base).toBe(keyer(root));
    expect(Object.keys(raw.entries)).toEqual(['src/app.ts']);
  });

  test('the file is one line, not pretty printed', async () => {
    // It is a cache, not something anyone reads; indentation would be a third
    // of it.
    const state = await load();
    state.store.set(keyer(path.join(root, 'a.txt')), record('one'));
    await state.flush();

    expect(fs.readFileSync(stateFile(), 'utf8').trim()).not.toContain('\n');
  });
});

describe('what is read back', () => {
  test('a round trip restores every record under its full path', async () => {
    const first = await load();
    const key = keyer(path.join(root, 'src', 'app.ts'));
    first.store.set(key, record('one'));
    await first.flush();
    first.dispose();

    const second = await load();

    expect(second.store.size).toBe(1);
    expect(second.store.get(key)?.hash).toBe('one');
  });

  test('a state file written for another root is discarded, not rebased', async () => {
    // Its keys would name files that do not exist here, and the gate would then
    // read every real one as new -- which is the one direction this mechanism
    // must never fail in.
    const first = await load();
    first.store.set(keyer(path.join(root, 'a.txt')), record('one'));
    await first.flush();

    const file = stateFile();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.base = '/somewhere/else';
    fs.writeFileSync(file, JSON.stringify(raw));

    const second = await load();

    expect(second.store.size).toBe(0);
  });

  test('no previous file means an empty store, which uploads nothing', async () => {
    const state = await load();

    expect(state.store.size).toBe(0);
  });

  test('a different scope gets its own file', async () => {
    const staging = await load('staging');
    staging.store.set(keyer(path.join(root, 'a.txt')), record('one'));
    await staging.flush();

    const production = await load('production');
    production.store.set(keyer(path.join(root, 'a.txt')), record('two'));
    await production.flush();

    expect(fs.readdirSync(path.join(storage, 'watch-state'))).toHaveLength(2);
    expect((await load('staging')).store.get(keyer(path.join(root, 'a.txt')))?.hash).toBe('one');
  });
});

describe('saving', () => {
  test('a dirty store is written after the debounce, not on every change', async () => {
    const state = await load();
    state.store.set(keyer(path.join(root, 'a.txt')) as PathKey, record('one'));
    state.markDirty();

    expect(fs.existsSync(path.join(storage, 'watch-state'))).toBe(false);

    await state.flush();
    expect(Object.keys(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).entries)).toEqual(['a.txt']);
  });

  test('a disposed store stops scheduling writes', async () => {
    const state = await load();
    state.dispose();
    state.store.set(keyer(path.join(root, 'a.txt')), record('one'));
    state.markDirty();

    expect(fs.existsSync(path.join(storage, 'watch-state'))).toBe(false);
  });
});
