/**
 * Fails if anything under src/core can reach the `vscode` module.
 *
 * ESLint can forbid a direct `import ... from 'vscode'`, and it does (see
 * eslint.config.mjs). What it cannot see is the case that actually happens:
 * a core file imports one innocuous helper, that helper's barrel re-exports a
 * module that shows a dialog, and the editor API is back in core without a
 * single line in core mentioning it. Every instance found while doing this
 * split was of that shape -- the logger, the helper barrel, the app singleton.
 *
 * So this walks the real import graph instead.
 *
 * Usage: node scripts/check-core-purity.mjs [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = 'src';
const GUARDED_PREFIX = 'src/core/';
const FORBIDDEN = 'vscode';
const verbose = process.argv.includes('--verbose');

function collectSources(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(p, acc);
    else if (entry.name.endsWith('.ts')) acc.push(p.split(path.sep).join('/'));
  }
  return acc;
}

const files = collectSources(ROOT);
const fileSet = new Set(files);

/** Resolves a specifier to a project file, or returns it unchanged (a package). */
function resolve(from, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return base;
}

const graph = new Map();
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [
    ...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
  ].map(m => m[1]);
  graph.set(file, specifiers.map(s => resolve(file, s)));
}

/** Shortest import chain from `file` to the forbidden module, or null. */
function findPath(file) {
  const queue = [[file]];
  const seen = new Set([file]);
  while (queue.length) {
    const chain = queue.shift();
    const current = chain[chain.length - 1];
    for (const dep of graph.get(current) ?? []) {
      if (dep === FORBIDDEN) return [...chain, dep];
      if (!graph.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      queue.push([...chain, dep]);
    }
  }
  return null;
}

const guarded = files.filter(f => f.startsWith(GUARDED_PREFIX) && !f.includes('__tests__'));
const violations = [];
for (const file of guarded) {
  const chain = findPath(file);
  if (chain) violations.push(chain);
}

if (violations.length === 0) {
  console.log(`core purity: OK -- ${guarded.length} files under ${GUARDED_PREFIX}, none reach '${FORBIDDEN}'`);
  process.exit(0);
}

console.error(
  `core purity: ${violations.length} file(s) under ${GUARDED_PREFIX} can reach '${FORBIDDEN}'.\n` +
    'Inject the capability instead: declare the shape core needs and have the\n' +
    'editor layer supply it (see src/modules/coreHost.ts).\n'
);
for (const chain of violations) {
  console.error(`  ${chain.join('\n    -> ')}\n`);
}
if (verbose) console.error(`checked ${files.length} files total`);
process.exit(1);
