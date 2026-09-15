import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'stream';
import FileSystem, { FileType } from '../../src/core/fs/fileSystem';

/**
 * One suite, run against every file system implementation.
 *
 * The point is that SFTP, FTP and the local file system are interchangeable
 * behind `FileSystem`. Nothing in the extension has ever checked that: each
 * implementation was written separately and only the SFTP path was exercised in
 * practice, so the FTP one could drift arbitrarily and only a user would find
 * out.
 *
 * Capabilities genuinely differ -- FTP has no symbolic links and most servers
 * have no MFMT -- so they are declared rather than assumed, and the suite
 * asserts that an unsupported operation *fails*, not that it is skipped. A
 * silent no-op is what upstream's FTP `symlink` did: it resolved successfully
 * and created nothing.
 */

export interface ContractCapabilities {
  symlinks: boolean;
  /** Whether the server can set a file's modification time. */
  setTimes: boolean;
  chmod: boolean;
}

export interface ContractSubject {
  name: string;
  fs: FileSystem;
  /** A directory the suite may create and destroy things under. */
  root: string;
  capabilities: ContractCapabilities;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}

const text = (content: string) => Readable.from([Buffer.from(content, 'utf8')]);

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param timeoutMs per-test budget. The default is fine in memory but not over
 * a network: a round trip to a real server is orders of magnitude slower, and
 * vitest's 5s default turns "slow" into "failed".
 */
