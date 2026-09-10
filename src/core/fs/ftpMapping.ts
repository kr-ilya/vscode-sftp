import { FileInfo, FileType as FtpFileType } from 'basic-ftp';
import { FileType, FileStats } from './fileSystem';

/**
 * Translation between what an FTP listing reports and the contract the rest of
 * the extension works against.
 *
 * Separate from the file system so it can be tested without a socket. These are
 * the parts most likely to be quietly wrong -- a permissions mask off by a
 * triad, a timestamp in the wrong zone -- and least likely to announce it.
 */

/** What to assume when the server reports no permissions at all. */
export const ASSUMED_MODE = 0o666;

export function toMode(permissions: FileInfo['permissions']): number {
  if (!permissions) return ASSUMED_MODE;
  // basic-ftp gives each triad as a 3-bit mask; ours is the familiar octal.
  return (permissions.user << 6) | (permissions.group << 3) | permissions.world;
}

export function toFileType(type: FtpFileType): FileType {
  switch (type) {
    case FtpFileType.Directory:
      return FileType.Directory;
    case FtpFileType.File:
      return FileType.File;
    case FtpFileType.SymbolicLink:
      return FileType.SymbolicLink;
    default:
      return FileType.Unknown;
  }
}

/**
 * @param toLocalTime converts a server timestamp to local time, applying the
 * configured clock offset.
 */
export function toFileStat(info: FileInfo, toLocalTime: (ms: number) => number): FileStats {
  // FTP timestamps have no sub-second precision, and older listing formats omit
  // the year for recent files. basic-ftp fills in what it can; a listing it
  // could not date at all becomes 0 rather than "now", so it is never mistaken
  // for a fresh file.
  const mtime = toLocalTime(info.modifiedAt ? info.modifiedAt.getTime() : 0);
  return {
    type: toFileType(info.type),
    mode: toMode(info.permissions),
    size: info.size,
    mtime,
    // FTP does not report access time; mtime is closer to the truth than zero.
    atime: mtime,
    target: info.link || undefined,
  };
}

/** MFMT takes UTC as YYYYMMDDHHMMSS. */
export function formatMfmtTimestamp(date: Date): string {
  const pad = (n: number) => `0${n}`.slice(-2);
  return (
    `${date.getUTCFullYear()}` +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}
