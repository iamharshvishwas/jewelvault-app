# Tests

Two kinds of test, and the gates that run them. The spec, the plan and the task list are in the `jewelvault-api` repository (`specs/p1-foundation-and-money/`); the name of the spec test goes in the `describe` ("T-E04 ...", "PT-W12 ..."), so that `npm test -- -t T-E04` finds it.

| Suite       | Command                                 | Where                    | What it is for                                                                                                                  |
| ----------- | --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `npm test`                              | `tests/unit/*.test.ts`   | the stores, the API client, the screens drawn on the server side of React, the scripts; no browser, no network, no Docker       |
| End to end  | `E2E=1 LANE=<lane> JV_API_DIR=<api checkout> npx playwright test` | `tests/e2e/*.spec.ts` | a real browser against a throw-away API and MariaDB (a lane); see `tests/e2e/README.md`                                         |
| Build check | `npm run build && npm run check:build`  | `scripts/check-build.mjs` | the static export, `src/` and `vercel.json` (T-D12); its own tests are `tests/unit/check-build.test.ts` and `hosting-headers.test.ts` |
| Everything  | `npm run verify`                        | `scripts/verify.mjs`     | typecheck, lint of the changed files, unit, build, build check; `E2E=1` (with `LANE` and `JV_API_DIR`) adds the browser tests    |

Every test is written first and seen to fail for the right reason, then the code is written.

## Unit tests

- A store test imports a fresh copy of the store over a stubbed `fetch` and a fake `window` (`vi.resetModules()`); the fake servers and the rows they hold are in `tests/unit/support/`. Nothing reaches a real network.
- The real API client is used in every test of a save, with a stubbed `fetch`, so the headers, the Idempotency-Key and the error map are the ones of the site.
- `tests/unit/clean-app.test.ts` (PT-W15) keeps the repository clean of the old database pieces and of the preview switch: no file of the repository names the old back end, `src/` does not read the preview variable, and the build check lets only `NEXT_PUBLIC_API_URL` through.

## Writing an end-to-end test

See `tests/e2e/README.md`. Every spec starts with

```ts
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});
```

(`tests/e2e/clear-counters.ts`, `tests/e2e/pacing.ts`), so that the login throttle and the API's 300 calls a minute are not the test's own.

## Lint

`npm run lint` lints everything and still reports the Prettier findings that came with the prototype in files nobody has touched since. `npm run lint:changed` (a step of `verify`) lints the files changed since the merge base with `main`, and those must be clean.
