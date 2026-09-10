import { describe, test, expect } from 'vitest';
import { decide, type GateInput, type Decision } from '../../../src/core/watch/decide';
import type { EntryFacts, StateRecord } from '../../../src/core/watch/state';
import type { WatchPolicy } from '../../../src/core/watch/policy';

const uploading: WatchPolicy = { autoUpload: true, autoDelete: false, followSymlinks: false };

function file(over: Partial<EntryFacts> = {}): EntryFacts {
  return { type: 'file', size: 100, mtimeMs: 1_000_000, ino: 7, dev: 2, ...over };
}

function record(over: Partial<StateRecord> = {}): StateRecord {
  return {
    size: 100,
    mtimeMs: 1_000_000,
    ino: 7,
    dev: 2,
    algorithm: 'sha256',
    hash: 'aaa',
    at: 900_000,
    ...over,
  };
}

function gate(over: Partial<GateInput> = {}): Decision {
  return decide({
    kind: 'change',
    ignored: false,
    facts: file(),
    prior: record(),
    selfWrite: false,
    policy: uploading,
    ...over,
  });
}

describe('the governing rule: an event alone never causes an upload', () => {
  test('identical metadata is dropped without reading the file', () => {
    // The decision is reached with no `content` supplied, which is the proof
    // that no hash was needed and therefore no disk read happened.
    expect(gate()).toEqual({ action: 'skip', reason: 'unchanged-metadata' });
  });

  test('property: no sequence of events uploads a file whose facts never move', () => {
    const kinds = ['create', 'change'] as const;
    for (let i = 0; i < 200; i++) {
      const kind = kinds[i % kinds.length];
      expect(gate({ kind })).toEqual({ action: 'skip', reason: 'unchanged-metadata' });
    }
  });
});

describe('scenario 1: touch, with no change to content', () => {
  test('mtime moved, content identical -- record, do not upload', () => {
    const touched = file({ mtimeMs: 2_000_000 });
    // Metadata moved, so the gate asks for the hash...
    expect(gate({ facts: touched })).toEqual({ action: 'hash-required' });
    // ...and with the hash unchanged, nothing is sent.
    expect(
      gate({ facts: touched, content: { algorithm: 'sha256', hash: 'aaa' } })
    ).toEqual({ action: 'record-only' });
  });
});

describe('scenario 2: rewritten with identical content', () => {
  test('same size, new mtime and inode -- still not uploaded', () => {
    const rewritten = file({ mtimeMs: 3_000_000, ino: 99 });
    expect(gate({ facts: rewritten })).toEqual({ action: 'hash-required' });
    expect(
      gate({ facts: rewritten, content: { algorithm: 'sha256', hash: 'aaa' } })
    ).toEqual({ action: 'record-only' });
  });
});

describe('scenario 3: chmod', () => {
  test('permissions changed but size and mtime did not -- dropped cheaply', () => {
    // chmod surfaces as IN_ATTRIB on Linux and a LAST_WRITE notification on
    // Windows, neither of which says anything about content.
    expect(gate()).toEqual({ action: 'skip', reason: 'unchanged-metadata' });
  });
});

describe('scenario 4: an event on a directory', () => {
  // The regression test for the defect that motivated this rewrite: a
  // directory URI used to reach upload(), which walked it and re-sent every
  // descendant unconditionally.
  test('a directory change never triggers a transfer', () => {
    expect(gate({ facts: file({ type: 'directory' }), kind: 'change' })).toEqual({
      action: 'skip',
      reason: 'directory-change',
    });
  });

  test('a new directory is created remotely but not walked', () => {
    expect(gate({ facts: file({ type: 'directory' }), kind: 'create', prior: undefined })).toEqual(
      { action: 'ensure-directory' }
    );
  });

  test('a directory is never uploaded even when nothing is known about it', () => {
    for (const kind of ['create', 'change'] as const) {
      const decision = gate({ facts: file({ type: 'directory' }), kind, prior: undefined });
      expect(decision.action).not.toBe('upload');
    }
  });
});

describe('scenario 5: atomic save by another tool (delete then create)', () => {
  test('the create carries new content and uploads once', () => {
    const replaced = file({ mtimeMs: 5_000_000, ino: 1234, size: 140 });
    expect(gate({ kind: 'create', facts: replaced })).toEqual({ action: 'hash-required' });
    expect(
      gate({ kind: 'create', facts: replaced, content: { algorithm: 'sha256', hash: 'bbb' } })
    ).toEqual({ action: 'upload' });
  });

  test('the delete half does not remove the remote file when autoDelete is off', () => {
    expect(gate({ kind: 'delete', facts: file({ type: 'missing' }) })).toEqual({
      action: 'skip',
      reason: 'auto-delete-disabled',
    });
  });
});

describe('scenario 6: git checkout that restores identical content', () => {
  test('mass rewrite with unchanged bytes uploads nothing', () => {
    const rewritten = file({ mtimeMs: 7_000_000, ino: 555 });
    for (let i = 0; i < 500; i++) {
      expect(
        gate({ facts: rewritten, content: { algorithm: 'sha256', hash: 'aaa' } })
      ).toEqual({ action: 'record-only' });
    }
  });
});