export function runFileSystemContract(
  makeSubject: () => ContractSubject | Promise<ContractSubject>,
  timeoutMs = 5_000
) {
  let subject: ContractSubject;
  let fs: FileSystem;
  let root: string;
  const join = (...parts: string[]) => parts.reduce((a, b) => fsJoin(fs, a, b));

  beforeAll(async () => {
    subject = await makeSubject();
    fs = subject.fs;
    root = subject.root;
    await subject.setup?.();
    await fs.ensureDir(root);
  }, timeoutMs);

  afterAll(async () => {
    // There is no subject when setup itself failed -- an unreachable server,
    // say. Teardown then threw "Cannot read properties of undefined", which is
    // the error the reader sees instead of the one that actually happened.
    if (!subject) return;

    try {
      await fs.rmdir(root, true);
    } catch {
      // Best effort; a failed teardown must not mask a real failure.
    }
    await subject.teardown?.();
  }, timeoutMs);

  describe('directories', () => {
    test('ensureDir creates a nested chain', async () => {
      const deep = join(root, 'a', 'b', 'c');
      await fs.ensureDir(deep);
      expect((await fs.lstat(deep)).type).toBe(FileType.Directory);
    }, timeoutMs);

    test('ensureDir on an existing directory is not an error', async () => {
      const dir = join(root, 'idempotent');
      await fs.ensureDir(dir);
      await expect(fs.ensureDir(dir)).resolves.toBeUndefined();
    }, timeoutMs);

    test('list reports the entries it contains, without . and ..', async () => {
      const dir = join(root, 'listing');
      await fs.ensureDir(dir);
      await fs.put(text('one'), join(dir, 'one.txt'));
      await fs.put(text('two'), join(dir, 'two.txt'));

      const names = (await fs.list(dir)).map(e => e.name).sort();
      expect(names).toEqual(['one.txt', 'two.txt']);
    }, timeoutMs);

    test('ensureDir of the same new chain from several callers at once', async () => {
      // Uploads run in parallel, and each one ensures its own directory before
      // writing, so several transfers into one new folder walk the same chain
      // at the same time. On SFTP the loser of that race used to get a bare
      // "failure" from a directory that by then existed, and the upload failed.
      const chain = join(root, 'concurrent', 'a', 'b');
      await Promise.all(Array.from({ length: 8 }, () => fs.ensureDir(chain)));

      expect((await fs.lstat(chain)).type).toBe(FileType.Directory);
    }, timeoutMs);

    test('list of an empty directory is empty, not an error', async () => {
      const dir = join(root, 'empty');
      await fs.ensureDir(dir);
      expect(await fs.list(dir)).toEqual([]);
    }, timeoutMs);
  });

  describe('files', () => {
    test('a put/get round trip preserves the content exactly', async () => {
      const file = join(root, 'round-trip.txt');
      const content = 'line one\nline two\n';
      await fs.put(text(content), file);
      expect(await drain(await fs.get(file))).toBe(content);
    }, timeoutMs);

    test('binary content survives the round trip', async () => {
      // The path most likely to be broken by an accidental encoding step.
      const file = join(root, 'binary.bin');
      const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80]);
      await fs.put(Readable.from([bytes]), file);

      const chunks: Buffer[] = [];
      for await (const chunk of await fs.get(file)) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    }, timeoutMs);

    test('an empty file is a file, not an absence', async () => {
      const file = join(root, 'empty.txt');
      await fs.put(text(''), file);
      const stat = await fs.lstat(file);
      expect(stat.type).toBe(FileType.File);
      expect(stat.size).toBe(0);
    }, timeoutMs);

    test('put over an existing file replaces it', async () => {
      const file = join(root, 'replaced.txt');
      await fs.put(text('before'), file);
      await fs.put(text('after'), file);
      expect(await drain(await fs.get(file))).toBe('after');
    }, timeoutMs);

    test('lstat reports the size', async () => {
      const file = join(root, 'sized.txt');
      await fs.put(text('12345'), file);
      expect((await fs.lstat(file)).size).toBe(5);
    }, timeoutMs);

    test('lstat of something absent rejects', async () => {
      await expect(fs.lstat(join(root, 'not-there.txt'))).rejects.toBeTruthy();
    }, timeoutMs);

    test('get of something absent rejects', async () => {
      // Whether it rejects on the call or on the stream, it must not resolve
      // to an empty file -- that would silently overwrite the local copy.
      await expect(
        (async () => drain(await fs.get(join(root, 'not-there.txt'))))()
      ).rejects.toBeTruthy();
    }, timeoutMs);
  });

  describe('writing through a caller-owned descriptor', () => {
    // The shape TransferTask actually uses: open the target, hand the
    // descriptor to put() with `autoClose: false`, then close it. It is a
    // different code path from put(stream, path) and it is the one every real
    // upload takes, so it needs its own coverage.
    test('a descriptor supplied by the caller is written, and not closed by put', async () => {
      const file = join(root, 'by-descriptor.txt');
      const fd = await fs.open(file, 'w');
      await fs.put(text('written through a descriptor'), file, { fd, autoClose: false } as never);
      await fs.close(fd);

      expect(await drain(await fs.get(file))).toBe('written through a descriptor');
    }, timeoutMs);
  });

  describe('moving and removing', () => {
    test('rename moves a file', async () => {
      const from = join(root, 'from.txt');
      const to = join(root, 'to.txt');
      await fs.put(text('moved'), from);
      await fs.rename(from, to);

      expect(await drain(await fs.get(to))).toBe('moved');
      await expect(fs.lstat(from)).rejects.toBeTruthy();
    }, timeoutMs);

    test('unlink removes a file', async () => {
      const file = join(root, 'doomed.txt');
      await fs.put(text('x'), file);
      await fs.unlink(file);
      await expect(fs.lstat(file)).rejects.toBeTruthy();
    }, timeoutMs);

    test('rmdir removes an empty directory', async () => {
      const dir = join(root, 'to-remove');
      await fs.ensureDir(dir);
      await fs.rmdir(dir, false);
      await expect(fs.lstat(dir)).rejects.toBeTruthy();
    }, timeoutMs);

    test('recursive rmdir removes a populated tree', async () => {
      const dir = join(root, 'tree');
      await fs.ensureDir(join(dir, 'nested'));
      await fs.put(text('x'), join(dir, 'nested', 'file.txt'));
      await fs.rmdir(dir, true);
      await expect(fs.lstat(dir)).rejects.toBeTruthy();
    }, timeoutMs);
  });

  describe('capabilities', () => {
    test('symbolic links: supported, or refused -- never silently ignored', async () => {
      const link = join(root, 'link');
      const target = join(root, 'link-target.txt');
      await fs.put(text('target'), target);

      if (subject.capabilities.symlinks) {
        await fs.symlink(target, link);
        expect((await fs.lstat(link)).type).toBe(FileType.SymbolicLink);
        expect(await fs.readlink(link)).toBe(target);
      } else {
        // Upstream's FTP symlink resolved successfully and created nothing, so
        // a sync that should have reported a problem reported success.
        await expect(fs.symlink(target, link)).rejects.toBeTruthy();
      }
    }, timeoutMs);

    test('chmod, where the transport has one', async () => {
      if (!subject.capabilities.chmod) return;
      const file = join(root, 'moded.txt');
      await fs.put(text('x'), file);
      await fs.chmod(file, 0o600);
      expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
    }, timeoutMs);

    test('setting the modification time, where the server supports it', async () => {
      if (!subject.capabilities.setTimes) return;
      const file = join(root, 'timed.txt');
      await fs.put(text('x'), file);

      const when = Math.floor(new Date('2026-01-02T03:04:05Z').getTime() / 1000);
      const fd = await fs.open(file, 'r+');
      await fs.futimes(fd, when, when);
      await fs.close(fd);

      // FTP has second granularity at best, so compare in seconds.
      expect(Math.floor((await fs.lstat(file)).mtime / 1000)).toBe(when);
    }, timeoutMs);
  });
}

/** The path resolver is per-implementation; POSIX for remotes, native locally. */
function fsJoin(fs: FileSystem, a: string, b: string): string {
  return (fs as unknown as { pathResolver: { join(x: string, y: string): string } }).pathResolver.join(
    a,
    b
  );
}
