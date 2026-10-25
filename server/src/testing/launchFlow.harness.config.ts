import { defineConfig } from 'vitest/config';

/**
 * Explicit opt-in runner. Ordinary `server/vitest.config.ts` does not discover
 * this `.harness.ts` file, and no application entry point imports it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/testing/launchFlow.harness.ts'],
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
