/**
 * Generates schema/config.schema.json from src/core/config/schema.ts.
 *
 * The JSON schema exists only to give `.vscode/sftp.json` IntelliSense in the
 * editor. It used to be maintained by hand, separately from the joi schema that
 * actually validated the file, and the two had drifted apart -- fields accepted
 * at runtime but undocumented, and a documented `ignore` default that never
 * applied. Generating it removes the possibility of that drift rather than
 * relying on anyone noticing it.
 *
 * `--check` verifies the committed file is current without writing, which is
 * what CI runs.
 *
 * Usage: node scripts/gen-schema.mjs [--check]
 */

import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const OUTPUT = 'schema/config.schema.json';
const check = process.argv.includes('--check');

// The schema is TypeScript, so bundle it to something node can import. esbuild
// is already the project's bundler; using it here avoids a second toolchain.
const workDir = await mkdtemp(path.join(tmpdir(), 'syncx-schema-'));
const bundlePath = path.join(workDir, 'schema.mjs');

try {
  await build({
    entryPoints: ['src/core/config/schema.ts'],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });

  const { configSchema } = await import(pathToFileURL(bundlePath).href);
  const { z } = await import('zod');

  const configJsonSchema = z.toJSONSchema(configSchema, { target: 'draft-7' });
  delete configJsonSchema.$schema;

  // A config file holds either one configuration or an array of them.
  const document = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'SyncX configuration',
    description:
      'Generated from src/core/config/schema.ts by scripts/gen-schema.mjs. Do not edit by hand.',
    oneOf: [
      { $ref: '#/definitions/configuration' },
      { type: 'array', items: { $ref: '#/definitions/configuration' } },
    ],
    definitions: { configuration: configJsonSchema },
  };

  const rendered = JSON.stringify(document, null, 2) + '\n';

  if (check) {
    let current = null;
    try {
      current = await readFile(OUTPUT, 'utf8');
    } catch {
      // falls through to the mismatch report below
    }
    if (current !== rendered) {
      console.error(
        `${OUTPUT} is out of date with src/core/config/schema.ts.\n` +
          'Run `npm run gen:schema` and commit the result.'
      );
      process.exit(1);
    }
    console.log(`${OUTPUT} is up to date`);
  } else {
    await writeFile(OUTPUT, rendered);
    const properties = Object.keys(configJsonSchema.properties ?? {}).length;
    console.log(`wrote ${OUTPUT} (${properties} properties)`);
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
