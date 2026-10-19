# End-to-end tests

Playwright tests go in this folder (`playwright.config.ts` points here). No browser is downloaded by `npm install`: run `npx playwright install chromium` once (about 170 MB, into your own cache).

They run in a real browser against a **lane**: a throw-away MariaDB 11.8 container, the API built from a checkout of `jewelvault-api`, and three users made through the API's admin door. The site is the Next.js dev server that Playwright starts itself.

```bash
# both are yours: your lane (main, a, b or c) and the checkout of jewelvault-api whose `main` the orchestrator keeps merged
export LANE=b
export JV_API_DIR=../jewelvault-api-wt/b

E2E=1 npx playwright test tests/e2e/harness.spec.ts   # one spec (PT-W0)
E2E=1 npm run test:e2e                                # all of them
E2E=1 npm run verify                                  # typecheck, changed-file lint, unit, build, build check, then these
```

Nothing starts without `E2E=1`: a lane starts Docker containers and servers on this computer, so it is asked for on purpose. `npm run verify` without it runs everything else and skips this step by name.

## What the global setup does

`tests/e2e/global-setup.ts` calls `laneUp` of `scripts/e2e-lane.mjs`, which

1. runs the API repository's own lane tool, `npm run db:lane -- up <lane>` (container `jv-mariadb-<lane>`, data in tmpfs, no Docker volume, the ten-box user of A3, migrations and seeds); a container that already exists is emptied first, so every run starts on a clean database;
2. compiles the API (`tsconfig.build.json`) into `node_modules/.cache/jv-e2e/<lane>/dist` of `JV_API_DIR` (git ignores it; two lanes never delete each other's build);
3. starts it on the lane's API port with `ALLOWED_ORIGINS` set to the site's origin, `JV_ADMIN_TOKEN_HASH` set to the hash of a token made for this run, and the lane database's password (read from Docker in memory, never printed or written);
4. runs `npm run admin -- add-user` three times (owner, biller, staff), signs each in with the temporary password and changes it, so the users are ordinary ones (no must-change gate);
5. writes their e-mail addresses and passwords and the admin token to `.lanes/<lane>/.env.local` (mode 0600, git-ignored), and puts them in `process.env` for the tests.

After the last test (or a failed one, or Ctrl-C) the teardown stops the API and removes the container with `docker rm -fv`. After a killed run, `npm run e2e:lane -- down` (with `LANE` and `JV_API_DIR`) cleans up; the next run also does it first. `npm run e2e:lane -- up | down | status | ports` does the same by hand, for example to `npm run admin` against a lane or to look at one.

## Ports

The site listens on `PORT`, else on the lane's port (main 4028, a 4128, b 4228, c 4328), else 4028. The API listens on the next port (4029, 4129, 4229, 4329). The site is started with `NEXT_PUBLIC_API_URL` set to the lane's API (the only build-time variable, H4). Playwright never reuses a server that is already on the port.

**One run per checkout at a time.** `next dev` keeps one server per project folder (`.next/dev/lock`), so a second `E2E=1 npx playwright test` in the same worktree stops with "Another next dev server is already running". Two lanes at the same time need two worktrees, which is how the agents work; the lane stacks themselves (container, API, users, ports) do not collide.

## Writing a test

```ts
import { e2eLane, e2eLogin } from './global-setup';

const owner = e2eLogin('owner'); // { email, password, fullName }; also 'biller' and 'staff'
const { apiUrl, webOrigin, adminToken } = e2eLane();
```

- A call from a page to the API needs `credentials: 'include'` and, on every POST, PUT or PATCH, the header `X-JV-Client: web`; the browser adds the `Origin` of the site, which the API allows. A call that takes no body must send none: an empty body with `Content-Type: application/json` is a 422.
- The session cookie `__Host-jv_session` is `Secure; HttpOnly; SameSite=Strict`. Chromium keeps it on `http://localhost` and sends it back, so a test needs no workaround; `harness.spec.ts` asserts it.
- A test that needs a user of its own (a must-change user, a deactivated one) makes it through the admin door with `adminToken`: `POST {apiUrl}/admin/v1/users` with `Authorization: Bearer <token>` and no `Origin` header, so from the test process and not from the page.
- Specs run one at a time (`workers: 1`) on one database: a spec that changes shared data puts it back or makes its own.

`harness.spec.ts` is PT-W0: the lane is up, a page of the site logs in as each role and reads `me`, the cookie is kept and sent, a logout ends the session, and a wrong password is refused. `login.spec.ts` is the real login screen (WEB02).

`no-preview.spec.ts` is PT-W15: it makes a production build with `NEXT_PUBLIC_PREVIEW_MODE=1` (a variable nothing reads any more), runs the build check on it, serves `out/` and opens it in Chromium: the login screen comes first, with no app, no sample data and no preview note. The API address is answered by the spec itself (nobody is signed in), because the lane's API allows only the dev server's origin. It rewrites `out/` and `.next/` of the checkout it runs in.
