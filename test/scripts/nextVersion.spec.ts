import { describe, test, expect } from 'vitest';
import { nextVersion } from '../../scripts/next-version.mjs';

/**
 * The version scheme is YY.M.N, and the trap in it is the month.
 *
 * `26.09.0` is what a person writes and what semver forbids -- leading zeros
 * are not allowed in numeric identifiers -- so vsce refuses to package it. The
 * whole point of computing the version is to never write that.
 */

const at = (iso: string) => new Date(iso);

describe('the next version', () => {
  test('starts a month at .0', () => {
    expect(nextVersion('26.8.3', at('2026-09-15T12:00:00Z'))).toBe('26.9.0');
  });

  test('counts up within a month', () => {
    expect(nextVersion('26.9.0', at('2026-09-20T12:00:00Z'))).toBe('26.9.1');
    expect(nextVersion('26.9.9', at('2026-09-20T12:00:00Z'))).toBe('26.9.10');
  });

  test('never pads the month', () => {
    // The one thing this script exists to prevent.
    for (const month of ['01', '02', '09']) {
      const version = nextVersion('25.12.0', at(`2026-${month}-10T12:00:00Z`));
      expect(version).not.toMatch(/\.0\d/);
    }
    expect(nextVersion('25.12.0', at('2026-09-10T12:00:00Z'))).toBe('26.9.0');
  });

  test('crosses into a new year', () => {
    expect(nextVersion('26.12.4', at('2027-01-05T12:00:00Z'))).toBe('27.1.0');
  });

  test('moves on from a version that is not in the scheme at all', () => {
    expect(nextVersion('1.0.0', at('2026-09-15T12:00:00Z'))).toBe('26.9.0');
  });

  test('refuses to go backwards', () => {
    // A wrong clock, or a hand-edited manifest, would otherwise produce a
    // version the Marketplace rejects -- at the end of the release, not before.
    expect(() => nextVersion('26.10.0', at('2026-09-15T12:00:00Z'))).toThrow(/does not come after/);
  });

  test('every version it produces is ordered after the one before', () => {
    let current = '26.1.0';
    for (const [year, month] of [[2026, 1], [2026, 2], [2026, 9], [2026, 10], [2026, 12], [2027, 1]]) {
      const next = nextVersion(current, new Date(Date.UTC(year, month - 1, 10)));
      const [a, b] = [next, current].map(v => v.split('.').map(Number));
      expect(
        a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))),
        `${next} must come after ${current}`
      ).toBe(true);
      current = next;
    }
  });
});
