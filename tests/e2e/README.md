# End-to-end tests

Playwright tests go in this folder (`playwright.config.ts` points here). No browser is downloaded by `npm install`: run `npx playwright install chromium` once (about 170 MB, into your own cache).

Run them through the lane, which starts the stack if it is not running and gives the tests its API URL, its keys and its database URL:

```bash
LANE=b npm run test:e2e                 # all of them (also a step of `npm run verify`)
LANE=b npm run test:e2e -- --grep T-E08 # a few
```

`global-setup.ts` makes the logins the tests sign in with: one per role (owner, biller, staff) and one that stays inactive. It uses the local Auth admin API and `private.activate_user` (`tests/db/rpc.ts`), with a random password that lives only in memory and reaches the tests through `process.env` of that run; nothing is written to a file and no password is in committed SQL. Its teardown deletes the logins again, profile first. In a test, `e2eLogin('owner')` gives the e-mail address and password; a test that needs a login of its own (for example one whose metadata it changes) makes it with `createLogin` and deletes it with `deleteLogin`.

`login.spec.ts` is T-E01 (the parts FE02 completes), T-E08 and the browser half of T-D06.
