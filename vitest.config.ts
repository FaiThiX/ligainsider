import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['dist/**', 'base/**', 'src/app.ts', 'src/discord/app.ts'],
      thresholds: {
        branches: 65,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
});
