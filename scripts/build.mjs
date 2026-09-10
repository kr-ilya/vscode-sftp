// Build entry point. Replaces the former webpack + ts-loader pipeline.
//
// Bundling model (ADR: "Развилка бандлинга"): everything except `vscode` is
// bundled into a single dist/extension.js, and node_modules is NOT shipped in
// the .vsix. See .vscodeignore, which is the other half of this decision --
// the two files must always change together.
//
// Type checking is deliberately NOT done here: esbuild strips types without
// checking them. `npm run typecheck` (tsc --noEmit) is the checker, and CI
// runs both.

import { build, context } from 'esbuild';
import process from 'node:process';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * ssh2 optionally loads native acceleration: the `cpu-features` module and a
 * prebuilt `sshcrypto.node` binding. Both of its requires are wrapped in
 * try/catch with a pure-JS fallback.
 *
 * esbuild cannot bundle a binary .node file, and shipping prebuilt binaries
 * would mean the .vsix only works on the platform it was packaged on. So we
 * resolve both to a stub that throws on require -- exactly the failure ssh2
 * already handles -- and ssh2 falls back to node:crypto.
 *
 * The stub throws rather than exporting an empty object so the failure is
 * explicit and greppable, instead of ssh2 receiving a malformed module.
 */
const stubNativeAddons = {
  name: 'stub-native-addons',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(^cpu-features$|\.node$)/ }, args => ({
      path: args.path,
      namespace: 'native-stub',
    }));

    pluginBuild.onLoad({ filter: /.*/, namespace: 'native-stub' }, args => ({
      contents: `throw new Error(${JSON.stringify(
        `[syncx] native addon ${args.path} is not bundled; ` +
          'falling back to pure-JS crypto'
      )});`,
      loader: 'js',
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  // VS Code 1.90 ships Electron 29 / Node 20.
  target: 'node20',
  format: 'cjs',
  // Provided by the extension host; must never be bundled.
  external: ['vscode'],
  plugins: [stubNativeAddons],
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[syncx] watching...');
} else {
  await build(options);
}
