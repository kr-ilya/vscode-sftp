// Flat config. Replaces tslint.json (tslint has been deprecated since 2019 and
// was never actually invoked in this repo -- there was no lint script).
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'out/', 'node_modules/', '.vscode-test/', '**/*.d.ts'],
  },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // The upstream codebase is not yet typed strictly enough to forbid `any`.
      // Tightened as modules move into src/core (see roadmap iteration 5).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.ts', '*.config.mjs', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // sshClient hooks ssh2's internal file-descriptor calls by wrapping
    // arbitrary callbacks, which needs `arguments` and a `this` alias to stay
    // transparent to the wrapped function. Rewriting that to rest parameters is
    // mechanical but touches fd lifetime accounting, and a regression there
    // means leaked descriptors or a hung transfer -- not a trade worth making
    // for a style rule. These downgrade to warnings until the transport is
    // rewritten against the RemoteFileSystem contract (roadmap iteration 8),
    // at which point this block should be deleted rather than extended.
    files: ['src/core/remote-client/sshClient.ts'],
    rules: {
      'prefer-rest-params': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
    },
  }
);
