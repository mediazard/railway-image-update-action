import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.d.ts'],
      thresholds: {
        // v1.0.0-rc.1 floor; tighten as coverage improves. Lines/statements/functions
        // already exceed 90% target; branches at ~84% on first pass.
        lines: 90,
        statements: 90,
        branches: 80,
        functions: 90,
      },
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
