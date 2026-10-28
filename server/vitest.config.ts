import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Many tests share the settings rows of one test database; running files one at a
    // time stops them overwriting each other's settings (random failures otherwise).
    fileParallelism: false,
  },
});
