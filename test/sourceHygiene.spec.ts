import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Bytes that have no business being in a source file.
 *
 * A NUL written as a literal byte rather than an escape has happened twice
 * here, both times as a separator inside a template literal. It compiles, it
 * runs, and it is invisible in an editor -- but every tool that decides whether
 * a file is text by sampling it for one treats the module as binary and stops
 * looking inside. `grep` reports "Binary file matches" instead of the line, and
 * `git diff` shows "Bin 3447 -> 4072 bytes" instead of the change. The escape
 * produces the same string; only the source differs.
 */

const ROOTS = ['src', 'test', 'scripts'];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md)$/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      found.push(...sourceFiles(full));
    } else if (TEXT.test(item.name)) {
      found.push(full);
    }
  }
  return found;
}

const files = ROOTS.flatMap(root => sourceFiles(root));

describe('source files are text', () => {
  test('there are files to check at all', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(100);
  });

  test('none contains a NUL byte', () => {
    const offenders = files.filter(file => fs.readFileSync(file).includes(0));

    expect(offenders).toEqual([]);
  });
});
