import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/__tests__/**/*.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**'],
    },
  },
  resolve: {
    alias: {
      // The extension host is not present under the unit test runner. Tests
      // that need editor APIs get an explicit typed fake -- anything it does
      // not implement must fail loudly rather than silently no-op.
      vscode: fileURLToPath(new URL('test/fakes/vscode.ts', import.meta.url)),
    },
  },
});
