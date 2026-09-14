#!/usr/bin/env node
/**
 * Works out the next version under this project's scheme: YY.M.N.
 *
 *   26.9.0   first release of September 2026
 *   26.9.1   the next one that month
 *   26.10.0  October
 *
 * Why a script rather than typing it: the month must not be zero-padded.
 * `26.09.0` is not valid semver -- leading zeros are forbidden -- and vsce
 * refuses to package it, which is a thing to discover at release time rather
 * than before. The obvious way to write a date is the one that does not work.
 *
 *   node scripts/next-version.mjs            print it
 *   node scripts/next-version.mjs --write    and set it in package.json
 */
import { readFile, writeFile } from 'node:fs/promises';

const MANIFEST = new URL('../package.json', import.meta.url);

/** YY.M with no padding, from a date. */
function period(when) {
  return `${when.getFullYear() % 100}.${when.getMonth() + 1}`;
}

/** Compares two YY.M.N versions numerically, part by part. */
function isAfter(candidate, current) {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function nextVersion(current, when = new Date()) {
  const prefix = `${period(when)}.`;
  const release = current.startsWith(prefix) ? Number(current.slice(prefix.length)) + 1 : 0;
  const candidate = `${prefix}${release}`;

  // A version that does not move forward would be rejected by the Marketplace
  // anyway, and silently by nothing else -- so say which two are the problem.
  if (!/^\d+\.\d+\.\d+$/.test(current)) {
    return candidate;
  }
  if (!isAfter(candidate, current)) {
    throw new Error(
      `${candidate} does not come after ${current}. Check the clock, or the version in package.json.`
    );
  }

  return candidate;
}

const manifest = await readFile(MANIFEST, 'utf8');
const current = JSON.parse(manifest).version;
const next = nextVersion(current);

if (process.argv.includes('--write')) {
  // A targeted replacement, not a JSON round trip: the manifest is hand
  // formatted and rewriting it would produce a diff of the whole file.
  const updated = manifest.replace(/("version":\s*)"[^"]+"/, `$1"${next}"`);
  if (updated === manifest) {
    throw new Error('could not find the version field in package.json');
  }
  await writeFile(MANIFEST, updated);
  console.log(`${current} -> ${next}`);
} else {
  console.log(next);
}
