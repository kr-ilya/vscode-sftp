import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import MemfsLocalFileSystem from '../../helper/memfsLocalFs';

/**
 * The memfs double has to cover every method the real one implements with
 * fs-extra.
 *
 * `vi.mock('fs')` cannot redirect fs-extra -- it is a package in node_modules
 * that reaches the real `fs` through graceful-fs -- so any method left
 * uncovered writes to the actual disk. The transfer tests build their trees at
 * `/local` and `/remote`, so that meant real files in the root of the drive on
 * Windows, and `EACCES: mkdir '/remote'` on Linux, which is how CI found it.
 *
 * Checked by reading the source rather than by running anything: the leak is
 * silent on the machine where it happens to be permitted, which is exactly the
 * machine a developer is using.
 */

const SOURCE = path.join(__dirname, '../../../src/core/fs/localFileSystem.ts');

/** Method names in LocalFileSystem whose body calls fs-extra. */
function methodsBackedByFsExtra(): string[] {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const found = new Set<string>();
  let current: string | null = null;

  for (const line of source.split('\n')) {
    // A method opening at class-body indentation: `  name(args...`
    const declaration = /^ {2}(?:async )?([a-zA-Z_][\w]*)\s*\(/.exec(line);
    if (declaration && !['constructor', 'if', 'for', 'while', 'switch'].includes(declaration[1])) {
      current = declaration[1];
    }
    if (current && line.includes('fse.')) {
      found.add(current);
    }
  }

  return [...found].sort();
}

describe('the memfs local file system', () => {
  test('overrides every method the real one routes through fs-extra', () => {
    const uncovered = methodsBackedByFsExtra().filter(
      name => !Object.prototype.hasOwnProperty.call(MemfsLocalFileSystem.prototype, name)
    );

    expect(
      uncovered,
      `test/helper/memfsLocalFs.ts must override these, or the transfer tests write to the real disk: ${uncovered.join(', ')}`
    ).toEqual([]);
  });

  test('and the list it is checking against is not empty', () => {
    // A regex that stopped matching would make the test above pass by finding
    // nothing at all.
    expect(methodsBackedByFsExtra().length).toBeGreaterThan(4);
  });
});
