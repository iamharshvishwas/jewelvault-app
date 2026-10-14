import { defineConfig } from 'vitest/config';

// The database tests that need more than one connection or the HTTP API: `LANE=a npm run db:test:2`.
// (The unit tests keep their own config in the repository root; the pgTAP tests are SQL files run by `npm run db:test`.)
//
// Files run one at a time: they share one database per lane, and a test that commits (a lock test, a concurrency test)
// must not meet the committed rows of another file. Tests inside a file also run in order.
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    // Two-session tests wait for locks, and the role statement timeout of the platform is 8 to 15 seconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
