import { describe, test, expect } from 'vitest';
import { FileInfo, FileType as FtpFileType } from 'basic-ftp';
import {
  toMode,
  toFileType,
  toFileStat,
  formatMfmtTimestamp,
  ASSUMED_MODE,
} from '../../../src/core/fs/ftpMapping';
import { FileType } from '../../../src/core/fs/fileSystem';

/**
 * These are the parts of the FTP transport most likely to be quietly wrong -- a
 * permissions mask off by a triad, a timestamp in the wrong zone -- and least
 * likely to announce it. The transfer still succeeds; the file just ends up
 * with the wrong mode, or looks perpetually out of date.
 */

function info(over: Partial<FileInfo> = {}): FileInfo {
  const value = new FileInfo(over.name ?? 'file.txt');
  Object.assign(value, over);
  return value;
}

describe('toMode', () => {
  test('composes the three permission triads into an octal mode', () => {
    const mode = toMode({ user: 6, group: 4, world: 4 });
    expect(mode).toBe(0o644);
  });

  test('handles full permissions', () => {
    expect(toMode({ user: 7, group: 7, world: 7 })).toBe(0o777);
  });

  test('handles the execute bit on its own', () => {
    expect(toMode({ user: 7, group: 5, world: 5 })).toBe(0o755);
  });

  test('falls back when the server reports nothing', () => {
    // Windows FTP servers commonly report no permissions at all.
    expect(toMode(undefined as never)).toBe(ASSUMED_MODE);
  });

  test('a zero triad is a real value, not an absent one', () => {
    expect(toMode({ user: 6, group: 0, world: 0 })).toBe(0o600);
  });
});

describe('toFileType', () => {
  test.each([
    [FtpFileType.File, FileType.File],
    [FtpFileType.Directory, FileType.Directory],
    [FtpFileType.SymbolicLink, FileType.SymbolicLink],
    [FtpFileType.Unknown, FileType.Unknown],
  ])('maps %s', (from, to) => {
    expect(toFileType(from)).toBe(to);
  });
});

describe('toFileStat', () => {
  const identity = (ms: number) => ms;

  test('carries size, type and permissions across', () => {
    const stat = toFileStat(
      info({ size: 4096, type: FtpFileType.Directory, permissions: { user: 7, group: 5, world: 5 } }),
      identity
    );
    expect(stat).toMatchObject({ size: 4096, type: FileType.Directory, mode: 0o755 });
  });

  test('applies the configured clock offset to the timestamp', () => {
    // `remoteTimeOffsetInHours` exists because FTP servers routinely report
    // local rather than UTC time; getting the direction wrong makes every file
    // look permanently modified.
    const at = new Date('2026-09-10T12:00:00Z');
    const sixHoursBack = (ms: number) => ms - 6 * 3600 * 1000;
    const stat = toFileStat(info({ modifiedAt: at }), sixHoursBack);
    expect(stat.mtime).toBe(at.getTime() - 6 * 3600 * 1000);
  });

  test('an undated listing becomes 0, not the current time', () => {
    // If it became "now", every undated file would look freshly modified and be
    // re-uploaded on every sync.
    expect(toFileStat(info({ modifiedAt: undefined as never }), identity).mtime).toBe(0);
  });

  test('atime mirrors mtime, because FTP does not report access time', () => {
    const stat = toFileStat(info({ modifiedAt: new Date(1_000_000) }), identity);
    expect(stat.atime).toBe(stat.mtime);
  });

  test('a symlink target is carried when the server reports one', () => {
    expect(toFileStat(info({ type: FtpFileType.SymbolicLink, link: '../real' }), identity).target)
      .toBe('../real');
  });

  test('an empty link string is treated as no target', () => {
    expect(toFileStat(info({ link: '' }), identity).target).toBeUndefined();
  });
});

describe('formatMfmtTimestamp', () => {
  test('renders UTC as YYYYMMDDHHMMSS', () => {
    expect(formatMfmtTimestamp(new Date('2026-09-10T04:05:06Z'))).toBe('20260910040506');
  });

  test('pads every field to two digits', () => {
    expect(formatMfmtTimestamp(new Date('2026-01-02T03:04:05Z'))).toBe('20260102030405');
  });

  test('uses UTC, not the local zone', () => {
    // MFMT is specified in UTC. Sending local time silently shifts every
    // timestamp by the machine's offset.
    const date = new Date('2026-06-15T23:30:00Z');
    expect(formatMfmtTimestamp(date)).toBe('20260615233000');
  });

  test('handles the end of a year', () => {
    expect(formatMfmtTimestamp(new Date('2026-12-31T23:59:59Z'))).toBe('20261231235959');
  });
});
