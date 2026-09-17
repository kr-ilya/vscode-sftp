// Flat config. Replaces tslint.json (tslint has been deprecated since 2019 and
// was never actually invoked in this repo -- there was no lint script).
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `coverage/` is generated, and the report it writes carries its own
    // eslint directives -- so a coverage run used to make the next lint noisy.
    ignores: ['dist/', 'out/', 'coverage/', 'node_modules/', '.vscode-test/', '**/*.d.ts'],
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
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.ts', '*.config.mjs', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // src/core must not depend on the editor. The transitive version of this
    // check -- which is the one that actually catches regressions -- lives in
    // scripts/check-core-purity.mjs and runs in CI; this catches the direct
    // case at the moment of typing it.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'src/core must stay free of the editor API. Declare the capability core needs and have src/modules/coreHost.ts supply it.',
            },
          ],
        },
      ],
    },
  }
);
