import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests live in tests/unit. The browser tests are tests/e2e (playwright.config.ts).
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
