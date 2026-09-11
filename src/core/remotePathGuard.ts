/**
 * Guarding the first write to a remote path.
 *
 * A typo in `remotePath` -- `/` where `/var/www/site` was meant -- sends the
 * whole project into the server's root on the first upload, over whatever was
 * there. Nothing in upstream or either fork asks before that happens; the first
 * sign is the damage.
 *
 * The guard is a one-time confirmation per destination, not a heuristic, so it
 * catches every typo rather than the ones that look alarming. The risk
 * assessment below only decides how loudly to ask.
 *
 * Pure: no editor, no network. What the prompt says and where approvals are
 * kept belong to the adapter.
 */

export type RemotePathRisk = 'ordinary' | 'broad' | 'system';

export interface RemotePathAssessment {
  risk: RemotePathRisk;
  /** Why, in words the prompt can show. Absent when the path looks ordinary. */
  reason?: string;
}

/**
 * Directories that are part of the operating system. Writing a project into one
 * is never what was meant.
 */
const SYSTEM_ROOTS = new Set([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/sbin',
  '/sys',
  '/usr',
  '/windows',
  '/program files',
  '/program files (x86)',
]);

/**
 * Directories that hold many unrelated things. A project might legitimately
 * live directly under one, so this is a question rather than an alarm.
 */
const BROAD_ROOTS = new Set([
  '/home',
  '/srv',
  '/opt',
  '/mnt',
  '/media',
  '/tmp',
  '/data',
  '/www',
  // Deliberately here rather than among the system roots. `/var/www/...` is the
  // single most common place to deploy a site, and a guard that objects to the
  // ordinary case gets clicked through -- which costs more than it saves.
  '/var',
]);

export function assessRemotePath(remotePath: string): RemotePathAssessment {
  const normalized = normalize(remotePath);

  if (normalized === '' || normalized === '/') {
    return {
      risk: 'system',
      reason: 'This is the root of the server\'s file system.',
    };
  }

  // A bare Windows drive, e.g. `C:` or `C:/`.
  if (/^[a-z]:$/i.test(normalized)) {
    return { risk: 'system', reason: 'This is the root of a drive.' };
  }

  const lower = normalized.toLowerCase();

  if (SYSTEM_ROOTS.has(lower)) {
    return { risk: 'system', reason: 'This is a system directory.' };
  }

  if (BROAD_ROOTS.has(lower)) {
    return {
      risk: 'broad',
      reason: 'This directory usually holds many unrelated things.',
    };
  }

  // One segment below a system root -- `/etc/nginx`, `/usr/local` -- is still
  // somewhere a project does not belong.
  const firstSegment = `/${lower.split('/').filter(Boolean)[0] ?? ''}`;
  if (SYSTEM_ROOTS.has(firstSegment)) {
    return { risk: 'system', reason: `This is inside ${firstSegment}, a system directory.` };
  }

  return { risk: 'ordinary' };
}

/** Strips a trailing separator and unifies separators, without resolving. */
function normalize(remotePath: string): string {
  const unified = remotePath.trim().replace(/\\/g, '/');
  if (unified.length > 1 && unified.endsWith('/')) {
    return unified.slice(0, -1);
  }
  return unified;
}

export interface RemoteDestination {
  protocol: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
}

/**
 * Identifies one destination, so approving `/var/www` on one server does not
 * approve it on another.
 */
export function destinationKey(destination: RemoteDestination): string {
  const { protocol, host, port, username, remotePath } = destination;
  return [protocol, host, String(port), username, normalize(remotePath)]
    .map(field => field.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'))
    .join('|');
}

export function describeDestination(destination: RemoteDestination): string {
  const { protocol, host, port, username, remotePath } = destination;
  return `${normalize(remotePath)} on ${username}@${host}:${port} (${protocol})`;
}
