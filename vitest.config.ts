import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests live in tests/unit. Database tests that need a Supabase project are added in a later phase.
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