describe('scenario 7: git checkout that genuinely changes content', () => {
  test('only the files whose bytes differ are uploaded', () => {
    const changed = file({ mtimeMs: 7_000_000, size: 220 });
    expect(
      gate({ facts: changed, content: { algorithm: 'sha256', hash: 'ccc' } })
    ).toEqual({ action: 'upload' });
  });
});

describe('scenario 8: feedback from our own download', () => {
  test('a write we made ourselves is dropped deterministically', () => {
    // Not by timeout: the caller establishes selfWrite by comparing the facts
    // on disk against the ones the write was expected to produce.
    expect(gate({ facts: file({ mtimeMs: 9_000_000 }), selfWrite: true })).toEqual({
      action: 'skip',
      reason: 'self-write',
    });
  });
});

describe('scenario 10: whole-tree re-emission after a watcher restart', () => {
  test('every event is dropped at the metadata gate, so nothing is read', () => {
    const decisions = Array.from({ length: 1000 }, () => gate({ kind: 'change' }));
    expect(decisions.every(d => d.action === 'skip')).toBe(true);
    // `hash-required` never appears, which is what "the disk was not read" means.
    expect(decisions.some(d => d.action === 'hash-required')).toBe(false);
  });
});

describe('ignore rules run before anything else', () => {
  test('an ignored path is dropped even when its content changed', () => {
    expect(
      gate({ ignored: true, facts: file({ size: 999 }), content: { algorithm: 'sha256', hash: 'z' } })
    ).toEqual({ action: 'skip', reason: 'ignored' });
  });

  test('an ignored deletion is dropped too', () => {
    expect(
      gate({
        ignored: true,
        kind: 'delete',
        facts: file({ type: 'missing' }),
        policy: { ...uploading, autoDelete: true },
      })
    ).toEqual({ action: 'skip', reason: 'ignored' });
  });
});

describe('policy switches', () => {
  test('autoUpload off stops everything before the entry type is considered', () => {
    expect(
      gate({ policy: { ...uploading, autoUpload: false }, facts: file({ size: 1 }) })
    ).toEqual({ action: 'skip', reason: 'auto-upload-disabled' });
  });

  test('autoDelete on removes the remote file', () => {
    expect(
      gate({
        kind: 'delete',
        facts: file({ type: 'missing' }),
        policy: { ...uploading, autoDelete: true },
      })
    ).toEqual({ action: 'delete-remote' });
  });

  test('symlinks are left alone by default', () => {
    expect(gate({ facts: file({ type: 'symlink', mtimeMs: 2 }) })).toEqual({
      action: 'skip',
      reason: 'symlink',
    });
  });

  test('sockets and devices are never transferred', () => {
    expect(gate({ facts: file({ type: 'other', mtimeMs: 2 }) })).toEqual({
      action: 'skip',
      reason: 'unsupported-entry',
    });
  });
});

describe('previously unknown files', () => {
  test('a genuinely new file is uploaded', () => {
    expect(gate({ kind: 'create', prior: undefined })).toEqual({ action: 'upload' });
  });
});

describe('identity comparison', () => {
  test('a differing inode counts as a change even when size and mtime match', () => {
    expect(gate({ facts: file({ ino: 4242 }) })).toEqual({ action: 'hash-required' });
  });

  test('missing identity on either side is not treated as a mismatch', () => {
    // Some file systems do not report a usable inode; absence must not force a
    // hash of every file on every event.
    expect(gate({ facts: file({ ino: undefined, dev: undefined }) })).toEqual({
      action: 'skip',
      reason: 'unchanged-metadata',
    });
    expect(gate({ prior: record({ ino: undefined, dev: undefined }) })).toEqual({
      action: 'skip',
      reason: 'unchanged-metadata',
    });
  });
});

describe('digest algorithm changes', () => {
  test('a record written under another algorithm is not compared, it is re-sent', () => {
    expect(
      gate({
        facts: file({ mtimeMs: 2 }),
        prior: record({ algorithm: 'md5', hash: 'aaa' }),
        content: { algorithm: 'sha256', hash: 'aaa' },
      })
    ).toEqual({ action: 'upload' });
  });
});

describe('isTransfer', () => {
  test('true only for decisions that put bytes on the network', async () => {
    const { isTransfer } = await import('../../../src/core/watch/decide');
    expect(isTransfer({ action: 'upload' })).toBe(true);
    expect(isTransfer({ action: 'delete-remote' })).toBe(true);
    expect(isTransfer({ action: 'ensure-directory' })).toBe(false);
    expect(isTransfer({ action: 'record-only' })).toBe(false);
    expect(isTransfer({ action: 'hash-required' })).toBe(false);
    expect(isTransfer({ action: 'skip', reason: 'ignored' })).toBe(false);
  });
});
