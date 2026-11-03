import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    // Native analytical readers and spawned CLI processes share the same CPU/memory budget.
    maxWorkers: 2,
    testTimeout: 10000,
  },
});
